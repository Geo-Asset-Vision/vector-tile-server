/**
 * Version-aware retrieval service over the published semantic catalog index.
 *
 * Search flow (typed errors throughout — failures are NEVER `[]`):
 *   1. assert local model artifacts are present        (MODEL_UNAVAILABLE)
 *   2. read the published manifest + vectors            (INDEX_NOT_FOUND / INDEX_UNAVAILABLE)
 *   3. compare the on-disk model-contract fingerprint against the manifest's
 *      stored `embeddingContract`                       (VERSION_MISMATCH — never search
 *                                                        with a stale/foreign model)
 *   4. validate filters / topK                          (INVALID_ARGS)
 *   5. result LRU hit → return; miss → embed query once (query LRU), rank every
 *      non-filtered layer's vector by exact cosine (dot of two unit-normalized
 *      vectors, tight loop, no strings), sort descending with deterministic
 *      alphabetical tie-break on layerId, attach metadata from the manifest.
 *
 * Every LRU key embeds the published version (`sem:doc:<v>:<id>`,
 * `sem:query:<v>:<sha256>`, `sem:result:<v>:<sha256>`), so a version bump makes
 * every stale entry miss naturally. Sizes come from config.
 */
import { createHash } from 'node:crypto';

import { semanticEnv } from './config.js';
import {
    SEMANTIC_TOP_K_MAX,
    SemanticSearchError,
    type SemanticSearchResponse,
    type SemanticSearchResult,
} from './contracts.js';
import { assertLocalModelReady, modelContractFingerprint } from './embedding.js';
import type { CatalogLayerDetail, CatalogManifest, IndexStorage } from './index-storage.js';
import { LruCache } from './lru.js';
import { semanticSearchMetrics } from './metrics.js';

// ---------------------------------------------------------------------------
// Cache keys (version-scoped: a bump misses every stale key)
// ---------------------------------------------------------------------------

const docKey = (version: number, layerId: string): string => `sem:doc:${version}:${layerId}`;
const queryKey = (version: number, query: string): string =>
    `sem:query:${version}:${createHash('sha256').update(query).digest('hex')}`;

export interface SemanticSearchOptions {
    topK?: number;
    /** Apply ONLY when provided (undefined = no filter). Exact on the schema segment. */
    schema?: string;
    /** Apply ONLY when provided. Case-insensitive match against the PostGIS geometry type. */
    geometryType?: string;
}

export interface RetrievalServiceOptions {
    storage: Pick<IndexStorage, 'readPublished'>;
    /** Test seam: override the on-disk model-contract fingerprint source. */
    contractFingerprint?: () => string;
    /** Test seam: skip the on-disk artifact gate. */
    assertArtifacts?: () => void;
    /** Allowlist gate: return false to hide a layer from every search result. */
    allowedLayers?: (schemaName: string, tableName: string) => boolean;
}

interface ScoredLayer {
    layerId: string;
    detail: CatalogLayerDetail;
    score: number;
}

/**
 * Split a `schema.table.geometry` layerId into its three segments.
 * Not a trust boundary: ids come from makeLayerId at index time.
 */
function splitLayerId(layerId: string): { schema: string; table: string; geometry: string } {
    const dot1 = layerId.indexOf('.');
    const dot2 = layerId.indexOf('.', dot1 + 1);
    if (dot1 === -1 || dot2 === -1) {
        throw new SemanticSearchError('INTERNAL', `malformed layerId in manifest: ${layerId}`);
    }
    return {
        schema: layerId.slice(0, dot1),
        table: layerId.slice(dot1 + 1, dot2),
        geometry: layerId.slice(dot2 + 1),
    };
}

/** Dot product of two L2-normalized vectors == exact cosine (tight loop). */
function cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i]! * b[i]!;
    }
    // Float rounding can push a dot of unit vectors a hair past ±1.
    return dot < 0 ? 0 : dot > 1 ? 1 : dot;
}

function resultSignature(
    query: string,
    topK: number,
    schema: string | undefined,
    geometryType: string | undefined,
): string {
    const joined = [query, String(topK), schema ?? '', geometryType ?? ''].join('\u0000');
    return createHash('sha256').update(joined).digest('hex');
}

export class RetrievalService {
    private readonly storage: Pick<IndexStorage, 'readPublished'>;
    private readonly contractFingerprint: () => string;
    private readonly assertArtifacts: () => void;
    private readonly allowedLayers: (schemaName: string, tableName: string) => boolean;
    private readonly docCache: LruCache<Float32Array>;
    private readonly queryCache: LruCache<Float32Array>;
    private readonly resultCache: LruCache<SemanticSearchResult[]>;

    constructor(options: RetrievalServiceOptions) {
        this.storage = options.storage;
        this.contractFingerprint = options.contractFingerprint ?? modelContractFingerprint;
        this.assertArtifacts = options.assertArtifacts ?? assertLocalModelReady;
        this.allowedLayers = options.allowedLayers ?? (() => true);
        this.docCache = new LruCache<Float32Array>(semanticEnv.SEMANTIC_DOCUMENT_CACHE_SIZE);
        this.queryCache = new LruCache<Float32Array>(semanticEnv.SEMANTIC_QUERY_CACHE_SIZE);
        this.resultCache = new LruCache<SemanticSearchResult[]>(semanticEnv.SEMANTIC_RESULT_CACHE_SIZE);
    }

    /**
     * Load the published index state for one version, verifying the local model
     * contract matches the one the index was embedded with.
     */
    async readIndex(): Promise<{
        version: number;
        manifest: CatalogManifest;
        documents: Map<string, Float32Array>;
    }> {
        this.assertArtifacts();
        const read = await this.storage.readPublished();
        if (read.status !== 'ok') {
            throw new SemanticSearchError(read.code, read.message);
        }
        const current = this.contractFingerprint();
        if (read.manifest.embeddingContract !== current) {
            throw new SemanticSearchError(
                'VERSION_MISMATCH',
                `stored index was embedded with contract ${read.manifest.embeddingContract || '<none>'} ` +
                    `but the local model fingerprint is ${current}; re-run \`pnpm semantic:refresh\`.`,
            );
        }
        if (!read.manifest.layerDetails) {
            throw new SemanticSearchError(
                'INDEX_UNAVAILABLE',
                'published manifest predates layer metadata; re-run `pnpm semantic:refresh` to upgrade it',
            );
        }
        return read;
    }

    async search(queryText: string, opts: SemanticSearchOptions = {}): Promise<SemanticSearchResponse> {
        const startedAt = Date.now();
        try {
            const query = queryText.trim();
            if (query.length === 0) {
                throw new SemanticSearchError('INVALID_ARGS', 'search query must not be blank');
            }
            const topK = this.resolveTopK(opts.topK);

            const index = await this.readIndex();
            const { version, manifest } = index;
            const details = manifest.layerDetails ?? {};

            // Result LRU — key embeds version + signature(query, topK, filters).
            const signature = resultSignature(query, topK, opts.schema, opts.geometryType);
            const resultCacheKey = `sem:result:${version}:${signature}`;
            const cachedResults = this.resultCache.get(resultCacheKey);
            if (cachedResults !== undefined) {
                semanticSearchMetrics.recordResultCacheHit();
                return { query, results: cachedResults };
            }
            semanticSearchMetrics.recordResultCacheMiss();

            // Query embedding LRU.
            const queryHashKey = queryKey(version, query);
            let queryVector = this.queryCache.get(queryHashKey);
            if (queryVector !== undefined) {
                semanticSearchMetrics.recordQueryCacheHit();
            } else {
                semanticSearchMetrics.recordQueryCacheMiss();
                queryVector = await this.embedQuery(query);
                this.queryCache.set(queryHashKey, queryVector);
            }

            // Rank every layer that survives the filters.
            const scored: ScoredLayer[] = [];
            for (const layerId of manifest.layers) {
                const detail = details[layerId];
                if (!detail) {
                    throw new SemanticSearchError(
                        'INDEX_UNAVAILABLE',
                        `published manifest lacks metadata for layer ${layerId}; re-run \`pnpm semantic:refresh\``,
                    );
                }
                const { schema, table } = splitLayerId(layerId);
                // Frozen-per-process allowlist: hidden layers never rank.
                if (!this.allowedLayers(schema, table)) continue;
                if (opts.schema !== undefined && schema !== opts.schema) continue;
                if (
                    opts.geometryType !== undefined &&
                    detail.geometryType.toLowerCase() !== opts.geometryType.trim().toLowerCase()
                ) {
                    continue;
                }

                // Document LRU — per-version layer vector.
                const documentCacheKey = docKey(version, layerId);
                let vector = this.docCache.get(documentCacheKey);
                if (vector !== undefined) {
                    semanticSearchMetrics.recordDocumentCacheHit();
                } else {
                    semanticSearchMetrics.recordDocumentCacheMiss();
                    vector = index.documents.get(layerId);
                    if (!vector) {
                        throw new SemanticSearchError(
                            'INDEX_UNAVAILABLE',
                            `published index is missing the vector for layer ${layerId}`,
                        );
                    }
                    this.docCache.set(documentCacheKey, vector);
                }

                scored.push({
                    layerId,
                    detail,
                    score: cosine(queryVector, vector),
                });
            }

            scored.sort((a, b) => {
                if (a.score !== b.score) return b.score - a.score;
                return a.layerId < b.layerId ? -1 : 1;
            });

            const results = scored.slice(0, topK).map((s) => this.toResult(s));
            this.resultCache.set(resultCacheKey, results);
            return { query, results };
        } catch (err) {
            semanticSearchMetrics.recordError(err instanceof SemanticSearchError ? err.code : 'INTERNAL');
            throw err;
        } finally {
            semanticSearchMetrics.recordSearch(Date.now() - startedAt);
        }
    }

    private async embedQuery(query: string): Promise<Float32Array> {
        const { getEmbeddingRuntime } = await import('./embedding.js');
        return getEmbeddingRuntime().embedQuery(query);
    }

    private resolveTopK(requested: number | undefined): number {
        if (requested === undefined) return semanticEnv.SEMANTIC_TOP_K_DEFAULT;
        if (!Number.isSafeInteger(requested) || requested < 1) {
            throw new SemanticSearchError(
                'INVALID_ARGS',
                `topK must be a positive integer, got ${String(requested)}`,
            );
        }
        // Cap at the config max when the caller asks for more.
        const cap = Math.min(semanticEnv.SEMANTIC_TOP_K_MAX, SEMANTIC_TOP_K_MAX);
        return Math.min(requested, cap);
    }

    private toResult(scored: ScoredLayer): SemanticSearchResult {
        const { schema, table, geometry } = splitLayerId(scored.layerId);
        return {
            layer: { schema, table, geometry } as const,
            catalogId: `${schema}.${table}`,
            geometryType: scored.detail.geometryType,
            score: scored.score,
            ...(scored.detail.tableDescription !== undefined
                ? { tableDescription: scored.detail.tableDescription }
                : {}),
            ...(scored.detail.geometryDescription !== undefined
                ? { geometryDescription: scored.detail.geometryDescription }
                : {}),
        };
    }
}
