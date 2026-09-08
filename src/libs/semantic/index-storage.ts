import { SEMANTIC_DIM, makeLayerId } from './contracts.js';
import { INDEX_NAMESPACE_PREFIX } from './contracts.js';

/**
 * Versioned Valkey index storage with atomic publication.
 *
 * Model: ONE stable (non-versioned) catalog manifest key, e.g. `sem:manifest`,
 * holding JSON `{ version, layers: [...] }`. Document vectors live under
 * immutable namespaces `sem:index:<version>:<schema>.<table>.<geometry>`
 * (task-1 layout). Readers resolve version + layer list from the manifest,
 * then MGET exactly those keys — so a reader observes EITHER the old published
 * version OR the new one, never a mix, and retrieval NEVER uses SCAN/KEYS.
 *
 * Atomic-ish publication sequence (publish semantics, not a multi-key
 * transaction):
 *   1. write every new-namespace doc key (`SET`, no expiry),
 *   2. only if ALL writes succeeded: overwrite the manifest,
 *   3. purge the previous namespace via the OLD manifest's layer list (stored
 *      before the overwrite) — DEL each old `sem:index:<oldVersion>:<layerId>`.
 *
 * The manifest is deliberately NOT the task-1 per-layer `SemanticManifest`
 * shape: task-1's schema is per-layer (one layerId per document); the plan's
 * storage needs a single catalog-scope record mapping one version → many
 * layers. The task-1 schema remains authoritative for per-layer payloads.
 */

// ---------------------------------------------------------------------------
// Typed outcomes — never masquerade an unavailable store as an empty result.
// ---------------------------------------------------------------------------

export type IndexWriteResult =
    | { status: 'ok'; version: number; documents: number; previousVersion: number | null; purgedKeys: number }
    | { status: 'unavailable'; code: 'INDEX_UNAVAILABLE'; message: string }
    | { status: 'invalid'; code: 'INVALID_ARGS' | 'VERSION_MISMATCH'; message: string };

export type IndexReadResult =
    | { status: 'ok'; version: number; manifest: CatalogManifest; documents: Map<string, Float32Array> }
    | { status: 'not-found'; code: 'INDEX_NOT_FOUND'; message: string }
    | { status: 'unavailable'; code: 'INDEX_UNAVAILABLE'; message: string };

// ---------------------------------------------------------------------------
// Client seam
// ---------------------------------------------------------------------------

export interface ValkeyLike {
    readonly isConfiguredAndEnabled: boolean;
    readonly isClientConnected: boolean;
    getCircuitState(): 'HEALTHY' | 'DEGRADED' | 'PROBING';
    getBuffer(key: string): Promise<Buffer | null>;
    mgetBuffer(keys: string[]): Promise<(Buffer | null)[] | null>;
    setBuffer(key: string, value: Buffer, ttlMs?: number): Promise<boolean>;
    del(key: string): Promise<boolean>;
    delMany(keys: string[]): Promise<number>;
}

// ---------------------------------------------------------------------------
// Manifest record + key
// ---------------------------------------------------------------------------

export const SEMANTIC_MANIFEST_KEY = 'sem:manifest' as const;

/** Per-layer metadata persisted with a published version so a later refresh can
 * skip unchanged layers by fingerprint and retrieval can return typed results. */
export interface CatalogLayerDetail {
    /** SHA-256 over the canonical passage + EMBEDDING_CONTRACT (see document.ts). */
    fingerprint: string;
    /** PostGIS geometry type, e.g. `Polygon`, `MultiLineStringZ`. */
    geometryType: string;
    tableDescription?: string;
    geometryDescription?: string;
}

export interface CatalogManifest {
    version: number;
    /** layerIds in the same order they were written; MGET order matches. */
    layers: string[];
    documentCount: number;
    publishedAt: string;
    embeddingContract: string;
    sourceFingerprint?: string;
    /** layerId -> { fingerprint, geometryType, descriptions } (optional for
     * backwards compatibility; todo-5 refresh always writes it). */
    layerDetails?: Record<string, CatalogLayerDetail>;
}

function encodeManifest(m: CatalogManifest): Buffer {
    return Buffer.from(JSON.stringify(m), 'utf8');
}

function decodeManifest(buf: Buffer | null): CatalogManifest | null {
    if (!buf) return null;
    try {
        const parsed = JSON.parse(buf.toString('utf8')) as CatalogManifest;
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            !Number.isSafeInteger(parsed.version) ||
            parsed.version < 1 ||
            !Array.isArray(parsed.layers) ||
            !parsed.layers.every((l) => typeof l === 'string' && l.length > 0) ||
            !Number.isSafeInteger(parsed.documentCount) ||
            parsed.documentCount < 0 ||
            typeof parsed.publishedAt !== 'string'
        ) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function unavail(message: string): { status: 'unavailable'; code: 'INDEX_UNAVAILABLE'; message: string } {
    return { status: 'unavailable', code: 'INDEX_UNAVAILABLE', message };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Split a `schema.table.geometry` layerId back into its parts. */
function layerIdToParts(layerId: string): { schema: string; table: string; geometry: string } {
    const parts = layerId.split('.');
    if (parts.length !== 3) throw new Error('layer id must be schema.table.geometry');
    const [schema, table, geometry] = parts;
    return { schema: schema!, table: table!, geometry: geometry! };
}

export class IndexStorage {
    private readonly client: ValkeyLike;

    constructor(client: ValkeyLike) {
        this.client = client;
    }

    private get healthy(): boolean {
        return (
            this.client.isConfiguredAndEnabled &&
            this.client.isClientConnected &&
            this.client.getCircuitState() !== 'DEGRADED'
        );
    }

    /**
     * Publish a new immutable version and purge the namespace it supersedes.
     */
    async writeVersion(
        version: number,
        docs: Map<string, Float32Array>,
        opts: {
            sourceFingerprint?: string;
            embeddingContract?: string;
            layerDetails?: Record<string, CatalogLayerDetail>;
        } = {},
    ): Promise<IndexWriteResult> {
        if (!Number.isSafeInteger(version) || version < 1) {
            return { status: 'invalid', code: 'INVALID_ARGS', message: `version must be a positive integer, got ${String(version)}` };
        }
        if (docs.size === 0) {
            return { status: 'invalid', code: 'INVALID_ARGS', message: 'cannot publish an index with zero documents' };
        }

        // Fail fast on bad layers / bad vectors BEFORE touching the store.
        for (const [layerId, vector] of docs) {
            try {
                makeLayerId(layerIdToParts(layerId));
            } catch {
                return { status: 'invalid', code: 'INVALID_ARGS', message: `malformed layer id: ${layerId}` };
            }
            if (vector.length !== SEMANTIC_DIM) {
                return {
                    status: 'invalid',
                    code: 'INVALID_ARGS',
                    message: `layer ${layerId} vector has ${String(vector.length)} dims, expected ${String(SEMANTIC_DIM)}`,
                };
            }
        }

        if (!this.healthy) {
            return unavail('index store unavailable (unconfigured, disconnected, or circuit DEGRADED)');
        }

        // Current manifest (may be absent for a first publish).
        const currentBuf = await this.client.getBuffer(SEMANTIC_MANIFEST_KEY);
        const current = decodeManifest(currentBuf);
        if (current && current.version >= version) {
            return {
                status: 'invalid',
                code: 'VERSION_MISMATCH',
                message: `cannot publish version ${String(version)}: published version ${String(current.version)} is already current`,
            };
        }

        // 1. Write the complete new namespace. No-expiry keys (index lives
        //    until explicitly purged).
        const keys: string[] = [];
        const layerIds: string[] = [];
        const key = (layerId: string): string => `${INDEX_NAMESPACE_PREFIX}${version}:${layerId}`;
        for (const [layerId, vector] of docs) {
            const fullKey = key(layerId);
            keys.push(fullKey);
            layerIds.push(layerId);
            const ok = await this.client.setBuffer(
                fullKey,
                Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
            );
            if (!ok) {
                return unavail(`failed writing ${layerIds.length} of ${String(docs.size)} namespace keys (SET rejected)`);
            }
        }

        // 2. Publish the manifest ONLY after every namespace write succeeded.
        const manifest: CatalogManifest = {
            version,
            layers: layerIds,
            documentCount: layerIds.length,
            publishedAt: new Date().toISOString(),
            embeddingContract: opts.embeddingContract ?? '',
            ...(opts.sourceFingerprint ? { sourceFingerprint: opts.sourceFingerprint } : {}),
            ...(opts.layerDetails ? { layerDetails: opts.layerDetails } : {}),
        };
        const ok = await this.client.setBuffer(SEMANTIC_MANIFEST_KEY, encodeManifest(manifest));
        if (!ok) {
            return unavail('manifest publish (SET) rejected');
        }

        // 3. Purge the superseded namespace using the OLD manifest's layer list.
        let purgedKeys = 0;
        if (current) {
            purgedKeys = await this.client.delMany(
                current.layers.map((layerId) => `${INDEX_NAMESPACE_PREFIX}${current.version}:${layerId}`),
            );
        }

        return {
            status: 'ok',
            version,
            documents: layerIds.length,
            previousVersion: current ? current.version : null,
            purgedKeys,
        };
    }

    /**
     * Resolve the published manifest, MGET exactly its keys, decode each Buffer
     * safely into a Float32Array. A corrupt (non-4-byte-aligned or wrong-length)
     * payload yields a typed unavailable outcome — never a silent truncation
     * and never an empty match pretending to be a valid result.
     */
    async readPublished(): Promise<IndexReadResult> {
        if (!this.healthy) {
            return unavail('index store unavailable (unconfigured, disconnected, or circuit DEGRADED)');
        }

        const manifestBuf = await this.client.getBuffer(SEMANTIC_MANIFEST_KEY);
        const manifest = decodeManifest(manifestBuf);
        if (manifest === null) {
            if (manifestBuf === null) {
                return { status: 'not-found', code: 'INDEX_NOT_FOUND', message: 'no index manifest has been published yet' };
            }
            return unavail('index manifest is corrupt or unreadable');
        }

        const keys = manifest.layers.map((layerId) => `${INDEX_NAMESPACE_PREFIX}${manifest.version}:${layerId}`);
        const bufs = await this.client.mgetBuffer(keys);
        if (bufs === null) {
            return unavail('batch document retrieval failed (MGET rejected or timed out)');
        }

        const documents = new Map<string, Float32Array>();
        for (let i = 0; i < manifest.layers.length; i++) {
            const layerId = manifest.layers[i];
            const buf = bufs[i];
            if (buf === null || buf === undefined) {
                return unavail(`published document missing for ${layerId} (manifest lists it but key is absent)`);
            }
            const vector = decodeVector(buf);
            if (vector === null) {
                return unavail(`stored vector for ${layerId} is corrupt: expected ${String(SEMANTIC_DIM * 4)} bytes (${String(SEMANTIC_DIM)} x float32), got ${String(buf.length)} bytes`);
            }
            documents.set(layerId, vector);
        }

        return {
            status: 'ok',
            version: manifest.version,
            manifest,
            documents,
        };
    }
}

// ---------------------------------------------------------------------------
// Buffer decode — rejects anything not exactly (N x float32).
// ---------------------------------------------------------------------------

function decodeVector(buf: Buffer): Float32Array | null {
    if (buf.length % 4 !== 0 || buf.length === 0) return null;
    if (buf.length / 4 !== SEMANTIC_DIM) return null;
    // Float32Array requires its start offset to be 4-byte-aligned. ioredis
    // MGET buffers come from its reply pool and a returned slice can start at
    // an unaligned byteOffset, so copy into a fresh aligned Buffer first. The
    // copy also detaches from the pool, making the view safe to hand out.
    const aligned = Buffer.allocUnsafe(buf.length);
    buf.copy(aligned);
    return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.length / 4);
}
