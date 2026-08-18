import crypto from "node:crypto";
import { TwoLevelTileCache } from "../src/libs/cache/two-level-cache";
import env from "../src/libs/env";

interface BenchmarkResult {
    scenario: string;
    mode: string;
    totalRequests: number;
    rps: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    dbQueries: number;
    hitRatio: string;
}

// Generate realistic simulated MVT binary buffer (15 KB payload)
const sampleTileBuffer = crypto.randomBytes(15 * 1024);

function percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return Number(sorted[Math.max(0, index)].toFixed(2));
}

async function runBenchmarkCase(
    name: string,
    cache: TwoLevelTileCache,
    requestKeys: string[],
    concurrency = 20
): Promise<BenchmarkResult> {
    let dbQueries = 0;
    let hits = 0;

    const mockPostgisCompute = async (): Promise<Buffer> => {
        dbQueries++;
        // Simulate 15ms database query latency
        await new Promise((resolve) => setTimeout(resolve, 15));
        return sampleTileBuffer;
    };

    const latencies: number[] = [];
    const totalRequests = requestKeys.length;
    const startTime = Date.now();

    // Execute in concurrency batches
    for (let i = 0; i < totalRequests; i += concurrency) {
        const batch = requestKeys.slice(i, i + concurrency);
        const batchPromises = batch.map(async (key) => {
            const reqStart = performance.now();
            const result = await cache.getOrCompute(key, mockPostgisCompute);
            const reqEnd = performance.now();
            latencies.push(reqEnd - reqStart);

            if (result.source === "L1" || result.source === "L2") {
                hits++;
            }
        });
        await Promise.all(batchPromises);
    }

    const totalDurationSec = (Date.now() - startTime) / 1000;
    const rps = Number((totalRequests / Math.max(0.001, totalDurationSec)).toFixed(1));
    const hitRatio = `${((hits / totalRequests) * 100).toFixed(1)}%`;

    return {
        scenario: "",
        mode: name,
        totalRequests,
        rps,
        p50Ms: percentile(latencies, 50),
        p95Ms: percentile(latencies, 95),
        p99Ms: percentile(latencies, 99),
        dbQueries,
        hitRatio,
    };
}

async function main() {
    console.log("==========================================================================================");
    console.log("                    MVT 2-LEVEL VECTOR TILE CACHE BENCHMARK SUITE                         ");
    console.log("==========================================================================================");
    console.log(`Valkey Host: ${env.VALKEY_HOST || "localhost"}:${env.VALKEY_PORT || 6379}`);
    console.log(`Simulated Tile Payload: 15 KB binary Buffer`);
    console.log("------------------------------------------------------------------------------------------\n");

    const allResults: BenchmarkResult[] = [];

    // Configuration modes
    const createModes = () => ({
        "No Cache": new TwoLevelTileCache({
            enabled: false,
            singleFlightEnabled: false,
        }),
        "L1 Only": new TwoLevelTileCache({
            enabled: true,
            l1Options: { enabled: true, maxSizeMb: 256, maxItems: 10000 },
            l2Options: { enabled: false },
            singleFlightEnabled: false,
        }),
        "L2 Only": new TwoLevelTileCache({
            enabled: true,
            l1Options: { enabled: false },
            l2Options: { enabled: true, host: env.VALKEY_HOST || "localhost", port: env.VALKEY_PORT || 6379 },
            singleFlightEnabled: false,
        }),
        "L1 + L2": new TwoLevelTileCache({
            enabled: true,
            l1Options: { enabled: true, maxSizeMb: 256, maxItems: 10000 },
            l2Options: { enabled: true, host: env.VALKEY_HOST || "localhost", port: env.VALKEY_PORT || 6379 },
            singleFlightEnabled: false,
        }),
        "L1 + L2 + SingleFlight": new TwoLevelTileCache({
            enabled: true,
            l1Options: { enabled: true, maxSizeMb: 256, maxItems: 10000 },
            l2Options: { enabled: true, host: env.VALKEY_HOST || "localhost", port: env.VALKEY_PORT || 6379 },
            singleFlightEnabled: true,
        }),
    });

    // -------------------------------------------------------------
    // Scenario 1: Hot Tile (1000 requests for 1 key)
    // -------------------------------------------------------------
    console.log("▶ Running Scenario 1: Hot Tile (1000 requests for 1 key)...");
    const hotKeys = Array.from({ length: 1000 }, () => "mvt:v1:buildings:d1:z14:x100:y200:qdefault");

    for (const modeName of ["No Cache", "L1 Only", "L2 Only", "L1 + L2", "L1 + L2 + SingleFlight"] as const) {
        const cache = createModes()[modeName];
        await cache.connect().catch(() => {});
        const res = await runBenchmarkCase(modeName, cache, hotKeys, 50);
        res.scenario = "1. Hot Tile (100% hits)";
        allResults.push(res);
        await cache.disconnect();
    }

    // -------------------------------------------------------------
    // Scenario 2: 80/20 Zipfian Distribution (1000 requests, 20 unique tiles)
    // -------------------------------------------------------------
    console.log("▶ Running Scenario 2: 80/20 Pareto Distribution (1000 requests across 20 tiles)...");
    const zipfKeys: string[] = [];
    for (let i = 0; i < 1000; i++) {
        // 80% of requests go to first 4 tiles (hotset), 20% to remaining 16 tiles
        const tileIdx = Math.random() < 0.8 ? Math.floor(Math.random() * 4) : 4 + Math.floor(Math.random() * 16);
        zipfKeys.push(`mvt:v1:buildings:d1:z14:x${tileIdx}:y${tileIdx}:qdefault`);
    }

    for (const modeName of ["No Cache", "L1 Only", "L2 Only", "L1 + L2", "L1 + L2 + SingleFlight"] as const) {
        const cache = createModes()[modeName];
        await cache.connect().catch(() => {});
        const res = await runBenchmarkCase(modeName, cache, zipfKeys, 25);
        res.scenario = "2. 80/20 Distribution";
        allResults.push(res);
        await cache.disconnect();
    }

    // -------------------------------------------------------------
    // Scenario 3: Cache Stampede (500 concurrent cold misses for 5 keys)
    // -------------------------------------------------------------
    console.log("▶ Running Scenario 3: Stampede Cold Misses (500 parallel requests across 5 cold keys)...");

    for (const modeName of ["No Cache", "L1 Only", "L2 Only", "L1 + L2", "L1 + L2 + SingleFlight"] as const) {
        const stampedeKeys: string[] = [];
        const runId = Math.random().toString(36).slice(2, 8);
        for (let k = 0; k < 5; k++) {
            for (let i = 0; i < 100; i++) {
                stampedeKeys.push(`mvt:v1:stampede_${runId}:d1:z14:x${k}:y${k}:qdefault`);
            }
        }

        const cache = createModes()[modeName];
        await cache.connect().catch(() => {});
        const res = await runBenchmarkCase(modeName, cache, stampedeKeys, 100);
        res.scenario = "3. Stampede Cold Miss";
        allResults.push(res);
        await cache.disconnect();
    }

    // Print summary table
    console.log("\n==========================================================================================");
    console.log("                               BENCHMARK RESULTS TABLE                                    ");
    console.log("==========================================================================================");
    console.table(
        allResults.map((r) => ({
            Scenario: r.scenario,
            Mode: r.mode,
            RPS: r.rps,
            "p50 (ms)": r.p50Ms,
            "p95 (ms)": r.p95Ms,
            "p99 (ms)": r.p99Ms,
            "DB Queries": r.dbQueries,
            "Hit Ratio": r.hitRatio,
        }))
    );

    console.log("Benchmark complete!\n");
    process.exit(0);
}

main().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
});
