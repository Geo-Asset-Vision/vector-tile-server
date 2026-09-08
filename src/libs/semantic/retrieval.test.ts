import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SEMANTIC_DIM } from './contracts.js';
import type { CatalogManifest, ValkeyLike } from './index-storage.js';
import { IndexStorage } from './index-storage.js';
import { RetrievalService } from './retrieval.js';
import { semanticSearchMetrics } from './metrics.js';

// ---------------------------------------------------------------------------
// In-memory Valkey fake (same failure semantics as index-storage.test.ts).
// ---------------------------------------------------------------------------
class FakeValkey implements ValkeyLike {
    readonly store = new Map<string, Buffer>();
    degraded = false;
    configured = true;
    connected = true;

    get isConfiguredAndEnabled(): boolean {
        return this.configured;
    }
    get isClientConnected(): boolean {
        return this.connected;
    }
    getCircuitState(): 'HEALTHY' | 'DEGRADED' | 'PROBING' {
        if (!this.configured || this.degraded) return 'DEGRADED';
        return 'HEALTHY';
    }
    async getBuffer(key: string): Promise<Buffer | null> {
        if (!this.configured || this.degraded || !this.connected) return null;
        const buf = this.store.get(key);
        return buf ? Buffer.from(buf) : null;
    }
    async mgetBuffer(keys: string[]): Promise<(Buffer | null)[] | null> {
        if (!this.configured || this.degraded || !this.connected) return null;
        return keys.map((k) => {
            const buf = this.store.get(k);
            return buf ? Buffer.from(buf) : null;
        });
    }
    async setBuffer(key: string, value: Buffer, _ttlMs?: number): Promise<boolean> {
        if (!this.configured || this.degraded || !this.connected) return false;
        this.store.set(key, Buffer.from(value));
        return true;
    }
    async del(key: string): Promise<boolean> {
        if (!this.configured || this.degraded || !this.connected) return false;
        return this.store.delete(key);
    }
    async delMany(keys: string[]): Promise<number> {
        if (!this.configured || this.degraded || !this.connected) return 0;
        let removed = 0;
        for (const key of keys) if (this.store.delete(key)) removed += 1;
        return removed;
    }
}

/**
 * Unit vector over an axis class (i % 3). Two vectors share a class iff their
 * axis classes match -> dot == 1; different classes -> dot == 0. Deterministic
 * and exact under Float32, so ranking and tie-breaks are predictable.
 */
function unitVector(axisClass: number): Float32Array {
    const v = new Float32Array(SEMANTIC_DIM);
    for (let i = 0; i < SEMANTIC_DIM; i++) v[i] = i % 3 === axisClass ? 1 : 0;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    for (let i = 0; i < SEMANTIC_DIM; i++) v[i] /= norm;
    return v;
}

const CONTRACT = 'contract-fp-123';

interface TestLayer {
    schema: string;
    table: string;
    geometry: string;
    geometryType: string;
    tableDescription?: string;
    geometryDescription?: string;
    axis: number;
    fingerprint: string;
}

const LAYERS: TestLayer[] = [
    {
        schema: 'public',
        table: 'persil_bidang',
        geometry: 'geom',
        geometryType: 'Polygon',
        tableDescription: 'Sertifikat tanah (land parcels)',
        axis: 0,
        fingerprint: 'fp-persil',
    },
    {
        schema: 'public',
        table: 'site_plan',
        geometry: 'geom',
        geometryType: 'MultiLineStringZ',
        tableDescription: 'Rencana tapak (site plan)',
        geometryDescription: 'Jalan (roads) within the site',
        axis: 1,
        fingerprint: 'fp-site',
    },
    {
        schema: 'gis',
        table: 'banjir',
        geometry: 'geom',
        geometryType: 'Polygon',
        tableDescription: 'Daerah banjir (flood zones)',
        axis: 2,
        fingerprint: 'fp-banjir',
    },
];

function layerIdOf(l: TestLayer): string {
    return `${l.schema}.${l.table}.${l.geometry}`;
}

async function publish(
    storage: IndexStorage,
    version: number,
    layers: TestLayer[],
    contract = CONTRACT,
) {
    const docs = new Map<string, Float32Array>();
    const layerDetails: NonNullable<CatalogManifest['layerDetails']> = {};
    for (const l of layers) {
        docs.set(layerIdOf(l), unitVector(l.axis));
        layerDetails[layerIdOf(l)] = {
            fingerprint: l.fingerprint,
            geometryType: l.geometryType,
            ...(l.tableDescription ? { tableDescription: l.tableDescription } : {}),
            ...(l.geometryDescription ? { geometryDescription: l.geometryDescription } : {}),
        };
    }
    return storage.writeVersion(version, docs, {
        sourceFingerprint: `source-${version}`,
        embeddingContract: contract,
        layerDetails,
    });
}

/** Monkey-patch the private embedQuery seam so no real runtime is imported. */
function installQueryMock(service: RetrievalService, axisClass: number) {
    const fn = vi.fn(async () => unitVector(axisClass));
    (service as unknown as { embedQuery: (q: string) => Promise<Float32Array> }).embedQuery = fn;
    return fn;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
    const err = await promise.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(err).toMatchObject({ code });
}

describe('RetrievalService — mocked embedding + fake index', () => {
    let fake: FakeValkey;
    let storage: IndexStorage;
    let service: RetrievalService;

    beforeEach(async () => {
        fake = new FakeValkey();
        storage = new IndexStorage(fake);
        await publish(storage, 1, LAYERS);
        service = new RetrievalService({
            storage,
            contractFingerprint: () => CONTRACT,
            assertArtifacts: () => undefined,
        });
        installQueryMock(service, 0);
        semanticSearchMetrics.reset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns typed INDEX_NOT_FOUND when nothing is published — never []', async () => {
        fake.store.clear();
        await expectCode(service.search('jalan'), 'INDEX_NOT_FOUND');
    });

    it('returns typed INDEX_UNAVAILABLE when the store is degraded — never []', async () => {
        fake.degraded = true;
        await expectCode(service.search('jalan'), 'INDEX_UNAVAILABLE');
    });

    it('returns typed VERSION_MISMATCH when the local model contract drifted', async () => {
        const drifted = new RetrievalService({
            storage,
            contractFingerprint: () => 'a-different-contract',
            assertArtifacts: () => undefined,
        });
        installQueryMock(drifted, 0);
        await expectCode(drifted.search('jalan'), 'VERSION_MISMATCH');
    });

    it('ranks by descending cosine and returns schema-qualified metadata', async () => {
        // Query is closest to the axis-0 layer (public.persil_bidang).
        installQueryMock(service, 0);
        const res = await service.search('tanah sertifikat');

        expect(res.query).toBe('tanah sertifikat');
        expect(res.results.length).toBe(LAYERS.length);
        const first = res.results[0]!;
        expect(first.layer.schema).toBe('public');
        expect(first.layer.table).toBe('persil_bidang');
        expect(first.layer.geometry).toBe('geom');
        expect(first.catalogId).toBe('public.persil_bidang');
        expect(first.geometryType).toBe('Polygon');
        expect(first.tableDescription).toBe('Sertifikat tanah (land parcels)');
        expect(first.score).toBeGreaterThan(0.99);

        for (let i = 1; i < res.results.length; i++) {
            expect(res.results[i]!.score).toBeLessThanOrEqual(res.results[i - 1]!.score);
        }
    });

    it('breaks score ties deterministically by alphabetical layerId', async () => {
        // gis.banjir and public.persil both get axis 0 -> identical vectors -> a
        // perfect score tie; the alphabetical winner is gis.banjir.geom.
        const modified = LAYERS.map((l) => (l.table === 'banjir' ? { ...l, axis: 0 } : l));
        await publish(storage, 2, modified);
        installQueryMock(service, 0);

        const res = await service.search('banjir');
        const topTwo = res.results.slice(0, 2);
        expect(topTwo[0]!.catalogId).toBe('gis.banjir');
        expect(topTwo[1]!.catalogId).toBe('public.persil_bidang');
        expect(topTwo[0]!.score).toBeCloseTo(topTwo[1]!.score, 5);
    });

    it('applies the schema filter ONLY when provided', async () => {
        installQueryMock(service, 2);
        const filtered = await service.search('banjir', { schema: 'public' });
        expect(filtered.results.length).toBeGreaterThan(0);
        for (const r of filtered.results) expect(r.layer.schema).toBe('public');
        expect(filtered.results.some((r) => r.catalogId === 'gis.banjir')).toBe(false);

        const unfiltered = await service.search('banjir');
        expect(unfiltered.results[0]!.catalogId).toBe('gis.banjir');
    });

    it('applies the geometryType filter (case-insensitive) ONLY when provided', async () => {
        installQueryMock(service, 1);
        const res = await service.search('jalan', { geometryType: 'polygon' });
        for (const r of res.results) expect(r.geometryType.toLowerCase()).toBe('polygon');
        // site_plan (MultiLineStringZ) is excluded even though it would be the top match.
        expect(res.results.some((r) => r.catalogId === 'public.site_plan')).toBe(false);
    });

    it('caps topK at the configured maximum when the caller asks for more', async () => {
        installQueryMock(service, 1);
        const res = await service.search('x', { topK: 10_000 });
        expect(res.results.length).toBeLessThanOrEqual(100);
    });

    it('rejects a blank query with INVALID_ARGS', async () => {
        await expectCode(service.search('   '), 'INVALID_ARGS');
    });

    it('document LRU hits on repeat searches and misses after a version bump', async () => {
        installQueryMock(service, 0);

        // First search (v1): all doc keys miss.
        await service.search('tanah');
        let snap = semanticSearchMetrics.getSnapshot();
        expect(snap.documentCacheMisses).toBeGreaterThan(0);
        expect(snap.documentCacheHits).toBe(0);
        const missesBeforeBump = snap.documentCacheMisses;

        // Different query, same version: doc cache HITS (same layer vectors),
        // result cache misses (different query signature).
        await service.search('parcel');
        snap = semanticSearchMetrics.getSnapshot();
        expect(snap.documentCacheHits).toBeGreaterThan(0);

        // Same query again -> result LRU hit (whole answer cached).
        const beforeResultHits = snap.resultCacheHits;
        await service.search('parcel');
        expect(semanticSearchMetrics.getSnapshot().resultCacheHits).toBeGreaterThan(beforeResultHits);

        // Version bump to 2 (fresh fingerprints): version-scoped doc keys miss.
        const bumped = LAYERS.map((l) => ({ ...l, fingerprint: `${l.fingerprint}-v2` }));
        await publish(storage, 2, bumped);
        await service.search('tanah');
        snap = semanticSearchMetrics.getSnapshot();
        expect(snap.documentCacheMisses).toBeGreaterThan(missesBeforeBump);
    });

    it('reports hit/miss metrics for query and result caches', async () => {
        installQueryMock(service, 0);
        await service.search('jalan');
        const afterFirst = semanticSearchMetrics.getSnapshot();
        expect(afterFirst.queryCacheMisses).toBe(1);
        expect(afterFirst.resultCacheMisses).toBe(1);

        // Same query with a different filter: result key differs, so the query
        // vector is reused from the query LRU and only the result cache misses.
        await service.search('jalan', { topK: 5 });
        const afterSecond = semanticSearchMetrics.getSnapshot();
        expect(afterSecond.queryCacheHits).toBe(1);
        expect(afterSecond.resultCacheHits).toBe(0);

        // Exact repeat (same query + filter): the whole answer comes from the
        // result LRU and neither embedding nor query cache is consulted.
        await service.search('jalan', { topK: 5 });
        const afterThird = semanticSearchMetrics.getSnapshot();
        expect(afterThird.resultCacheHits).toBe(1);
    });
});

describe('RetrievalService — pre-metadata manifest guardrail', () => {
    it('fails INDEX_UNAVAILABLE when the manifest predates layerDetails', async () => {
        const fake2 = new FakeValkey();
        const storage2 = new IndexStorage(fake2);
        await storage2.writeVersion(1, new Map([['public.a.geom', unitVector(0)]]), {
            sourceFingerprint: 'x',
            embeddingContract: CONTRACT,
            // No layerDetails: legacy manifest shape.
        });

        const svc = new RetrievalService({
            storage: storage2,
            contractFingerprint: () => CONTRACT,
            assertArtifacts: () => undefined,
        });
        installQueryMock(svc, 0);
        await expectCode(svc.search('a'), 'INDEX_UNAVAILABLE');
    });
});
