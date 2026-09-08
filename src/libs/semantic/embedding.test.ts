import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { semanticEnv } from './config.js';
import { SEMANTIC_DIM, SemanticSearchError } from './contracts.js';
import { EMBEDDING_CONTRACT } from './document.js';

// ---------------------------------------------------------------------------
// Mock the transformers seam: unit tests never touch the real
// @huggingface/transformers. `pipeline` records every init call; `env` is a
// mutable record the runtime configures before loading files.
// ---------------------------------------------------------------------------

const envMock = {
    allowLocalModels: false,
    allowRemoteModels: true,
    localModelPath: '',
    useFSCache: true,
};
const pipelineMock = vi.fn();
vi.mock('@huggingface/transformers', () => ({
    env: envMock,
    pipeline: pipelineMock,
}));

// Import AFTER the mock is registered.
const { getEmbeddingRuntime, modelContractFingerprint } = await import('./embedding.js');

const MODEL_ID = 'Xenova/multilingual-e5-small';
const ARTIFACT_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'];

let modelRoot: string;

/** Fake extractor returning a deterministic unit vector [1, 384]. */
function fakeExtractor(text: string) {
    let seed = 0;
    for (let i = 0; i < text.length; i += 1) {
        seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
    }
    const data = new Float32Array(SEMANTIC_DIM);
    let state = seed || 1;
    let sum = 0;
    for (let i = 0; i < SEMANTIC_DIM; i += 1) {
        state = (state * 1664525 + 1013904223) >>> 0;
        data[i] = (state % 2000) / 1000 - 1; // [-1, 1)
        sum += data[i] * data[i];
    }
    const norm = Math.sqrt(sum);
    for (let i = 0; i < SEMANTIC_DIM; i += 1) data[i] /= norm;
    return { dims: [1, SEMANTIC_DIM], data };
}

function installPipelineMock() {
    const extractor = vi.fn(async (text: string) => fakeExtractor(text));
    pipelineMock.mockResolvedValue(extractor);
    return extractor;
}

/** Batch-capable extractor: string[] input returns [N, 384] tensor rows. */
function installBatchPipelineMock() {
    const extractor = vi.fn(
        async (texts: string | string[]) =>
            Array.isArray(texts)
                ? {
                      dims: [texts.length, SEMANTIC_DIM] as number[],
                      data: (() => {
                          const out = new Float32Array(texts.length * SEMANTIC_DIM);
                          for (let i = 0; i < texts.length; i += 1) {
                              const single = fakeExtractor(texts[i] as string);
                              out.set(single.data, i * SEMANTIC_DIM);
                          }
                          return out;
                      })(),
                  }
                : fakeExtractor(texts),
    );
    pipelineMock.mockResolvedValue(extractor);
    return extractor;
}

/** Create a fake model dir with all artifacts present; point the runtime at it. */
function pointAtModelDir(root: string): string {
    const full = path.join(root, MODEL_ID);
    mkdirSync(path.join(full, 'onnx'), { recursive: true });
    for (const rel of ARTIFACT_FILES) {
        writeFileSync(path.join(full, rel), '{}');
    }
    writeFileSync(path.join(full, 'onnx', 'model.onnx'), 'fake');
    semanticEnv.SEMANTIC_MODEL_DIR = full;
    return full;
}

afterAll(() => {
    if (modelRoot) rmSync(modelRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
});

beforeEach(() => {
    modelRoot = mkdtempSync(path.join(tmpdir(), 'semantic-model-'));
    pipelineMock.mockReset();
    // Reset the singleton runtime between tests.
    getEmbeddingRuntime().reset();
});

describe('embedding runtime — mocked seam', () => {
    it('initializes the pipeline exactly ONCE across concurrent embed calls', async () => {
        pointAtModelDir(modelRoot);
        installPipelineMock();

        const rt = getEmbeddingRuntime();
        const [a, b, c] = await Promise.all([
            rt.embedQuery('jalan banjir'),
            rt.embedPassage('layer: public.roads.geom'),
            rt.embedQuery('sekolah'),
        ]);

        expect(pipelineMock).toHaveBeenCalledTimes(1);
        expect(pipelineMock).toHaveBeenCalledWith('feature-extraction', MODEL_ID, {
            dtype: 'fp32',
        });
        expect(a).toHaveLength(SEMANTIC_DIM);
        expect(b).toHaveLength(SEMANTIC_DIM);
        expect(c).toHaveLength(SEMANTIC_DIM);
        expect(rt.isLoaded()).toBe(true);
    });

    it('returns unit-normalized 384-dim Float32 vectors', async () => {
        pointAtModelDir(modelRoot);
        installPipelineMock();

        const v = await getEmbeddingRuntime().embedQuery('jalan banjir');
        expect(v).toHaveLength(384);
        expect(v).toBeInstanceOf(Float32Array);
        let sum = 0;
        for (let i = 0; i < v.length; i += 1) sum += v[i] * v[i];
        expect(Math.sqrt(sum)).toBeCloseTo(1, 6);
    });

    it('applies the query:/passage: prefixes before embedding (passage idempotent)', async () => {
        pointAtModelDir(modelRoot);
        const extractor = installPipelineMock();

        await getEmbeddingRuntime().embedQuery('jalan banjir');
        expect(extractor).toHaveBeenCalledWith('query: jalan banjir', {
            pooling: 'mean',
            normalize: true,
        });

        extractor.mockClear();
        await getEmbeddingRuntime().embedPassage('layer: public.roads.geom');
        expect(extractor).toHaveBeenCalledWith('passage: layer: public.roads.geom', {
            pooling: 'mean',
            normalize: true,
        });

        // A canonical document already carrying the prefix is NOT doubled.
        extractor.mockClear();
        await getEmbeddingRuntime().embedPassage('passage: layer: public.roads.geom');
        expect(extractor).toHaveBeenCalledWith('passage: layer: public.roads.geom', {
            pooling: 'mean',
            normalize: true,
        });
    });

    it('configures the transformers env to local-only with remote downloads disabled', async () => {
        const full = pointAtModelDir(modelRoot);
        installPipelineMock();

        await getEmbeddingRuntime().embedQuery('jalan');
        expect(envMock.allowLocalModels).toBe(true);
        expect(envMock.allowRemoteModels).toBe(false);
        // env.localModelPath strips the model id tail: models/Xenova/e5 -> models/
        expect(envMock.localModelPath).toBe(path.dirname(path.dirname(full)));
        expect(envMock.useFSCache).toBe(false);
    });

    it('embedPassages batches a whole refresh delta in ONE pipeline call', async () => {
        pointAtModelDir(modelRoot);
        const extractor = installBatchPipelineMock();

        const rt = getEmbeddingRuntime();
        const texts = ['layer: a.roads.geom', 'passage: layer: b.parcels.geom', 'layer: c.rivers.geom'];
        const out = await rt.embedPassages(texts);

        expect(pipelineMock).toHaveBeenCalledTimes(1); // model loaded once
        expect(out).toHaveLength(3);
        for (const v of out) {
            expect(v).toHaveLength(SEMANTIC_DIM);
            expect(v).toBeInstanceOf(Float32Array);
        }
        // ONE extractor call with the whole batch; the already-prefixed passage
        // was not double-prefixed.
        expect(extractor).toHaveBeenCalledTimes(1);
        const call = extractor.mock.calls[0] as unknown as [string | string[], unknown];
        expect(Array.isArray(call[0])).toBe(true);
        const batch = call[0] as string[];
        expect(batch).toHaveLength(3);
        expect(batch[0]).toBe('passage: layer: a.roads.geom');
        expect(batch[1]).toBe('passage: layer: b.parcels.geom'); // no double prefix
        expect(batch[2]).toBe('passage: layer: c.rivers.geom');
    });

    it('embedPassages records ONE embedding-computed metric per output vector', async () => {
        pointAtModelDir(modelRoot);
        installBatchPipelineMock();

        const { semanticSearchMetrics } = await import('./metrics.js');
        semanticSearchMetrics.reset();

        const rt = getEmbeddingRuntime();
        const texts = ['layer: a.geom', 'layer: b.geom', 'layer: c.geom', 'layer: d.geom'];
        const out = await rt.embedPassages(texts);

        expect(out).toHaveLength(4);
        // A batch of N passages computed N embeddings — not 1.
        expect(semanticSearchMetrics.getSnapshot().embeddingsComputed).toBe(4);

        // Single-text path still records exactly once.
        semanticSearchMetrics.reset();
        await rt.embedPassage('layer: e.geom');
        expect(semanticSearchMetrics.getSnapshot().embeddingsComputed).toBe(1);
    });
});

describe('embedding runtime — absent artifact', () => {
    it('throws typed MODEL_UNAVAILABLE when an artifact is missing and never calls the network', async () => {
        const full = pointAtModelDir(modelRoot);
        // Remove the weight file so the presence gate trips.
        rmSync(path.join(full, 'onnx', 'model.onnx'));
        installPipelineMock();

        await expect(getEmbeddingRuntime().embedQuery('jalan')).rejects.toMatchObject({
            name: 'SemanticSearchError',
            code: 'MODEL_UNAVAILABLE',
        });

        // No network, no pipeline construction.
        expect(pipelineMock).not.toHaveBeenCalled();
        expect(envMock.allowRemoteModels).toBe(false);
    });

    it('reports the first missing artifact in the error message', async () => {
        const full = pointAtModelDir(modelRoot);
        rmSync(path.join(full, 'config.json'));
        installPipelineMock();

        const err = await getEmbeddingRuntime()
            .embedQuery('jalan')
            .then(
                () => null,
                (e: unknown) => e,
            );
        expect(err).toBeInstanceOf(SemanticSearchError);
        expect((err as SemanticSearchError).code).toBe('MODEL_UNAVAILABLE');
        expect((err as SemanticSearchError).message).toContain('config.json');
        expect((err as SemanticSearchError).message).toContain('semantic:prefetch');
    });
});

describe('embedding runtime — contract fingerprint', () => {
    it('fingerprints the resolved artifact manifest deterministically', () => {
        const full = pointAtModelDir(modelRoot);
        const f1 = modelContractFingerprint(full);
        const f2 = modelContractFingerprint(full);
        expect(f1).toMatch(/^[0-9a-f]{64}$/);
        expect(f1).toBe(f2);
    });

    it('changes when an artifact is removed (version-mismatch tripwire)', () => {
        const full = pointAtModelDir(modelRoot);
        const before = modelContractFingerprint(full);
        rmSync(path.join(full, 'onnx', 'model.onnx'));
        const after = modelContractFingerprint(full);
        expect(after).not.toBe(before);
        expect(EMBEDDING_CONTRACT).toBe(
            'Xenova/multilingual-e5-small|dim=384|pool=mean|normalize=l2',
        );
    });
});
