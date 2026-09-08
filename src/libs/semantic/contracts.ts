import { z } from 'zod';

/**
 * Semantic search contracts for the spatial catalog.
 *
 * Guardrails (do not relax without revisiting the plan):
 * - Documents embed metadata about a geometry LAYER — never spatial features.
 * - Model output is 384-dim Float32, mean-pooled, L2-normalized; E5 requires
 *   the `query:` / `passage:` instruction prefixes (Xenova/multilingual-e5-small).
 * - Retrieval never ships raw vectors; only ranked metadata + cosine score.
 */

// ---------------------------------------------------------------------------
// Model / embedding contract (todo #4 implements the runtime against these)
// ---------------------------------------------------------------------------

export const SEMANTIC_MODEL_ID = 'Xenova/multilingual-e5-small' as const;
export const SEMANTIC_DIM = 384 as const;
export const SEMANTIC_POOLING = 'mean' as const;
export const SEMANTIC_NORMALIZE_L2 = true as const;
export const SEMANTIC_QUERY_PREFIX = 'query:' as const;
export const SEMANTIC_PASSAGE_PREFIX = 'passage:' as const;
export const SEMANTIC_DTYPE = 'float32' as const;

/** Hard lower bound for top_k — a search returning nothing is a bug, not a result. */
export const SEMANTIC_TOP_K_MIN = 1 as const;
/** Hard upper bound for top_k — unbounded ranking is a denial-of-service vector. */
export const SEMANTIC_TOP_K_MAX = 100 as const;

export interface EmbeddingContract {
    modelId: typeof SEMANTIC_MODEL_ID;
    dimension: typeof SEMANTIC_DIM;
    pooling: typeof SEMANTIC_POOLING;
    normalizeL2: typeof SEMANTIC_NORMALIZE_L2;
    dtype: typeof SEMANTIC_DTYPE;
    passagePrefix: typeof SEMANTIC_PASSAGE_PREFIX;
    queryPrefix: typeof SEMANTIC_QUERY_PREFIX;
}

export const EMBEDDING_CONTRACT: EmbeddingContract = {
    modelId: SEMANTIC_MODEL_ID,
    dimension: SEMANTIC_DIM,
    pooling: SEMANTIC_POOLING,
    normalizeL2: SEMANTIC_NORMALIZE_L2,
    dtype: SEMANTIC_DTYPE,
    passagePrefix: SEMANTIC_PASSAGE_PREFIX,
    queryPrefix: SEMANTIC_QUERY_PREFIX,
};

// ---------------------------------------------------------------------------
// Layer identity (branded so an arbitrary string can never be a catalog layer)
// ---------------------------------------------------------------------------

export interface CatalogLayer {
    readonly schema: string;
    readonly table: string;
    readonly geometry: string;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export const catalogLayerSchema = z
    .object({
        schema: z.string().regex(IDENT, 'schema must be a valid SQL identifier'),
        table: z.string().regex(IDENT, 'table must be a valid SQL identifier'),
        geometry: z.string().regex(IDENT, 'geometry column must be a valid SQL identifier'),
    })
    .readonly();

export type CatalogLayerInput = z.input<typeof catalogLayerSchema>;

/** Canonical document id. Space-free so it can be a Valkey key or MCP id verbatim. */
export type LayerId = string & { readonly __layerId: unique symbol };

export function makeLayerId(layer: CatalogLayerInput): LayerId {
    const parsed = catalogLayerSchema.parse(layer);
    return `${parsed.schema}.${parsed.table}.${parsed.geometry}` as LayerId;
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/** Immutable, versioned index namespace. Layout: sem:index:<version>:<schema>.<table>.<geometry>. */
export const INDEX_NAMESPACE_PREFIX = 'sem:index:' as const;

export function indexNamespace(version: number, layer: CatalogLayerInput): string {
    const layerId = makeLayerId(layer);
    return `${INDEX_NAMESPACE_PREFIX}${version}:${layerId}`;
}

export function parseIndexNamespace(namespace: string): {
    version: number;
    layerId: string;
} | null {
    const prefixLength = INDEX_NAMESPACE_PREFIX.length;
    if (!namespace.startsWith(INDEX_NAMESPACE_PREFIX)) return null;
    const versionSep = namespace.indexOf(':', prefixLength);
    if (versionSep === -1) return null;
    const version = Number(namespace.slice(prefixLength, versionSep));
    if (!Number.isSafeInteger(version) || version < 0) return null;
    return { version, layerId: namespace.slice(versionSep + 1) };
}

// ---------------------------------------------------------------------------
// Document + manifest
// ---------------------------------------------------------------------------

export const semanticDocumentSchema = z
    .object({
        id: z.string().min(1),
        layer: catalogLayerSchema,
        geometryType: z.string().min(1),
        srid: z.number().int().positive(),
        /** Bounded, deterministic text budget for the canonical `passage:` source. */
        textBudgetChars: z.number().int().positive(),
        fields: z.record(z.string(), z.string()).readonly(),
        tableDescription: z.string().optional(),
        geometryDescription: z.string().optional(),
    })
    .readonly();

export type SemanticDocument = z.infer<typeof semanticDocumentSchema>;

export const semanticManifestSchema = z
    .object({
        version: z.number().int().min(1),
        layerId: z.string().min(1),
        documentCount: z.number().int().min(0),
        /** Fingerprint of (canonical source text, embedding contract). Byte-identical for identical layers. */
        sourceFingerprint: z.string().min(1),
        /** ISO-8601 timestamp of when this immutable version was published. */
        publishedAt: z.string().datetime(),
        embeddingContract: z
            .object({
                modelId: z.literal(SEMANTIC_MODEL_ID),
                dimension: z.literal(SEMANTIC_DIM),
                pooling: z.literal(SEMANTIC_POOLING),
                normalizeL2: z.literal(true),
            })
            .readonly(),
    })
    .readonly();

export type SemanticManifest = z.infer<typeof semanticManifestSchema>;

export const semanticSearchResultSchema = z
    .object({
        layer: catalogLayerSchema,
        catalogId: z.string().min(1),
        geometryType: z.string().min(1),
        score: z.number().min(0).max(1),
        tableDescription: z.string().optional(),
        geometryDescription: z.string().optional(),
    })
    .readonly();

export type SemanticSearchResult = z.infer<typeof semanticSearchResultSchema>;

export const semanticSearchResponseSchema = z
    .object({
        query: z.string().min(1),
        results: z.array(semanticSearchResultSchema).readonly(),
    })
    .readonly();

export type SemanticSearchResponse = z.infer<typeof semanticSearchResponseSchema>;

// ---------------------------------------------------------------------------
// Error model (typed, serializable, MCP-safe)
// ---------------------------------------------------------------------------

export const SEMANTIC_ERROR_CODES = [
    'INDEX_UNAVAILABLE',
    'MODEL_UNAVAILABLE',
    'INVALID_ARGS',
    'INDEX_NOT_FOUND',
    'EMBEDDING_FAILED',
    'VERSION_MISMATCH',
    'INTERNAL',
] as const;

export type SemanticErrorCode = (typeof SEMANTIC_ERROR_CODES)[number];

export const semanticErrorSchema = z
    .object({
        code: z.enum(SEMANTIC_ERROR_CODES),
        message: z.string(),
    })
    .readonly();

export type SemanticError = z.infer<typeof semanticErrorSchema>;

export class SemanticSearchError extends Error {
    readonly code: SemanticErrorCode;
    readonly cause?: unknown;

    constructor(code: SemanticErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'SemanticSearchError';
        this.code = code;
        this.cause = cause;
    }
}
