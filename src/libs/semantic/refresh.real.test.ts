import { describe, expect, it } from 'vitest';

import env from '@/libs/env';
import { findAllGeomObject, findTableGeomLayers } from '@/repositories/catalog.repo';

import { getEmbeddingRuntime, modelContractFingerprint } from './embedding.js';
import { IndexStorage } from './index-storage.js';
import { refreshSemanticIndex } from './refresh.js';
import { RetrievalService } from './retrieval.js';
import { ValkeyClient } from '../cache/valkey-client.js';

/**
 * Real end-to-end refresh + retrieval proof — runs against the live PostGIS +
 * Valkey containers AND the real local model. Gated like embedding.real.test.ts
 * because it intentionally does NOT mock the transformers module or the repo:
 *
 *     pnpm semantic:prefetch            # once per checkout
 *     SEMANTIC_RUN_REAL=1 pnpm vitest run src/libs/semantic/refresh.real.test.ts
 *
 * Idempotent: refreshSemanticIndex publishes a new version only when the
 * catalog changed, and search reads whichever version is current.
 */
describe.skipIf(process.env.SEMANTIC_RUN_REAL !== '1')('real refresh + retrieval', () => {
    it('refreshes the real PostGIS catalog then ranks schema-qualified layers for an Indonesian query', async () => {
        const rt = getEmbeddingRuntime();
        rt.reset();
        const contract = modelContractFingerprint();

        const valkey = new ValkeyClient({
            host: env.VALKEY_HOST || 'localhost',
            port: env.VALKEY_PORT || 6379,
            password: env.VALKEY_PASSWORD || undefined,
            connectTimeoutMs: 1000,
            commandTimeoutMs: 500,
        });
        expect(await valkey.connect()).toBe(true);
        const storage = new IndexStorage(valkey);

        // 1. Refresh exactly like `pnpm semantic:refresh`.
        const summary = await refreshSemanticIndex(
            {
                async discover() {
                    const rows = await findAllGeomObject({ schemaName: env.POSTGIS_SCHEMA });
                    return rows
                        .filter((r) => Array.isArray(r.geometry_columns) && r.geometry_columns.length > 0)
                        .map((r) => ({ schemaName: r.schema_name, tableName: r.name }));
                },
                layers: (schemaName, tableName) => findTableGeomLayers({ schemaName, tableName }),
                readPublished: () => storage.readPublished(),
                writeNew: (version, docs, opts) => storage.writeVersion(version, docs, opts),
                embedBatch: (texts) => rt.embedPassages(texts),
            },
            { embeddingContract: contract },
        );
        expect(summary.layersCount).toBeGreaterThan(0);
        expect(summary.reused + summary.embedded).toBe(summary.layersCount);

        // 2. Search 'jalan banjir' — must hit the real embeddings.
        const service = new RetrievalService({
            storage,
            contractFingerprint: () => contract,
            assertArtifacts: () => undefined, // presence gate is the CLI's job
        });
        const res = await service.search('jalan banjir');
        expect(res.query).toBe('jalan banjir');
        expect(res.results.length).toBeGreaterThan(0);

        // Scores descend.
        for (let i = 1; i < res.results.length; i++) {
            expect(res.results[i]!.score).toBeLessThanOrEqual(res.results[i - 1]!.score);
        }
        // Schema-qualified, tool-consumable metadata — never raw vectors.
        const first = res.results[0]!;
        expect(first.catalogId).toMatch(/^[a-z_]+\.[a-z_]+$/);
        expect(first.layer.schema).toBeDefined();
        expect(first.layer.table).toBeDefined();
        expect(first.geometryType).toBeDefined();
        expect(first.score).toBeGreaterThanOrEqual(0);
        expect(first.score).toBeLessThanOrEqual(1);

        // Filters narrow results when provided.
        const schemaFiltered = await service.search('jalan', { schema: first.layer.schema });
        for (const r of schemaFiltered.results) expect(r.layer.schema).toBe(first.layer.schema);

        await valkey.disconnect();
    });
});
