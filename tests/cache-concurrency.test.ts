import { describe, it, expect, vi } from "vitest";
import { TwoLevelTileCache } from "../src/libs/cache/two-level-cache";

describe("Cache Concurrency & Stampede Prevention Tests", () => {
    it("should handle 100 concurrent requests for the same tile with exactly 1 DB query", async () => {
        const cache = new TwoLevelTileCache();
        const testKey = "mvt:v1:concurrency:d1:z14:x500:y600:qdefault";
        const expectedBuffer = Buffer.from("real-mvt-binary-payload-data");

        let dbQueryCount = 0;
        const mockPostgisCompute = async (): Promise<Buffer> => {
            dbQueryCount++;
            // Simulate 30ms database latency
            await new Promise((resolve) => setTimeout(resolve, 30));
            return expectedBuffer;
        };

        // Launch 100 concurrent requests
        const promises = Array.from({ length: 100 }, () =>
            cache.getOrCompute(testKey, mockPostgisCompute)
        );

        const results = await Promise.all(promises);

        // Verification: Exactly 1 database query was run
        expect(dbQueryCount).toBe(1);

        // All 100 callers received the same valid response
        for (const res of results) {
            expect(res.data).toEqual(expectedBuffer);
            expect(res.eTag).toBe(results[0].eTag);
        }

        // 1 caller got MISS, remaining got MISS with coalesced result
        const missSources = results.filter((r) => r.source === "MISS");
        expect(missSources).toHaveLength(100);

        // Immediately following request hits L1
        const followup = await cache.getOrCompute(testKey, mockPostgisCompute);
        expect(followup.source).toBe("L1");
        expect(dbQueryCount).toBe(1);
    });

    it("should handle 500 concurrent requests across 5 different tiles (100 per tile) with exactly 5 DB queries", async () => {
        const cache = new TwoLevelTileCache();
        let dbQueryCount = 0;

        const mockPostgisCompute = async (tileId: string): Promise<Buffer> => {
            dbQueryCount++;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return Buffer.from(`payload-for-${tileId}`);
        };

        const tileKeys = [
            "mvt:v1:multi:d1:z14:x1:y1:qdefault",
            "mvt:v1:multi:d1:z14:x2:y2:qdefault",
            "mvt:v1:multi:d1:z14:x3:y3:qdefault",
            "mvt:v1:multi:d1:z14:x4:y4:qdefault",
            "mvt:v1:multi:d1:z14:x5:y5:qdefault",
        ];

        // 500 requests (100 for each of the 5 keys)
        const requests = [];
        for (const key of tileKeys) {
            for (let i = 0; i < 100; i++) {
                requests.push(cache.getOrCompute(key, () => mockPostgisCompute(key)));
            }
        }

        const results = await Promise.all(requests);

        // Exactly 5 DB queries executed for 500 requests
        expect(dbQueryCount).toBe(5);
        expect(results).toHaveLength(500);
    });
});
