import { describe, expect, it } from 'vitest';

import env from '@/libs/env';

import { getEmbeddingRuntime, modelContractFingerprint } from './embedding.js';import { IndexStorage } from './index-storage.js';
import { RetrievalService } from './retrieval.js';
import { ValkeyClient } from '../cache/valkey-client.js';

/**
 * Real end-to-end proof for the refresh+retrieval path — requires the running
 * PostGIS + Valkey containers and the prefetched local model:
 *
 *     docker compose up db valkey -d
 *     pnpm semantic:prefetch
 *     pnpm semantic:refresh          # against the real PostGIS catalog
 *     SEMANTIC_RUN_REAL=1 pnpm vitest run src/libs/semantic/retrieval.real.test.ts
 *
 * No mocks: real PostGIS traversal lives in the CLI; here we read whatever the
 * last `pnpm semantic:refresh` published and assert retrieval works against it.
 */
describe.skipIf(process.env.SEMANTIC_RUN_REAL !== '1')('real retrieval', () => {
    it('searches the real published index and ranks schema-qualified layers', async () => {
        const valkey = new ValkeyClient({
            host: env.VALKEY_HOST || 'localhost',
            port: env.VALKEY_PORT || 6379,
            password: env.VALKEY_PASSWORD || undefined,
            connectTimeoutMs: 1000,
            commandTimeoutMs: 500,
        });
        const connected = await valkey.connect();
        expect(connected).toBe(true);
        const storage = new IndexStorage(valkey);

        const rt = getEmbeddingRuntime();
        rt.reset();
        const contract = modelContractFingerprint();
        const service = new RetrievalService({
            storage,
            contractFingerprint: () => contract,
            assertArtifacts: () => undefined, // artifacts pre-checked by the refresh
        });

        const res = await service.search('jalan banjir');
        expect(res.query).toBe('jalan banjir');
        expect(res.results.length).toBeGreaterThan(0);

        // Ranks are descending.
        for (let i = 1; i < res.results.length; i++) {
            expect(res.results[i]!.score).toBeLessThanOrEqual(res.results[i - 1]!.score);
        }
        // Results are schema-qualified layer references, never raw vectors.
        const first = res.results[0]!;
        expect(first.layer.schema).toBeDefined();
        expect(first.layer.table).toBeDefined();
        expect(first.layer.geometry).toBeDefined();
        expect(first.catalogId).toMatch(/^[a-z_]+\.[a-z_]+$/);
        expect(first.score).toBeGreaterThanOrEqual(0);
        expect(first.score).toBeLessThanOrEqual(1);

        // Schema filter only narrows to that schema.
        const schema = first.layer.schema;
        const filtered = await service.search('jalan', { schema });
        for (const r of filtered.results) expect(r.layer.schema).toBe(schema);

        // A geometry-type filter only returns matching types (case-insensitive).
        const typeFiltered = await service.search('jalan', { geometryType: first.geometryType.toLowerCase() });
        for (const r of typeFiltered.results) {
            expect(r.geometryType.toLowerCase()).toBe(first.geometryType.toLowerCase());
        }

        await valkey.disconnect();
    });
});
