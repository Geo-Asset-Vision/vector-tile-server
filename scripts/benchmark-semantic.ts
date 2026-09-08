#!/usr/bin/env node
/**
 * Semantic catalog-search benchmark (exact-cosine linear scan).
 *
 *     pnpm semantic:benchmark
 *
 * Measures, against the LIVE published index (PostGIS + Valkey + local model
 * artifacts up and provisioned):
 *   1. index size  — bytes of `sem:manifest` + every `sem:index:<v>:*` key
 *                    (keys resolved from the manifest, MGET; no SCAN/KEYS) + layer count
 *   2. refresh     — duration of a no-op rerun (ms); a byte-identical catalog
 *                    must publish nothing (0 embeddings, 0 removed)
 *   3. embedding   — query-embedding latency p50/p95 over EMBED_N sequential
 *                    single-query runs on the real model (concurrency 1)
 *   4. search      — end-to-end RetrievalService.search p50/p95 over SEARCH_N
 *                    runs across the fixed query set (warm result/query LRUs)
 *   5. RSS         — peak resident set (MB) of this node process sampled
 *                    after the search loop (process.memoryUsage().rss)
 *
 * DETERMINISM: fixed query set + fixed iteration counts + concurrency 1.
 * The ranking is an EXACT COSINE over unit-normalized 384-dim vectors — a
 * linear scan over the indexed layers, NOT an approximate / HNSW index.
 * Results are not comparable to ANN benchmarks and degrade linearly with the
 * number of indexed layers.
 *
 * Outputs: human summary on stdout + machine-readable JSON written to
 * `benchmark-results-semantic.json` at the repo root (stable path, documented
 * in README). Exit code is non-zero if the index cannot be read or a required
 * measurement fails — never a silent success.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// env.js loads dotenv at import time and MUST be the first env-adjacent import
// (see refresh-semantic-index.ts for the ordering rationale).
import env from '../src/libs/env.js';
import { findAllGeomObject, findTableGeomLayers } from '../src/repositories/catalog.repo.js';
import { SemanticSearchError } from '../src/libs/semantic/contracts.js';
import { semanticEnv } from '../src/libs/semantic/config.js';
import { getEmbeddingRuntime, modelContractFingerprint } from '../src/libs/semantic/embedding.js';
import { IndexStorage } from '../src/libs/semantic/index-storage.js';
import { refreshSemanticIndex } from '../src/libs/semantic/refresh.js';
import { RetrievalService } from '../src/libs/semantic/retrieval.js';
import { ValkeyClient } from '../src/libs/cache/valkey-client.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(repoRoot, 'benchmark-results-semantic.json');

/** Fixed, bilingual query set — the same set every run. */
const QUERIES = [
    'jalan banjir',
    'tanah sertifikat',
    'cari lahan kosong',
    'utility network',
    'pondasi bangunan',
] as const;

const EMBED_N = 20; // embedding-latency samples (one inference each)
const SEARCH_N = 50; // end-to-end search samples across the fixed query set

const valkey = new ValkeyClient({
    host: env.VALKEY_HOST || 'localhost',
    port: env.VALKEY_PORT || 6379,
    password: env.VALKEY_PASSWORD || undefined,
    connectTimeoutMs: env.VALKEY_CONNECT_TIMEOUT_MS ?? 1000,
    commandTimeoutMs: env.VALKEY_COMMAND_TIMEOUT_MS ?? 500,
});
let connectedToValkey = false;

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[index]!;
}

const p50 = (sorted: number[]): number => percentile(sorted, 50);
const p95 = (sorted: number[]): number => percentile(sorted, 95);

async function main(): Promise<void> {
    connectedToValkey = await valkey.connect();
    if (!connectedToValkey) {
        throw new SemanticSearchError(
            'INDEX_UNAVAILABLE',
            `cannot connect to Valkey at ${env.VALKEY_HOST ?? 'localhost'}:${env.VALKEY_PORT ?? 6379}; ` +
                'start `docker compose up valkey -d`',
        );
    }
    const storage = new IndexStorage(valkey);
    const embedding = getEmbeddingRuntime();
    const contract = modelContractFingerprint();

    const startedAt = Date.now();

    // 1. Index size: read the published manifest once, MGET its layer keys.
    const read = await storage.readPublished();
    if (read.status !== 'ok') {
        throw new SemanticSearchError(read.code, read.message);
    }
    const { version, manifest } = read;
    const manifestBytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');
    const docKeys = manifest.layers.map((layerId) => `sem:index:${version}:${layerId}`);
    const docBufs = await valkey.mgetBuffer(docKeys);
    if (docBufs === null) {
        throw new SemanticSearchError('INDEX_UNAVAILABLE', 'MGET of index namespace keys failed');
    }
    const indexBytes = docBufs.reduce(
        (sum, buf) => sum + (buf === null || buf === undefined ? 0 : buf.length),
        0,
    );

    // 2. Refresh duration: a byte-identical no-op rerun publishes nothing.
    const refreshStart = Date.now();
    const refreshSummary = await refreshSemanticIndex(
        {
            async discover() {
                const rows = await findAllGeomObject({ schemaName: env.POSTGIS_SCHEMA });
                return rows
                    .filter((r) => Array.isArray(r.geometry_columns) && r.geometry_columns.length > 0)
                    .map((r) => ({ schemaName: r.schema_name, tableName: r.name }));
            },
            layers: (schemaName, tableName) => findTableGeomLayers({ schemaName, tableName }),
            readPublished: () => storage.readPublished(),
            writeNew: (v, docs, opts) => storage.writeVersion(v, docs, opts),
            embedBatch: (texts) => embedding.embedPassages(texts),
        },
        { embeddingContract: contract },
    );
    const refreshDurationMs = Date.now() - refreshStart;
    if (refreshSummary.published) {
        throw new Error(
            `no-op refresh unexpectedly published version ${refreshSummary.version}; ` +
                'a byte-identical catalog must not churn versions',
        );
    }

    // 3. Embedding latency: warm the model once (cold load excluded from the
    //    sample), then EMBED_N sequential single-query inferences.
    await embedding.ensureLoaded();
    const embedDurations: number[] = [];
    for (let i = 0; i < EMBED_N; i += 1) {
        const t0 = performance.now();
        await embedding.embedQuery(QUERIES[i % QUERIES.length]!);
        embedDurations.push(performance.now() - t0);
    }
    const embedSorted = [...embedDurations].sort((a, b) => a - b);

    // 4. Search p50/p95: SEARCH_N sequential end-to-end searches. Result and
    //    query LRUs warm after the first query per distinct query string, so
    //    these reflect the warm steady-state path (a typical served call).
    const service = new RetrievalService({
        storage,
        contractFingerprint: () => contract,
    });
    const searchDurations: number[] = [];
    for (let i = 0; i < SEARCH_N; i += 1) {
        const t0 = performance.now();
        await service.search(QUERIES[i % QUERIES.length]!);
        searchDurations.push(performance.now() - t0);
    }
    const searchSorted = [...searchDurations].sort((a, b) => a - b);

    // 5. RSS: peak process resident set, sampled AFTER warmup + search loop.
    const rssBytes = process.memoryUsage().rss;

    const elapsedMs = Date.now() - startedAt;
    const result = {
        benchmark: 'semantic-spatial-catalog-search',
        method: 'exact-cosine-linear-scan', // NOT approximate / HNSW
        note: 'Exact cosine over unit-normalized 384-dim vectors; linear in the number of indexed layers. Do not compare to ANN/HNSW benchmarks.',
        createdAt: new Date().toISOString(),
        env: {
            modelDir: semanticEnv.SEMANTIC_MODEL_DIR,
            maxConcurrentEmbeddings: semanticEnv.SEMANTIC_MAX_CONCURRENT_EMBEDDINGS,
            modelContractFingerprint: contract,
        },
        index: {
            version,
            layerCount: manifest.layers.length,
            manifestBytes,
            indexBytes,
            totalBytes: manifestBytes + indexBytes,
        },
        refresh: {
            noOpDurationMs: refreshDurationMs,
            published: refreshSummary.published,
            layers: refreshSummary.layersCount,
            embedded: refreshSummary.embedded,
            reused: refreshSummary.reused,
            removed: refreshSummary.removed,
        },
        embedding: {
            samples: EMBED_N,
            queries: [...QUERIES],
            p50Ms: Number(p50(embedSorted).toFixed(2)),
            p95Ms: Number(p95(embedSorted).toFixed(2)),
        },
        search: {
            samples: SEARCH_N,
            queries: [...QUERIES],
            p50Ms: Number(p50(searchSorted).toFixed(2)),
            p95Ms: Number(p95(searchSorted).toFixed(2)),
            note: 'warm result/query LRUs (steady-state path)',
        },
        rss: {
            peakMbAfterWarmup: Number((rssBytes / 1024 / 1024).toFixed(1)),
        },
        totalDurationMs: elapsedMs,
    };

    writeFileSync(OUT_FILE, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(2)} MiB`;
    console.log('Semantic catalog-search benchmark');
    console.log('---------------------------------');
    console.log(`method  : ${result.method} — ${result.note}`);
    console.log(`index   : v${result.index.version}, ${result.index.layerCount} layer(s)`);
    console.log(`          manifest ${result.index.manifestBytes} B + vectors ${result.index.indexBytes} B = ${mb(result.index.totalBytes)}`);
    console.log(`refresh : no-op rerun ${result.refresh.noOpDurationMs} ms (published=${result.refresh.published}, embedded=${result.refresh.embedded}, reused=${result.refresh.reused}, removed=${result.refresh.removed})`);
    console.log(`embed   : p50=${result.embedding.p50Ms} ms, p95=${result.embedding.p95Ms} ms over ${result.embedding.samples} single-query runs`);
    console.log(`search  : p50=${result.search.p50Ms} ms, p95=${result.search.p95Ms} ms over ${result.search.samples} warm runs`);
    console.log(`rss     : ${result.rss.peakMbAfterWarmup} MB peak after warmup`);
    console.log(`queries : ${result.embedding.queries.join(' | ')}`);
    console.log(`written : ${OUT_FILE}`);
}

main()
    .catch((err: unknown) => {
        if (err instanceof SemanticSearchError) {
            console.error(`\nbenchmark FAILED [${err.code}]: ${err.message}`);
        } else {
            console.error('\nbenchmark FAILED:', err instanceof Error ? err.message : err);
        }
        process.exitCode = 1;
    })
    .finally(async () => {
        if (connectedToValkey) {
            try {
                await valkey.disconnect();
            } catch {
                // best-effort detach
            }
        }
    })
    .then(() => {
        process.exit(process.exitCode ?? 0);
    });
