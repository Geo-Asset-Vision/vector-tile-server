import { describe, it, expect, beforeEach } from "vitest";
import { CacheMetrics } from "../src/libs/cache/metrics";

describe("Cache Metrics Collector Tests", () => {
    let metrics: CacheMetrics;

    beforeEach(() => {
        metrics = new CacheMetrics();
        metrics.registerL1Suppliers(
            () => 1024 * 50,
            () => 25
        );
        metrics.registerCircuitStateSupplier(() => "HEALTHY");
    });

    it("should correctly record and calculate hit ratios", () => {
        // 80 L1 hits, 20 L1 misses
        for (let i = 0; i < 80; i++) metrics.recordL1Hit();
        for (let i = 0; i < 20; i++) metrics.recordL1Miss();

        // Of the 20 L1 misses -> 10 L2 hits, 10 L2 misses
        for (let i = 0; i < 10; i++) metrics.recordL2Hit();
        for (let i = 0; i < 10; i++) metrics.recordL2Miss();

        // 10 DB computes
        for (let i = 0; i < 10; i++) metrics.recordCompute(50);

        const snapshot = metrics.getSnapshot();

        expect(snapshot.l1Hits).toBe(80);
        expect(snapshot.l1Misses).toBe(20);
        expect(snapshot.l1HitRatio).toBe(0.8);

        expect(snapshot.l2Hits).toBe(10);
        expect(snapshot.l2Misses).toBe(10);
        expect(snapshot.l2HitRatio).toBe(0.5);

        expect(snapshot.overallHitRatio).toBe(0.9); // (80 + 10) / (80 + 10 + 10)
        expect(snapshot.computeTotal).toBe(10);
        expect(snapshot.computeAvgDurationMs).toBe(50);
        expect(snapshot.l1SizeBytes).toBe(51200);
        expect(snapshot.l1Items).toBe(25);
        expect(snapshot.l2CircuitState).toBe("HEALTHY");
    });

    it("should generate valid Prometheus text format output", () => {
        metrics.recordL1Hit();
        metrics.recordL1Miss();
        metrics.recordL2Hit();
        metrics.recordSetSuccess("L1");
        metrics.recordSetSuccess("L2");
        metrics.recordSingleFlightExecution();
        metrics.recordSingleFlightWaiter();

        const prom = metrics.toPrometheus();

        expect(prom).toContain("# HELP mvt_cache_l1_hits_total");
        expect(prom).toContain("mvt_cache_l1_hits_total 1");
        expect(prom).toContain("mvt_cache_l1_misses_total 1");
        expect(prom).toContain("mvt_cache_l2_hits_total 1");
        expect(prom).toContain('mvt_cache_set_success_total{level="L1"} 1');
        expect(prom).toContain('mvt_cache_set_success_total{level="L2"} 1');
        expect(prom).toContain("mvt_cache_singleflight_total 1");
        expect(prom).toContain("mvt_cache_singleflight_waiters_total 1");
        expect(prom).toContain("mvt_cache_l1_size_bytes 51200");
    });
});
