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

const sampleTileBuffer = crypto.randomBytes(15 * 1024);

const MODES = ["No Cache", "L1 Only", "L2 Only", "L1 + L2", "L1 + L2 + SingleFlight"] as const;

const l1config = { enabled: true, maxSizeMb: 256, maxItems: 10000 };
const l2config = { enabled: true, host: env.VALKEY_HOST || "localhost", port: env.VALKEY_PORT || 6379 };

function percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return Number(sorted[index].toFixed(2));
}

async function runBenchmarkCase(
    name: string,
    cache: TwoLevelTileCache,
    requestKeys: string[],
    concurrency: number
): Promise<BenchmarkResult> {
    let dbQueries = 0;
    let hits = 0;

    const mockPostgisCompute = async (): Promise<Buffer> => {
        dbQueries++;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return sampleTileBuffer;
    };

    const latencies: number[] = [];
    const totalRequests = requestKeys.length;
    const startTime = Date.now();

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

    const createModes = () => ({
        "No Cache": new TwoLevelTileCache({
            enabled: false,
            singleFlightEnabled: false,
        }),
        "L1 Only": new TwoLevelTileCache({
            enabled: true,
            l1Options: l1config,
            l2Options: { enabled: false },
            singleFlightEnabled: false,
        }),
        "L2 Only": new TwoLevelTileCache({
            enabled: true,
            l1Options: { enabled: false },
            l2Options: l2config,
            singleFlightEnabled: false,
        }),
        "L1 + L2": new TwoLevelTileCache({
            enabled: true,
            l1Options: l1config,
            l2Options: l2config,
            singleFlightEnabled: false,
        }),
        "L1 + L2 + SingleFlight": new TwoLevelTileCache({
            enabled: true,
            l1Options: l1config,
            l2Options: l2config,
            singleFlightEnabled: true,
        }),
    });

    const runScenario = async (
        scenarioName: string,
        scenarioLabel: string,
        makeKeys: () => string[],
        concurrency: number
    ) => {
        console.log(`▶ Running ${scenarioName}...`);
        for (const modeName of MODES) {
            const cache = createModes()[modeName];
            await cache.connect();
            const res = await runBenchmarkCase(modeName, cache, makeKeys(), concurrency);
            res.scenario = scenarioLabel;
            allResults.push(res);
            await cache.disconnect();
        }
    };

    const hotKeys = Array.from({ length: 1000 }, () => "mvt:v1:buildings:d1:z14:x100:y200:qdefault");
    await runScenario(
        "Scenario 1: Hot Tile (1000 requests for 1 key)",
        "1. Hot Tile (100% hits)",
        () => Array.from(hotKeys),
        50
    );

    const makeZipfKeys = () => {
        const zipfKeys: string[] = [];
        for (let i = 0; i < 1000; i++) {
            const tileIdx = Math.random() < 0.8 ? Math.floor(Math.random() * 4) : 4 + Math.floor(Math.random() * 16);
            zipfKeys.push(`mvt:v1:buildings:d1:z14:x${tileIdx}:y${tileIdx}:qdefault`);
        }
        return zipfKeys;
    };
    await runScenario(
        "Scenario 2: 80/20 Pareto Distribution (1000 requests across 20 tiles)",
        "2. 80/20 Distribution",
        makeZipfKeys,
        25
    );

    const makeStampedeKeys = () => {
        const runId = Math.random().toString(36).slice(2, 8);
        const stampedeKeys: string[] = [];
        for (let k = 0; k < 5; k++) {
            for (let i = 0; i < 100; i++) {
                stampedeKeys.push(`mvt:v1:stampede_${runId}:d1:z14:x${k}:y${k}:qdefault`);
            }
        }
        return stampedeKeys;
    };
    await runScenario(
        "Scenario 3: Stampede Cold Misses (500 parallel requests across 5 cold keys)",
        "3. Stampede Cold Miss",
        makeStampedeKeys,
        100
    );

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
