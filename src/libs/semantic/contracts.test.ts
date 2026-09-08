import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseSemanticEnv } from './config.js';
import {
    EMBEDDING_CONTRACT,
    SEMANTIC_MODEL_ID,
    indexNamespace,
    makeLayerId,
    semanticManifestSchema,
} from './contracts.js';
import { SemanticSearchMetrics, semanticSearchMetrics } from './metrics.js';

describe('semantic env contract', () => {
    it('parses when all SEMANTIC_* variables are valid', () => {
        const env = parseSemanticEnv({
            SEMANTIC_MODEL_DIR: '/models/multilingual-e5-small',
            SEMANTIC_DIM: '384',
            SEMANTIC_MAX_CONCURRENT_EMBEDDINGS: '2',
            SEMANTIC_TOP_K_DEFAULT: '10',
            SEMANTIC_TOP_K_MAX: '100',
            SEMANTIC_DOCUMENT_CACHE_SIZE: '4096',
            SEMANTIC_QUERY_CACHE_SIZE: '1024',
            SEMANTIC_RESULT_CACHE_SIZE: '512',
        });

        expect(env.SEMANTIC_MODEL_ID).toBe(SEMANTIC_MODEL_ID);
        expect(env.SEMANTIC_DIM).toBe(384);
        expect(env.SEMANTIC_MAX_CONCURRENT_EMBEDDINGS).toBe(2);
        expect(env.SEMANTIC_TOP_K_DEFAULT).toBe(10);
        expect(env.SEMANTIC_TOP_K_MAX).toBe(100);
    });

    it('rejects dimension that is not 384', () => {
        expect(() => parseSemanticEnv({ SEMANTIC_DIM: '512' })).toThrow(z.ZodError);
    });

    it('rejects top_k default out of bounds', () => {
        expect(() => parseSemanticEnv({ SEMANTIC_TOP_K_DEFAULT: '1000' })).toThrow(z.ZodError);
        expect(() => parseSemanticEnv({ SEMANTIC_TOP_K_DEFAULT: '0' })).toThrow(z.ZodError);
    });

    it('rejects concurrency bound out of range', () => {
        expect(() =>
            parseSemanticEnv({ SEMANTIC_MAX_CONCURRENT_EMBEDDINGS: '0' }),
        ).toThrow(z.ZodError);
        expect(() =>
            parseSemanticEnv({ SEMANTIC_MAX_CONCURRENT_EMBEDDINGS: '99' }),
        ).toThrow(z.ZodError);
    });

    it('rejects top_k max lower than default', () => {
        expect(() =>
            parseSemanticEnv({ SEMANTIC_TOP_K_DEFAULT: '20', SEMANTIC_TOP_K_MAX: '10' }),
        ).toThrow(z.ZodError);
    });
});

describe('embedding contract', () => {
    it('pins the model id and 384 dimension', () => {
        expect(EMBEDDING_CONTRACT).toEqual({
            modelId: 'Xenova/multilingual-e5-small',
            dimension: 384,
            pooling: 'mean',
            normalizeL2: true,
            dtype: 'float32',
            passagePrefix: 'passage:',
            queryPrefix: 'query:',
        });
    });

    it('rejects a manifest for a non-384 model', () => {
        expect(() =>
            semanticManifestSchema.parse({
                version: 1,
                layerId: 'public.roads.geom',
                documentCount: 1,
                sourceFingerprint: 'abc123',
                publishedAt: new Date().toISOString(),
                embeddingContract: {
                    modelId: 'other/model',
                    dimension: 384,
                    pooling: 'mean',
                    normalizeL2: true,
                },
            }),
        ).toThrow(z.ZodError);
    });
});

describe('layer id', () => {
    it('forbids cross-schema ID collision', () => {
        const layerA = makeLayerId({ schema: 'public', table: 'roads', geometry: 'geom' });
        const layerB = makeLayerId({ schema: 'gis', table: 'roads', geometry: 'geom' });

        expect(layerA).not.toBe(layerB);
        expect(layerA).toContain('public');
        expect(layerB).toContain('gis');
        expect(layerA).toBe('public.roads.geom');
        expect(layerB).toBe('gis.roads.geom');
    });

    it('rejects non-SQL identifiers', () => {
        expect(() =>
            makeLayerId({ schema: 'public; drop', table: 'roads', geometry: 'geom' }),
        ).toThrow(z.ZodError);
    });
});

describe('index namespace', () => {
    it('matches the sem:index:<version>:<schema>.<table>.<geometry> layout', () => {
        const ns = indexNamespace(7, { schema: 'public', table: 'roads', geometry: 'geom' });
        expect(ns).toBe('sem:index:7:public.roads.geom');
    });
});

describe('semantic search metrics', () => {
    it('emits only semantic_search_* prefixed lines and counters per error code', () => {
        const metrics = new SemanticSearchMetrics();
        metrics.recordSearch(12.5);
        metrics.recordSearch(3.2);
        metrics.recordDocumentCacheHit();
        metrics.recordDocumentCacheMiss();
        metrics.recordError('INDEX_UNAVAILABLE');
        metrics.recordError('MODEL_UNAVAILABLE');

        const out = metrics.toPrometheus();
        const lines = out.split('\n').filter((line) => line.trim().length > 0 && !line.startsWith('#'));
        const names = lines.map((line) => line.split('{')[0]!.split(' ')[0]!);

        expect(names.every((name) => name.startsWith('semantic_search_'))).toBe(true);
        expect(names).not.toContain('mvt_cache_l1_hits_total');

        expect(out).toContain('semantic_search_errors_total{code="INDEX_UNAVAILABLE"} 1');
        expect(out).toContain('semantic_search_errors_total{code="MODEL_UNAVAILABLE"} 1');
        expect(out).toContain('semantic_search_errors_total{code="INVALID_ARGS"} 0');
    });

    it('singleton shares state with class instances', () => {
        semanticSearchMetrics.reset();
        semanticSearchMetrics.recordSearch(1);
        expect(semanticSearchMetrics.getSnapshot().searchRequests).toBe(1);
        semanticSearchMetrics.reset();
    });
});
