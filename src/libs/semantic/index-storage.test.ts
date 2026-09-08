import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SEMANTIC_DIM, makeLayerId, indexNamespace } from './contracts.js';
import { IndexStorage, SEMANTIC_MANIFEST_KEY, type ValkeyLike } from './index-storage.js';
import { ValkeyClient } from '../cache/valkey-client.js';
import env from '@/libs/env';

// ---------------------------------------------------------------------------
// In-memory fake of the ValkeyLike seam — models the exact failure semantics of
// ValkeyClient.executeWithTimeout (null on degraded/unconfigured/disconnected).
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
        for (const key of keys) {
            if (this.store.delete(key)) removed += 1;
        }
        return removed;
    }
}

// Deterministic, Float32-representable vectors — identical floats must survive the roundtrip.
function mkVec(seed: number): Float32Array {
    const v = new Float32Array(SEMANTIC_DIM);
    for (let i = 0; i < v.length; i++) v[i] = seed + i * 0.001;
    return v;
}

function expectSameFloats(actual: Float32Array, expected: Float32Array): void {
    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) expect(actual[i]).toBe(expected[i]);
}

describe('IndexStorage — fake Valkey (unit)', () => {
    const fake = new FakeValkey();
    const storage = new IndexStorage(fake);

    const publicRoads = makeLayerId({ schema: 'public', table: 'roads', geometry: 'geom' });
    const gisRoads = makeLayerId({ schema: 'gis', table: 'roads', geometry: 'geom' });
    const publicBuildings = makeLayerId({ schema: 'public', table: 'buildings', geometry: 'geom' });

    afterEach(() => {
        fake.store.clear();
        fake.degraded = false;
        fake.configured = true;
        fake.connected = true;
    });

    it('returns not-found on a healthy store with no manifest', async () => {
        const res = await storage.readPublished();
        expect(res.status).toBe('not-found');
        if (res.status === 'not-found') expect(res.code).toBe('INDEX_NOT_FOUND');
    });

    it('roundtrips written Float32 vectors intact (1536-byte payloads)', async () => {
        const docs = new Map([
            [publicRoads, mkVec(1)],
            [gisRoads, mkVec(-2.5)],
        ]);
        const write = await storage.writeVersion(1, docs, { sourceFingerprint: 'fp-v1' });
        expect(write.status).toBe('ok');
        if (write.status !== 'ok') return;
        expect(write.documents).toBe(2);
        expect(write.previousVersion).toBeNull();
        expect(write.purgedKeys).toBe(0);

        const read = await storage.readPublished();
        expect(read.status).toBe('ok');
        if (read.status !== 'ok') return;
        expect(read.version).toBe(1);
        expect(read.manifest.layers).toHaveLength(2);
        expect(read.documents.size).toBe(2);
        expectSameFloats(read.documents.get(publicRoads)!, mkVec(1));
        expectSameFloats(read.documents.get(gisRoads)!, mkVec(-2.5));
    });

    it('never exposes a mixed namespace: publish v2 purges v1, readers see only v2', async () => {
        await storage.writeVersion(1, new Map([[publicRoads, mkVec(1)]]));
        const v2 = await storage.writeVersion(
            2,
            new Map([[publicBuildings, mkVec(9)]]),
            { sourceFingerprint: 'fp-v2' },
        );
        expect(v2.status).toBe('ok');
        if (v2.status !== 'ok') return;
        expect(v2.previousVersion).toBe(1);
        expect(v2.purgedKeys).toBe(1); // sem:index:1:public.roads.geom removed

        // v1 namespace gone from the store entirely.
        expect(fake.store.has(indexNamespace(1, { schema: 'public', table: 'roads', geometry: 'geom' }))).toBe(false);
        // v2 docs present.
        expect(fake.store.has(indexNamespace(2, { schema: 'public', table: 'buildings', geometry: 'geom' }))).toBe(true);

        const read = await storage.readPublished();
        expect(read.status).toBe('ok');
        if (read.status !== 'ok') return;
        expect(read.version).toBe(2);
        expect(read.documents.size).toBe(1);
        expect(read.documents.has(publicRoads)).toBe(false); // never mixed
        expectSameFloats(read.documents.get(publicBuildings)!, mkVec(9));
    });

    it('keeps duplicate table names in two schemas as distinct retrievable keys', async () => {
        const docs = new Map([
            [publicRoads, mkVec(10)],
            [gisRoads, mkVec(-10)],
        ]);
        const write = await storage.writeVersion(1, docs);
        expect(write.status).toBe('ok');

        const keyP = indexNamespace(1, { schema: 'public', table: 'roads', geometry: 'geom' });
        const keyG = indexNamespace(1, { schema: 'gis', table: 'roads', geometry: 'geom' });
        expect(keyP).not.toBe(keyG);
        expect(fake.store.has(keyP)).toBe(true);
        expect(fake.store.has(keyG)).toBe(true);

        const read = await storage.readPublished();
        expect(read.status).toBe('ok');
        if (read.status !== 'ok') return;
        expect(read.documents.size).toBe(2);
        expectSameFloats(read.documents.get(publicRoads)!, mkVec(10));
        expectSameFloats(read.documents.get(gisRoads)!, mkVec(-10));
    });

    it('rejects a malformed (non-4-byte-aligned) vector with a typed outcome, never empty matches', async () => {
        await storage.writeVersion(1, new Map([[publicRoads, mkVec(1)]]));
        // Corrupt the stored payload to 100 bytes (not a multiple of 4).
        await fake.setBuffer(
            indexNamespace(1, { schema: 'public', table: 'roads', geometry: 'geom' }),
            Buffer.alloc(100, 0xff),
        );

        const read = await storage.readPublished();
        expect(read.status).toBe('unavailable');
        if (read.status === 'unavailable') {
            expect(read.code).toBe('INDEX_UNAVAILABLE');
            expect(read.message).toContain('public.roads.geom');
        }
        expect(read.status === 'ok' && read.documents.size === 0).toBe(false);
    });

    it('rejects a wrong-dimension payload with a typed outcome, never empty matches', async () => {
        await storage.writeVersion(1, new Map([[publicRoads, mkVec(1)]]));
        // 384*4 = 1536 bytes aligned, but 385 dims worth → mismatch on dimension check.
        await fake.setBuffer(
            indexNamespace(1, { schema: 'public', table: 'roads', geometry: 'geom' }),
            Buffer.alloc(385 * 4, 0x00),
        );

        const read = await storage.readPublished();
        expect(read.status).toBe('unavailable');
        if (read.status === 'unavailable') expect(read.code).toBe('INDEX_UNAVAILABLE');
    });

    it('returns typed unavailable when the circuit is DEGRADED — never ok, never []', async () => {
        await storage.writeVersion(1, new Map([[publicRoads, mkVec(1)]]));
        fake.degraded = true;

        const write = await storage.writeVersion(2, new Map([[publicRoads, mkVec(2)]]));
        expect(write.status).toBe('unavailable');
        if (write.status === 'unavailable') expect(write.code).toBe('INDEX_UNAVAILABLE');

        const read = await storage.readPublished();
        expect(read.status).toBe('unavailable');
        if (read.status === 'unavailable') expect(read.code).toBe('INDEX_UNAVAILABLE');
    });

    it('returns typed unavailable when the client is unconfigured — never empty matches', async () => {
        fake.configured = false;
        const write = await storage.writeVersion(1, new Map([[publicRoads, mkVec(1)]]));
        expect(write.status).toBe('unavailable');
        const read = await storage.readPublished();
        expect(read.status).toBe('unavailable');
        if (read.status === 'unavailable') expect(read.code).toBe('INDEX_UNAVAILABLE');
    });

    it('rejects re-publishing an already-current version (monotonic guard)', async () => {
        await storage.writeVersion(2, new Map([[publicRoads, mkVec(2)]]));
        const stale = await storage.writeVersion(1, new Map([[publicRoads, mkVec(1)]]));
        expect(stale.status).toBe('invalid');
        if (stale.status === 'invalid') expect(stale.code).toBe('VERSION_MISMATCH');
        // Current data untouched.
        const read = await storage.readPublished();
        expect(read.status).toBe('ok');
        if (read.status === 'ok') expect(read.version).toBe(2);
    });

    it('rejects vectors of the wrong dimension without writing anything', async () => {
        const short = new Float32Array(SEMANTIC_DIM - 1);
        const res = await storage.writeVersion(1, new Map([[publicRoads, short]]));
        expect(res.status).toBe('invalid');
        if (res.status === 'invalid') expect(res.code).toBe('INVALID_ARGS');
        expect(fake.store.size).toBe(0);
        expect(fake.store.has(SEMANTIC_MANIFEST_KEY)).toBe(false);
    });

    it('rejects malformed layer ids without writing anything', async () => {
        const res = await storage.writeVersion(
            1,
            new Map([['public.roads' as never, mkVec(1)]]),
        );
        expect(res.status).toBe('invalid');
        if (res.status === 'invalid') expect(res.code).toBe('INVALID_ARGS');
        expect(fake.store.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Live Valkey integration — skipped only when the container is unreachable.
// ---------------------------------------------------------------------------

const liveClient = new ValkeyClient({
    host: env.VALKEY_HOST || 'localhost',
    port: env.VALKEY_PORT || 6379,
    password: env.VALKEY_PASSWORD || undefined,
    connectTimeoutMs: 1000,
    commandTimeoutMs: 500,
    failThreshold: 2,
    cooldownMs: 200,
});

describe('IndexStorage — live Valkey integration', () => {
    let connected = false;
    let liveStorage: IndexStorage;
    const trackedKeys: string[] = [];
    // The manifest is a single global key; each live test publishes a fresh
    // monotonically-increasing version so order-independent runs never collide.
    let nextVersion = 1;

    beforeAll(async () => {
        connected = await liveClient.connect();
        liveStorage = new IndexStorage(liveClient);
        trackedKeys.push(SEMANTIC_MANIFEST_KEY);
    });

    afterAll(async () => {
        if (connected) {
            await liveClient.delMany(trackedKeys);
            await liveClient.disconnect();
        }
    });

    it('roundtrips 384-dim Float32 Buffers through real Valkey', async () => {
        if (!connected) return;
        const v = nextVersion++;
        const layer = makeLayerId({ schema: 'public', table: 'roads', geometry: 'geom' });
        const layer2 = makeLayerId({ schema: 'gis', table: 'roads', geometry: 'geom' });
        const key1 = indexNamespace(v, { schema: 'public', table: 'roads', geometry: 'geom' });
        const key2 = indexNamespace(v, { schema: 'gis', table: 'roads', geometry: 'geom' });
        trackedKeys.push(key1, key2);

        const docs = new Map([
            [layer, mkVec(0.5)],
            [layer2, mkVec(-123.456)],
        ]);
        const write = await liveStorage.writeVersion(v, docs, { sourceFingerprint: 'live-fp' });
        expect(write.status).toBe('ok');

        const read = await liveStorage.readPublished();
        expect(read.status).toBe('ok');
        if (read.status !== 'ok') return;
        expect(read.version).toBe(v);
        expect(read.documents.size).toBe(2);
        expectSameFloats(read.documents.get(layer)!, mkVec(0.5));
        expectSameFloats(read.documents.get(layer2)!, mkVec(-123.456));
    });

    it('publishes v2 and atomically switches readers to it against live Valkey', async () => {
        if (!connected) return;
        const v1 = nextVersion++;
        const v2 = nextVersion++;
        const a = makeLayerId({ schema: 'public', table: 'roads', geometry: 'geom' });
        const b = makeLayerId({ schema: 'gis', table: 'roads', geometry: 'geom' });
        const keyA1 = indexNamespace(v1, { schema: 'public', table: 'roads', geometry: 'geom' });
        const keyB1 = indexNamespace(v1, { schema: 'gis', table: 'roads', geometry: 'geom' });
        const keyA2 = indexNamespace(v2, { schema: 'public', table: 'roads', geometry: 'geom' });
        const keyB2 = indexNamespace(v2, { schema: 'gis', table: 'roads', geometry: 'geom' });
        trackedKeys.push(keyA2, keyB2);

        const w1 = await liveStorage.writeVersion(v1, new Map([[a, mkVec(1)]]));
        expect(w1.status).toBe('ok');
        const w2 = await liveStorage.writeVersion(
            v2,
            new Map([
                [a, mkVec(2)],
                [b, mkVec(3)],
            ]),
        );
        expect(w2.status).toBe('ok');
        if (w2.status !== 'ok') return;
        expect(w2.previousVersion).toBe(v1);
        expect(w2.purgedKeys).toBeGreaterThanOrEqual(1);

        const read = await liveStorage.readPublished();
        expect(read.status).toBe('ok');
        if (read.status !== 'ok') return;
        expect(read.version).toBe(v2);
        expect(read.documents.size).toBe(2);
        expectSameFloats(read.documents.get(a)!, mkVec(2));
        expectSameFloats(read.documents.get(b)!, mkVec(3));

        // Superseded v1 namespace physically removed.
        const leftover = await liveClient.getBuffer(keyA1);
        expect(leftover).toBeNull();
        const keyB1Leftover = await liveClient.getBuffer(keyB1);
        expect(keyB1Leftover).toBeNull();
    });
});
