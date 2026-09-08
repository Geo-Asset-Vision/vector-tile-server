import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { env, pipeline } from '@huggingface/transformers';
import type { FeatureExtractionPipeline, Tensor } from '@huggingface/transformers';

import { semanticEnv } from './config.js';
import {
    EMBEDDING_CONTRACT,
    SEMANTIC_DIM,
    SEMANTIC_MODEL_ID,
    SEMANTIC_PASSAGE_PREFIX,
    SEMANTIC_QUERY_PREFIX,
    SemanticSearchError,
} from './contracts.js';
import { semanticSearchMetrics } from './metrics.js';

/**
 * Singleton local embedding runtime for `Xenova/multilingual-e5-small`.
 *
 * Loading — `@huggingface/transformers` (v4) appends the model id to
 * `env.localModelPath`, so that path must be the dir CONTAINING the Xenova/
 * tree (e.g. SEMANTIC_MODEL_DIR=models/Xenova/multilingual-e5-small ->
 * env.localModelPath=models/). Required offline artifacts (provisioned by
 * `pnpm semantic:prefetch`, NEVER at runtime): config.json, tokenizer.json,
 * tokenizer_config.json, onnx/model.onnx (fp32). Remote loading is disabled;
 * production fails with a typed MODEL_UNAVAILABLE when an artifact is absent.
 *
 * Guarantees: lazy singleton init (no pipeline per request, no worker
 * threads); bounded in-flight inference (SEMANTIC_MAX_CONCURRENT_EMBEDDINGS);
 * mean-pooled + L2-normalized 384-dim output (pipeline does it, we verify);
 * `query:` prefix on queries, `passage:` on passages.
 */


const REQUIRED_ARTIFACTS = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model.onnx',
] as const;

// ---------------------------------------------------------------------------
// Singleton state (module-level so every import shares ONE model)
// ---------------------------------------------------------------------------

let runtime: EmbeddingRuntime | null = null;
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

const resolvedModelDir = (): string => path.resolve(semanticEnv.SEMANTIC_MODEL_DIR);

function resolvedLocalModelPath(): string {
    const dir = resolvedModelDir();
    const idTail = SEMANTIC_MODEL_ID.split('/');
    const tailLen = idTail.length;
    const parts = dir.split(path.sep);
    if (
        parts.length >= tailLen &&
        parts.slice(-tailLen).join('/') === SEMANTIC_MODEL_ID
    ) {
        return parts.slice(0, -tailLen).join(path.sep) || path.sep;
    }
    // Custom layout not matching the id's two-segment tail: give transformers
    // the model dir itself and rely on a local (non-id) resolution.
    return dir;
}

// ---------------------------------------------------------------------------
// Contract fingerprint (todo #5 compares this against the stored manifest)
// ---------------------------------------------------------------------------

/** SHA-256 over on-disk artifact manifest + embedding contract (works when artifacts are missing). */
export function modelContractFingerprint(modelDir: string = resolvedModelDir()): string {
    const dir = path.resolve(modelDir);
    const files = REQUIRED_ARTIFACTS.map((rel) => {
        const p = path.join(dir, rel);
        let present = false;
        let sizeBytes = 0;
        try {
            const st = statSync(p);
            present = st.isFile();
            sizeBytes = present ? st.size : 0;
        } catch {
            present = false;
        }
        return { rel, present, sizeBytes };
    });
    const modelId = path.basename(dir);
    return createHash('sha256')
        .update(JSON.stringify({ files, modelId, contract: EMBEDDING_CONTRACT }))
        .digest('hex');
}

// ---------------------------------------------------------------------------
// Local-only load + typed failure
// ---------------------------------------------------------------------------

/** Check required artifacts on disk. Throws MODEL_UNAVAILABLE naming the gap. */
function assertArtifactsPresent(): void {
    const dir = resolvedModelDir();
    const missing = REQUIRED_ARTIFACTS.filter((rel) => !existsSync(path.join(dir, rel)));
    if (missing.length > 0) {
        throw new SemanticSearchError(
            'MODEL_UNAVAILABLE',
            `Local model artifact missing under ${dir} (missing: ${missing.join(', ')}). ` +
                `Run \`pnpm semantic:prefetch\` on the host, or bake the model into the ` +
                `image; the runtime never downloads models.`,
        );
    }
}


function unavailable(err: unknown): SemanticSearchError {
    if (err instanceof SemanticSearchError) return err;
    return new SemanticSearchError(
        'MODEL_UNAVAILABLE',
        `Local model could not be loaded from ${resolvedModelDir()} ` +
            `(remote downloads are disabled). Run \`pnpm semantic:prefetch\` to provision.`,
        err,
    );
}

async function createExtractor(): Promise<FeatureExtractionPipeline> {
    try {
        assertArtifactsPresent();
        env.allowLocalModels = true;
        env.allowRemoteModels = false;
        env.localModelPath = resolvedLocalModelPath();
        env.useFSCache = false;

        return await pipeline('feature-extraction', SEMANTIC_MODEL_ID, {
            dtype: 'fp32',
        });
    } catch (err) {
        throw unavailable(err);
    }
}


function lazyExtractor(): Promise<FeatureExtractionPipeline> {
    if (!extractorPromise) {
        extractorPromise = createExtractor().catch((err: unknown) => {
            // Allow a retry after provisioning (never on success).
            extractorPromise = null;
            throw err;
        });
    }
    return extractorPromise;
}

// ---------------------------------------------------------------------------
// Bounded FIFO queue — at most `concurrency` pipeline calls in flight
// ---------------------------------------------------------------------------

interface QueueEntry<T> {
    task: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
}

class BoundedQueue<T> {
    private readonly entries: QueueEntry<T>[] = [];
    private active = 0;

    constructor(private readonly concurrency: number) {}

    run(task: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.entries.push({ task, resolve, reject });
            this.pump();
        });
    }

    private pump(): void {
        while (this.active < this.concurrency && this.entries.length > 0) {
            const entry = this.entries.shift() as QueueEntry<T>;
            this.active += 1;
            entry
                .task()
                .then(entry.resolve, entry.reject)
                .finally(() => {
                    this.active -= 1;
                    this.pump();
                });
        }
    }
}

const inferenceQueue = new BoundedQueue<Float32Array>(
    semanticEnv.SEMANTIC_MAX_CONCURRENT_EMBEDDINGS,
);

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------


function toContractVector(tensor: Tensor, label: string): Float32Array {
    const dims = tensor.dims;
    if (dims.length !== 2 || dims[0] !== 1 || dims[1] !== SEMANTIC_DIM) {
        throw new SemanticSearchError(
            'EMBEDDING_FAILED',
            `Expected model output [1, ${SEMANTIC_DIM}], got [${dims.join(', ')}] for "${label}". ` +
                `Artifact may be corrupted; re-run \`pnpm semantic:prefetch\`.`,
        );
    }
    const vector = new Float32Array(SEMANTIC_DIM);
    vector.set(tensor.data as Float32Array);

    let sumSquares = 0;
    for (let i = 0; i < vector.length; i += 1) {
        sumSquares += vector[i] * vector[i];
    }
    const norm = Math.sqrt(sumSquares);
    if (norm < 1e-3 || Math.abs(norm - 1) > 1e-2) {
        throw new SemanticSearchError(
            'EMBEDDING_FAILED',
            `Embedding for "${label}" has L2 norm ${norm.toFixed(4)} (expected ~1). ` +
                `Artifact/contract mismatch; re-run \`pnpm semantic:prefetch\`.`,
        );
    }
    return vector;
}

async function embedText(rawText: string, label: string): Promise<Float32Array> {
    if (rawText.trim().length === 0) {
        throw new SemanticSearchError('INVALID_ARGS', 'Cannot embed an empty string.');
    }
    const extractor = await lazyExtractor();
    return inferenceQueue.run(async () => {
        try {
            const tensor = await extractor(rawText, {
                pooling: 'mean',
                normalize: true,
            });
            semanticSearchMetrics.recordEmbeddingComputed();
            return toContractVector(tensor, label);
        } catch (err) {
            if (err instanceof SemanticSearchError) throw err;
            throw new SemanticSearchError(
                'EMBEDDING_FAILED',
                `Feature extraction failed for "${label}".`,
                err,
            );
        }
    });
}

// ---------------------------------------------------------------------------
// Public runtime
// ---------------------------------------------------------------------------

export interface EmbeddingRuntime {
    /** Embed a search query. The `query: ` prefix is applied here. */
    embedQuery(text: string): Promise<Float32Array>;
    /**
     * Embed a passage/index document. The `passage: ` prefix is applied only if
     * absent (canonical documents already carry it).
     */
    embedPassage(text: string): Promise<Float32Array>;
    /** True once the singleton model has loaded (test/ops seam). */
    isLoaded(): boolean;
    /** Load the model eagerly; subsequent calls are no-ops. */
    ensureLoaded(): Promise<void>;
    /** Reset the singleton (test seam only — never in production code). */
    reset(): void;
    /** Fingerprint of the resolved local artifact set + embedding contract. */
    contractFingerprint(): string;
}

class SingletonEmbeddingRuntime implements EmbeddingRuntime {
    async embedQuery(text: string): Promise<Float32Array> {
        return embedText(`${SEMANTIC_QUERY_PREFIX} ${text}`, text);
    }

    async embedPassage(text: string): Promise<Float32Array> {
        const prefixed = text.startsWith(`${SEMANTIC_PASSAGE_PREFIX} `)
            ? text
            : `${SEMANTIC_PASSAGE_PREFIX} ${text}`;
        return embedText(prefixed, text);
    }

    isLoaded(): boolean {
        return extractorPromise !== null;
    }

    async ensureLoaded(): Promise<void> {
        await lazyExtractor();
    }

    reset(): void {
        extractorPromise = null;
        runtime = null;
    }

    contractFingerprint(): string {
        return modelContractFingerprint();
    }
}

/** Module singleton — the only way production code obtains a runtime. */
export function getEmbeddingRuntime(): EmbeddingRuntime {
    runtime ??= new SingletonEmbeddingRuntime();
    return runtime;
}
