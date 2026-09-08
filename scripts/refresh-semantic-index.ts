#!/usr/bin/env node
/**
 * Catalog-index refresh CLI.
 *
 * Traverses every geometry object in PostGIS (`findAllGeomObject` →
 * `findTableGeomLayers`), builds canonical documents, re-embeds only what
 * changed (one batched pipeline call), and publishes an immutable index version
 * via IndexStorage. Unchanged layers are reused by fingerprint; removed layers
 * disappear with the superseded namespace purge.
 *
 *     pnpm semantic:refresh
 *
 * Exit code is non-zero on ANY typed error (missing index / degraded store /
 * absent model artifacts / embedding failure), never a silent success.
 */
import env from '../src/libs/env.js';

// NOTE: env.js loads dotenv at import time (override: true). It MUST be the
// first semantic/config-adjacent import so POSTGIS/VALKEY vars reach process.env
// before eager config singletons (semanticEnv in config.js) parse.
import { findAllGeomObject, findTableGeomLayers } from '../src/repositories/catalog.repo.js';
import { SemanticSearchError } from '../src/libs/semantic/contracts.js';
import { getEmbeddingRuntime, modelContractFingerprint } from '../src/libs/semantic/embedding.js';
import { isCatalogAllowed } from '../src/libs/map-config.js';
import { IndexStorage } from '../src/libs/semantic/index-storage.js';
import { refreshSemanticIndex } from '../src/libs/semantic/refresh.js';
import { semanticSearchMetrics } from '../src/libs/semantic/metrics.js';
import { ValkeyClient } from '../src/libs/cache/valkey-client.js';

/** Valkey index store (circuit-protected, host-dev localhost defaults). */
const valkey = new ValkeyClient({
    host: env.VALKEY_HOST || 'localhost',
    port: env.VALKEY_PORT || 6379,
    password: env.VALKEY_PASSWORD || undefined,
    connectTimeoutMs: env.VALKEY_CONNECT_TIMEOUT_MS ?? 1000,
    commandTimeoutMs: env.VALKEY_COMMAND_TIMEOUT_MS ?? 500,
});
let connectedToValkey = false;

async function main(): Promise<void> {
    console.log('Semantic catalog index refresh');
    console.log('-------------------------------');

    connectedToValkey = await valkey.connect();
    if (!connectedToValkey) {
        throw new SemanticSearchError(
            'INDEX_UNAVAILABLE',
            `cannot connect to Valkey at ${env.VALKEY_HOST ?? 'localhost'}:${env.VALKEY_PORT ?? 6379}; ` +
                'start `docker compose up valkey -d`',
        );
    }
    const storage = new IndexStorage(valkey);

    // Model gate: batch embedding requires the real artifacts on disk.
    const embedding = getEmbeddingRuntime();
    const contract = modelContractFingerprint();
    console.log(`model contract fingerprint: ${contract.slice(0, 16)}...`);

    const summary = await refreshSemanticIndex(
        {
            async discover() {
                // Mirror discoverCatalog() so the index covers exactly the
                // catalogs the tile server serves (schema-scoped by POSTGIS_SCHEMA).
                const rows = await findAllGeomObject({ schemaName: env.POSTGIS_SCHEMA });
                // Only geometry columns the tile server would serve, then drop
                // catalogs outside the ALLOWED_SCHEMAS/ALLOWED_CATALOGS allowlist.
                return rows
                    .filter((r) => Array.isArray(r.geometry_columns) && r.geometry_columns.length > 0)
                    .filter((r) => isCatalogAllowed(r.schema_name, r.name))
                    .map((r) => ({ schemaName: r.schema_name, tableName: r.name }));
            },
            layers: (schemaName, tableName) => findTableGeomLayers({ schemaName, tableName }),
            readPublished: () => storage.readPublished(),
            writeNew: (version, docs, opts) => storage.writeVersion(version, docs, opts),
            embedBatch: (texts) => embedding.embedPassages(texts),
        },
        { embeddingContract: contract },
    );

    console.log(
        summary.published
            ? `published version ${summary.version} ` +
                  `(${summary.layersCount} layers; embedded ${summary.embedded}, reused ${summary.reused}, removed ${summary.removed})`
            : `catalog unchanged — version ${summary.version} still current ` +
                  `(${summary.layersCount} layers, all reused)`,
    );
    console.log(`duration: ${summary.durationMs} ms`);

    if (!summary.published && summary.layersCount === 0) {
        console.warn('no spatial layers discovered — the index is empty');
    }
}

main()
    .then(async () => {
        const s = semanticSearchMetrics.getSnapshot();
        console.log(`\nembeddings computed this run: ${s.embeddingsComputed}`);
    })
    .catch((err: unknown) => {
        if (err instanceof SemanticSearchError) {
            console.error(`\nrefresh FAILED [${err.code}]: ${err.message}`);
        } else {
            console.error('\nrefresh FAILED:', err instanceof Error ? err.message : err);
        }
        process.exitCode = 1;
    })
    .finally(async () => {
        // Detach the Valkey client so the process exits; an open socket or the
        // ioredis reconnect timers keep the event loop alive otherwise.
        if (connectedToValkey) {
            try {
                await valkey.disconnect();
            } catch {
                // best-effort detach
            }
        }
    })
    .then(() => {
        // Flush pending microtasks/socket teardown, then exit with our code.
        process.exit(process.exitCode ?? 0);
    });
