import { describe, it, expect } from "vitest";
import { L1TileCache } from "../src/libs/cache/l1-cache";

describe("L1 Process-Local Cache Tests", () => {
    it("should store and retrieve binary Buffer payloads accurately", () => {
        const cache = new L1TileCache({ maxItems: 100, maxSizeMb: 10 });
        const testBuffer = Buffer.from([0x1a, 0x2b, 0x3c, 0x4d, 0x5e]);

        cache.set("tile:1", testBuffer);
        const retrieved = cache.get("tile:1");

        expect(retrieved).not.toBeNull();
        expect(Buffer.isBuffer(retrieved)).toBe(true);
        expect(retrieved).toEqual(testBuffer);
        expect(retrieved?.byteLength).toBe(5);
    });

    it("should return null on cache miss", () => {
        const cache = new L1TileCache();
        expect(cache.get("non-existent-key")).toBeNull();
    });

    it("should accurately track memory consumption in bytes", () => {
        const cache = new L1TileCache({ maxSizeMb: 10 });
        const buf1 = Buffer.alloc(1024); // 1 KB
        const buf2 = Buffer.alloc(2048); // 2 KB

        cache.set("key1", buf1);
        expect(cache.calculatedSize).toBe(1024);
        expect(cache.itemCount).toBe(1);

        cache.set("key2", buf2);
        expect(cache.calculatedSize).toBe(3072);
        expect(cache.itemCount).toBe(2);

        cache.delete("key1");
        expect(cache.calculatedSize).toBe(2048);
        expect(cache.itemCount).toBe(1);
    });

    it("should evict oldest items when exceeding maxSize (memory bounding)", () => {
        // Cache bounded to 0.003 MB (~3 KB = 3145 bytes)
        // Set max size explicitly to 3000 bytes
        const cache = new L1TileCache({
            maxSizeMb: 0.003, // ~3145 bytes
            maxItems: 100,
        });

        const buf1KB = Buffer.alloc(1000, 1);
        const buf2KB = Buffer.alloc(1000, 2);
        const buf3KB = Buffer.alloc(1000, 3);
        const buf4KB = Buffer.alloc(1000, 4);

        cache.set("tile:1", buf1KB);
        cache.set("tile:2", buf2KB);
        cache.set("tile:3", buf3KB);

        expect(cache.has("tile:1")).toBe(true);
        expect(cache.has("tile:2")).toBe(true);
        expect(cache.has("tile:3")).toBe(true);

        // Adding 4th buffer should evict oldest (tile:1)
        cache.set("tile:4", buf4KB);

        expect(cache.get("tile:1")).toBeNull(); // Evicted
        expect(cache.get("tile:4")).not.toBeNull();
        expect(cache.calculatedSize).toBeLessThanOrEqual(3146);
    });

    it("should expire items when TTL elapses", async () => {
        const cache = new L1TileCache({ ttlMs: 50 });
        const buf = Buffer.from("temporary-tile");

        cache.set("tile:temp", buf);
        expect(cache.get("tile:temp")).not.toBeNull();

        // Wait for TTL to expire
        await new Promise((resolve) => setTimeout(resolve, 70));

        expect(cache.get("tile:temp")).toBeNull();
    });

    it("should support disabling L1 cache completely", () => {
        const cache = new L1TileCache({ enabled: false });
        const buf = Buffer.from("data");

        cache.set("tile:disabled", buf);
        expect(cache.get("tile:disabled")).toBeNull();
        expect(cache.itemCount).toBe(0);
    });
});
