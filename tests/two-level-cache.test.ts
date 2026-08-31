import { describe, it, expect, vi } from "vitest";
import { TwoLevelTileCache } from "../src/libs/cache/two-level-cache";

describe("Two-Level Tile Cache Integration Tests", () => {
    it("should return from L1 immediately and NOT call L2 on L1 hit", async () => {
        const cache = new TwoLevelTileCache();
        const testKey = "mvt:v1:buildings:d1:z14:x100:y200:qdefault";
        const testData = Buffer.from("l1-cached-tile-data");

        // Seed L1
        cache.l1Cache.set(testKey, testData);

        const l2GetSpy = vi.spyOn(cache.l2Cache, "get");
        const computeMock = vi.fn().mockResolvedValue(Buffer.from("fresh-db-tile"));

        const result = await cache.getOrCompute(testKey, computeMock);

        expect(result.source).toBe("L1");
        expect(result.data).toEqual(testData);
        expect(computeMock).not.toHaveBeenCalled();
        expect(l2GetSpy).not.toHaveBeenCalled();

        l2GetSpy.mockRestore();
    });

    it("should promote L2 hit into L1 for subsequent instant lookups", async () => {
        const cache = new TwoLevelTileCache();
        const testKey = "mvt:v1:roads:d1:z14:x100:y200:qdefault";
        const l2Data = Buffer.from("l2-cached-tile-data");

        // Mock L2 get returning data, L1 is empty
        vi.spyOn(cache.l2Cache, "get").mockResolvedValueOnce(l2Data);
        const computeMock = vi.fn();

        // 1st request -> L1 miss, L2 hit
        const result1 = await cache.getOrCompute(testKey, computeMock);
        expect(result1.source).toBe("L2");
        expect(result1.data).toEqual(l2Data);
        expect(computeMock).not.toHaveBeenCalled();

        // Check that L1 now contains the promoted tile
        expect(cache.l1Cache.get(testKey)).toEqual(l2Data);

        // 2nd request -> L1 hit!
        const result2 = await cache.getOrCompute(testKey, computeMock);
        expect(result2.source).toBe("L1");
        expect(result2.data).toEqual(l2Data);
    });

    it("should compute from DB on full cache miss and populate L1 & L2", async () => {
        const cache = new TwoLevelTileCache();
        const testKey = "mvt:v1:landuse:d1:z14:x100:y200:qdefault";
        const freshTile = Buffer.from("fresh-tile-from-postgis");

        const l2SetSpy = vi.spyOn(cache.l2Cache, "set").mockResolvedValue(true);
        const computeMock = vi.fn().mockResolvedValue(freshTile);

        // 1st request: Full miss -> compute
        const result = await cache.getOrCompute(testKey, computeMock);

        expect(result.source).toBe("MISS");
        expect(result.data).toEqual(freshTile);
        expect(computeMock).toHaveBeenCalledTimes(1);

        // L1 is populated
        expect(cache.l1Cache.get(testKey)).toEqual(freshTile);

        // L2 was called to populate asynchronously
        expect(l2SetSpy).toHaveBeenCalledWith(
            testKey,
            freshTile,
            expect.any(Number)
        );

        // 2nd request: Hits L1
        const result2 = await cache.getOrCompute(testKey, computeMock);
        expect(result2.source).toBe("L1");
        expect(computeMock).toHaveBeenCalledTimes(1); // Still 1
    });

    it("should handle empty tiles correctly without poisoning cache", async () => {
        const cache = new TwoLevelTileCache();
        const testKey = "mvt:v1:empty_table:d1:z14:x100:y200:qdefault";

        const computeMock = vi.fn().mockResolvedValue(Buffer.alloc(0));

        const result = await cache.getOrCompute(testKey, computeMock);

        expect(result.source).toBe("MISS");
        expect(result.isEmpty).toBe(true);
        expect(result.data.length).toBe(0);
        expect(result.eTag).toBe('W/"0-empty"');
    });

    it("should continue functioning seamlessly when L2 (Valkey) fails", async () => {
        const cache = new TwoLevelTileCache();
        const testKey = "mvt:v1:parcels:d1:z14:x100:y200:qdefault";
        const tileData = Buffer.from("postgis-tile-under-valkey-outage");

        // Mock L2 failing on GET and SET
        vi.spyOn(cache.l2Cache, "get").mockRejectedValue(new Error("Valkey connection reset"));
        vi.spyOn(cache.l2Cache, "set").mockRejectedValue(new Error("Valkey timeout"));

        const computeMock = vi.fn().mockResolvedValue(tileData);

        // 1st request: Valkey is failing -> falls back to DB cleanly without throwing
        const result1 = await cache.getOrCompute(testKey, computeMock);
        expect(result1.source).toBe("MISS");
        expect(result1.data).toEqual(tileData);

        // L1 still stored the computed result!
        // 2nd request: Hits L1 directly despite L2 outage
        const result2 = await cache.getOrCompute(testKey, computeMock);
        expect(result2.source).toBe("L1");
        expect(result2.data).toEqual(tileData);
        expect(computeMock).toHaveBeenCalledTimes(1);
    });

    it("should support explicit cache bypass", async () => {
        const cache = new TwoLevelTileCache();
        const testKey = "mvt:v1:bypass_test:d1:z14:x100:y200:qdefault";

        // Seed L1
        cache.l1Cache.set(testKey, Buffer.from("cached-data"));

        const computeMock = vi.fn().mockResolvedValue(Buffer.from("bypassed-fresh-data"));

        const result = await cache.getOrCompute(testKey, computeMock, { bypass: true });

        expect(result.source).toBe("BYPASS");
        expect(result.data.toString()).toBe("bypassed-fresh-data");
        expect(computeMock).toHaveBeenCalledTimes(1);
    });
});
