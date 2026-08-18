import { describe, it, expect, vi } from "vitest";
import { SingleFlight } from "../src/libs/cache/single-flight";

describe("Single-Flight Request Coalescing Tests", () => {
    it("should coalesce 100 concurrent requests for the same key into a single execution", async () => {
        const singleFlight = new SingleFlight<string>();
        let executionCount = 0;

        const slowTask = async (): Promise<string> => {
            executionCount++;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return "computed-vector-tile-payload";
        };

        // Launch 100 concurrent calls for the exact same key
        const promises = Array.from({ length: 100 }, () =>
            singleFlight.execute("tile:14:100:200", slowTask)
        );

        const results = await Promise.all(promises);

        // Exactly 1 execution occurred
        expect(executionCount).toBe(1);

        // All 100 requests received the identical computed value
        for (const res of results) {
            expect(res.value).toBe("computed-vector-tile-payload");
        }

        // Exactly 1 caller had shared: false, 99 had shared: true
        const nonShared = results.filter((r) => !r.shared);
        const shared = results.filter((r) => r.shared);

        expect(nonShared).toHaveLength(1);
        expect(shared).toHaveLength(99);

        // After completion, in-flight map is completely empty
        expect(singleFlight.inFlightCount).toBe(0);
    });

    it("should execute different keys independently and concurrently", async () => {
        const singleFlight = new SingleFlight<string>();
        let executionCount = 0;

        const task = async (key: string): Promise<string> => {
            executionCount++;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return `payload-for-${key}`;
        };

        const keys = ["tile:A", "tile:B", "tile:C", "tile:D", "tile:E"];
        const promises = keys.map((key) => singleFlight.execute(key, () => task(key)));

        const results = await Promise.all(promises);

        expect(executionCount).toBe(5);
        for (let i = 0; i < keys.length; i++) {
            expect(results[i].value).toBe(`payload-for-${keys[i]}`);
            expect(results[i].shared).toBe(false);
        }

        expect(singleFlight.inFlightCount).toBe(0);
    });

    it("should clean up rejected promises so subsequent requests can retry", async () => {
        const singleFlight = new SingleFlight<string>();
        let attempt = 0;

        const failingTask = async (): Promise<string> => {
            attempt++;
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (attempt === 1) {
                throw new Error("Database timeout");
            }
            return "success-on-retry";
        };

        // 3 concurrent callers for the failing task
        const callers = [
            singleFlight.execute("failing-key", failingTask),
            singleFlight.execute("failing-key", failingTask),
            singleFlight.execute("failing-key", failingTask),
        ];

        // All 3 callers must receive the error
        await expect(Promise.all(callers)).rejects.toThrow("Database timeout");

        // Map must NOT contain the rejected promise
        expect(singleFlight.inFlightCount).toBe(0);

        // Subsequent retry should succeed cleanly
        const retryResult = await singleFlight.execute("failing-key", failingTask);
        expect(retryResult.value).toBe("success-on-retry");
        expect(attempt).toBe(2);
        expect(singleFlight.inFlightCount).toBe(0);
    });
});
