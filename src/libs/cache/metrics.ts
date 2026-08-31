export interface CacheMetricsSnapshot {
    l1Hits: number;
    l1Misses: number;
    l1HitRatio: number;
    l2Hits: number;
    l2Misses: number;
    l2HitRatio: number;
    totalRequests: number;
    overallHitRatio: number;
    bypassCount: number;
    setSuccessL1: number;
    setSuccessL2: number;
    setErrorL1: number;
    setErrorL2: number;
    getErrorL1: number;
    getErrorL2: number;
    singleFlightExecutions: number;
    singleFlightWaiters: number;
    computeTotal: number;
    computeTotalDurationSeconds: number;
    computeAvgDurationMs: number;
    valkeyLatencyTotalSeconds: number;
    valkeyLatencyAvgMs: number;
    l1SizeBytes: number;
    l1Items: number;
    l2CircuitState?: string;
}

export class CacheMetrics {
    private l1Hits = 0;
    private l1Misses = 0;
    private l2Hits = 0;
    private l2Misses = 0;
    private bypassCount = 0;

    private setSuccessL1 = 0;
    private setSuccessL2 = 0;
    private setErrorL1 = 0;
    private setErrorL2 = 0;

    private getErrorL1 = 0;
    private getErrorL2 = 0;

    private singleFlightExecutions = 0;
    private singleFlightWaiters = 0;

    private computeTotal = 0;
    private computeTotalDurationMs = 0;

    private valkeyCalls = 0;
    private valkeyTotalLatencyMs = 0;

    // Supplier functions for dynamic gauge metrics (e.g. L1 cache size/count, circuit state)
    private l1SizeSupplier: () => number = () => 0;
    private l1ItemsSupplier: () => number = () => 0;
    private circuitStateSupplier: () => string = () => "UNKNOWN";

    registerL1Suppliers(sizeSupplier: () => number, itemsSupplier: () => number): void {
        this.l1SizeSupplier = sizeSupplier;
        this.l1ItemsSupplier = itemsSupplier;
    }

    registerCircuitStateSupplier(supplier: () => string): void {
        this.circuitStateSupplier = supplier;
    }

    recordL1Hit(): void {
        this.l1Hits++;
    }

    recordL1Miss(): void {
        this.l1Misses++;
    }

    recordL2Hit(): void {
        this.l2Hits++;
    }

    recordL2Miss(): void {
        this.l2Misses++;
    }

    recordBypass(): void {
        this.bypassCount++;
    }

    recordSetSuccess(level: "L1" | "L2"): void {
        if (level === "L1") this.setSuccessL1++;
        else this.setSuccessL2++;
    }

    recordSetError(level: "L1" | "L2"): void {
        if (level === "L1") this.setErrorL1++;
        else this.setErrorL2++;
    }

    recordGetError(level: "L1" | "L2"): void {
        if (level === "L1") this.getErrorL1++;
        else this.getErrorL2++;
    }

    recordSingleFlightExecution(): void {
        this.singleFlightExecutions++;
    }

    recordSingleFlightWaiter(): void {
        this.singleFlightWaiters++;
    }

    recordCompute(durationMs: number): void {
        this.computeTotal++;
        this.computeTotalDurationMs += durationMs;
    }

    recordValkeyLatency(durationMs: number): void {
        this.valkeyCalls++;
        this.valkeyTotalLatencyMs += durationMs;
    }

    getSnapshot(): CacheMetricsSnapshot {
        const totalL1Lookups = this.l1Hits + this.l1Misses;
        const l1HitRatio = totalL1Lookups > 0 ? this.l1Hits / totalL1Lookups : 0;

        const totalL2Lookups = this.l2Hits + this.l2Misses;
        const l2HitRatio = totalL2Lookups > 0 ? this.l2Hits / totalL2Lookups : 0;

        const totalRequests = this.l1Hits + this.l2Hits + this.computeTotal + this.bypassCount;
        const totalHits = this.l1Hits + this.l2Hits;
        const overallHitRatio = totalRequests > 0 ? totalHits / totalRequests : 0;

        const computeAvgDurationMs =
            this.computeTotal > 0 ? this.computeTotalDurationMs / this.computeTotal : 0;

        const valkeyLatencyAvgMs =
            this.valkeyCalls > 0 ? this.valkeyTotalLatencyMs / this.valkeyCalls : 0;

        return {
            l1Hits: this.l1Hits,
            l1Misses: this.l1Misses,
            l1HitRatio: Number(l1HitRatio.toFixed(4)),
            l2Hits: this.l2Hits,
            l2Misses: this.l2Misses,
            l2HitRatio: Number(l2HitRatio.toFixed(4)),
            totalRequests,
            overallHitRatio: Number(overallHitRatio.toFixed(4)),
            bypassCount: this.bypassCount,
            setSuccessL1: this.setSuccessL1,
            setSuccessL2: this.setSuccessL2,
            setErrorL1: this.setErrorL1,
            setErrorL2: this.setErrorL2,
            getErrorL1: this.getErrorL1,
            getErrorL2: this.getErrorL2,
            singleFlightExecutions: this.singleFlightExecutions,
            singleFlightWaiters: this.singleFlightWaiters,
            computeTotal: this.computeTotal,
            computeTotalDurationSeconds: Number((this.computeTotalDurationMs / 1000).toFixed(4)),
            computeAvgDurationMs: Number(computeAvgDurationMs.toFixed(2)),
            valkeyLatencyTotalSeconds: Number((this.valkeyTotalLatencyMs / 1000).toFixed(4)),
            valkeyLatencyAvgMs: Number(valkeyLatencyAvgMs.toFixed(2)),
            l1SizeBytes: this.l1SizeSupplier(),
            l1Items: this.l1ItemsSupplier(),
            l2CircuitState: this.circuitStateSupplier(),
        };
    }

    toPrometheus(): string {
        const s = this.getSnapshot();
        return [
            "# HELP mvt_cache_l1_hits_total Total number of L1 cache hits",
            "# TYPE mvt_cache_l1_hits_total counter",
            `mvt_cache_l1_hits_total ${s.l1Hits}`,
            "",
            "# HELP mvt_cache_l1_misses_total Total number of L1 cache misses",
            "# TYPE mvt_cache_l1_misses_total counter",
            `mvt_cache_l1_misses_total ${s.l1Misses}`,
            "",
            "# HELP mvt_cache_l2_hits_total Total number of L2 cache hits",
            "# TYPE mvt_cache_l2_hits_total counter",
            `mvt_cache_l2_hits_total ${s.l2Hits}`,
            "",
            "# HELP mvt_cache_l2_misses_total Total number of L2 cache misses",
            "# TYPE mvt_cache_l2_misses_total counter",
            `mvt_cache_l2_misses_total ${s.l2Misses}`,
            "",
            "# HELP mvt_cache_bypass_total Total number of cache bypass requests",
            "# TYPE mvt_cache_bypass_total counter",
            `mvt_cache_bypass_total ${s.bypassCount}`,
            "",
            "# HELP mvt_cache_set_success_total Total successful cache writes",
            "# TYPE mvt_cache_set_success_total counter",
            `mvt_cache_set_success_total{level="L1"} ${s.setSuccessL1}`,
            `mvt_cache_set_success_total{level="L2"} ${s.setSuccessL2}`,
            "",
            "# HELP mvt_cache_set_error_total Total failed cache writes",
            "# TYPE mvt_cache_set_error_total counter",
            `mvt_cache_set_error_total{level="L1"} ${s.setErrorL1}`,
            `mvt_cache_set_error_total{level="L2"} ${s.setErrorL2}`,
            "",
            "# HELP mvt_cache_get_error_total Total cache read errors",
            "# TYPE mvt_cache_get_error_total counter",
            `mvt_cache_get_error_total{level="L1"} ${s.getErrorL1}`,
            `mvt_cache_get_error_total{level="L2"} ${s.getErrorL2}`,
            "",
            "# HELP mvt_cache_singleflight_total Total single-flight executions",
            "# TYPE mvt_cache_singleflight_total counter",
            `mvt_cache_singleflight_total ${s.singleFlightExecutions}`,
            "",
            "# HELP mvt_cache_singleflight_waiters_total Total requests coalesced via single-flight",
            "# TYPE mvt_cache_singleflight_waiters_total counter",
            `mvt_cache_singleflight_waiters_total ${s.singleFlightWaiters}`,
            "",
            "# HELP mvt_cache_compute_total Total database tile computations",
            "# TYPE mvt_cache_compute_total counter",
            `mvt_cache_compute_total ${s.computeTotal}`,
            "",
            "# HELP mvt_cache_compute_duration_seconds Total time spent computing tiles from PostGIS",
            "# TYPE mvt_cache_compute_duration_seconds counter",
            `mvt_cache_compute_duration_seconds ${s.computeTotalDurationSeconds}`,
            "",
            "# HELP mvt_cache_l1_size_bytes Current memory usage of L1 cache in bytes",
            "# TYPE mvt_cache_l1_size_bytes gauge",
            `mvt_cache_l1_size_bytes ${s.l1SizeBytes}`,
            "",
            "# HELP mvt_cache_l1_items Current number of items in L1 cache",
            "# TYPE mvt_cache_l1_items gauge",
            `mvt_cache_l1_items ${s.l1Items}`,
            "",
            "# HELP mvt_cache_valkey_latency_seconds Total Valkey operation latency in seconds",
            "# TYPE mvt_cache_valkey_latency_seconds counter",
            `mvt_cache_valkey_latency_seconds ${s.valkeyLatencyTotalSeconds}`,
            "",
        ].join("\n");
    }

    reset(): void {
        this.l1Hits = 0;
        this.l1Misses = 0;
        this.l2Hits = 0;
        this.l2Misses = 0;
        this.bypassCount = 0;
        this.setSuccessL1 = 0;
        this.setSuccessL2 = 0;
        this.setErrorL1 = 0;
        this.setErrorL2 = 0;
        this.getErrorL1 = 0;
        this.getErrorL2 = 0;
        this.singleFlightExecutions = 0;
        this.singleFlightWaiters = 0;
        this.computeTotal = 0;
        this.computeTotalDurationMs = 0;
        this.valkeyCalls = 0;
        this.valkeyTotalLatencyMs = 0;
    }
}

export const cacheMetrics = new CacheMetrics();
