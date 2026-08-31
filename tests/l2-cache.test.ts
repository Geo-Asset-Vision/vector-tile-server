import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { L2TileCache } from "../src/libs/cache/l2-cache";
import { ValkeyClient } from "../src/libs/cache/valkey-client";
import env from "../src/libs/env";

describe("L2 Valkey Cache & Circuit Breaker Tests", () => {
    let l2Cache: L2TileCache;
    const testKey = "test:mvt:tile:z14:x100:y200";
    const testBuffer = Buffer.from([0x00, 0x1f, 0x2e, 0x3d, 0x4c, 0x5b, 0x6a, 0x79]);

    beforeAll(async () => {
        l2Cache = new L2TileCache({
            host: env.VALKEY_HOST || "localhost",
            port: env.VALKEY_PORT || 6379,
            password: env.VALKEY_PASSWORD,
            url: env.VALKEY_URL,
            connectTimeoutMs: 1000,
            commandTimeoutMs: 500,
            failThreshold: 2,
            cooldownMs: 200,
        });

        await l2Cache.connect();
    });

    afterAll(async () => {
        if (l2Cache) {
            await l2Cache.delete(testKey);
            await l2Cache.disconnect();
        }
    });

    it("should store and retrieve binary Buffer payloads via L2 without corruption", async () => {
        if (!l2Cache.isConnected) {
            console.warn("Skipping live Valkey roundtrip test (Valkey not connected)");
            return;
        }

        const success = await l2Cache.set(testKey, testBuffer, 5000);
        expect(success).toBe(true);

        const retrieved = await l2Cache.get(testKey);
        expect(retrieved).not.toBeNull();
        expect(Buffer.isBuffer(retrieved)).toBe(true);
        expect(retrieved).toEqual(testBuffer);
        expect(retrieved?.byteLength).toBe(testBuffer.byteLength);
    });

    it("should return null on L2 cache miss", async () => {
        if (!l2Cache.isConnected) return;
        const result = await l2Cache.get("non-existent-l2-key");
        expect(result).toBeNull();
    });

    it("should gracefully handle unavailable Valkey server without throwing errors", async () => {
        // Create an L2 cache pointing to non-existent port
        const badL2 = new L2TileCache({
            host: "127.0.0.1",
            port: 59999, // Unused port
            connectTimeoutMs: 100,
            commandTimeoutMs: 100,
            failThreshold: 2,
            cooldownMs: 200,
        });

        // Attempt get from unreachable server -> should return null without throwing
        const result = await badL2.get("any-key");
        expect(result).toBeNull();

        // Attempt set to unreachable server -> should return false without throwing
        const setResult = await badL2.set("any-key", testBuffer, 1000);
        expect(setResult).toBe(false);

        await badL2.disconnect();
    });

    it("should transition circuit breaker to DEGRADED state after repeated failures", async () => {
        const client = new ValkeyClient({
            host: "127.0.0.1",
            port: 59998, // Unused port
            connectTimeoutMs: 50,
            commandTimeoutMs: 50,
            failThreshold: 2,
            cooldownMs: 100,
        });

        expect(client.getCircuitState()).toBe("HEALTHY");

        // Failure 1
        await client.getBuffer("key1");
        // Failure 2
        await client.getBuffer("key2");

        // Now consecutiveFailures >= 2, should be DEGRADED
        expect(client.getCircuitState()).toBe("DEGRADED");

        // In DEGRADED state, getBuffer immediately returns null fast without waiting
        const t0 = Date.now();
        const fastResult = await client.getBuffer("key3");
        const elapsed = Date.now() - t0;

        expect(fastResult).toBeNull();
        expect(elapsed).toBeLessThan(20); // Fast failover

        // Wait for cooldown to expire
        await new Promise((resolve) => setTimeout(resolve, 120));

        // State becomes PROBING
        expect(client.getCircuitState()).toBe("PROBING");

        await client.disconnect();
    });
});
