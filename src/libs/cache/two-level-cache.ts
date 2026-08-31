import crypto from "node:crypto";
import { L1TileCache, type L1TileCacheOptions } from "./l1-cache";
import { L2TileCache, type L2TileCacheOptions } from "./l2-cache";
import { SingleFlight } from "./single-flight";
import { cacheMetrics } from "./metrics";

export type TileCacheSource = "L1" | "L2" | "MISS" | "BYPASS";

export interface TileCacheResult {
    data: Buffer;
    source: TileCacheSource;
    eTag: string;
    isEmpty: boolean;
}

export interface TwoLevelCacheOptions {
    enabled?: boolean;
    l1Options?: L1TileCacheOptions;
    l2Options?: L2TileCacheOptions;
    l1TtlSeconds?: number;
    l2TtlSeconds?: number;
    emptyTtlSeconds?: number;
    ttlJitterSeconds?: number;
    singleFlightEnabled?: boolean;
}

export interface GetOrComputeOptions {
    bypass?: boolean;
    customL1TtlSeconds?: number;
    customL2TtlSeconds?: number;
}

/**
 * Fast and deterministic ETag generation for MVT buffers.
 */
export function generateTileETag(buffer: Buffer): string {
    if (!buffer || buffer.length === 0) {
        return 'W/"0-empty"';
    }
    const hash = crypto.createHash("md5").update(buffer).digest("hex").slice(0, 16);
    return `W/"${buffer.length}-${hash}"`;
}

/**
 * TwoLevelTileCache orchestrates L1 (Process LRU) -> L2 (Valkey) -> Single-Flight -> Database computation.
 */
export class TwoLevelTileCache {
    private l1: L1TileCache;
    private l2: L2TileCache;
    private singleFlight: SingleFlight<Buffer>;
    private enabled: boolean;
    private l1TtlMs: number;
    private l2TtlMs: number;
    private emptyTtlMs: number;
    private ttlJitterMs: number;
    private singleFlightEnabled: boolean;

    constructor(options: TwoLevelCacheOptions = {}) {
        this.enabled = options.enabled ?? true;
        this.singleFlightEnabled = options.singleFlightEnabled ?? true;

        const baseL1Ttl = options.l1TtlSeconds ?? 60; // 1 minute default
        const baseL2Ttl = options.l2TtlSeconds ?? 60; // 1 minute default
        const emptyTtl = options.emptyTtlSeconds ?? 15;
        const jitter = options.ttlJitterSeconds ?? 10;

        this.l1TtlMs = baseL1Ttl * 1000;
        this.l2TtlMs = baseL2Ttl * 1000;
        this.emptyTtlMs = emptyTtl * 1000;
        this.ttlJitterMs = jitter * 1000;

        this.l1 = new L1TileCache({
            ttlMs: this.l1TtlMs,
            ...options.l1Options,
        });

        this.l2 = new L2TileCache({
            defaultTtlMs: this.l2TtlMs,
            ...options.l2Options,
        });

        this.singleFlight = new SingleFlight<Buffer>();
    }

    get l1Cache(): L1TileCache {
        return this.l1;
    }

    get l2Cache(): L2TileCache {
        return this.l2;
    }

    get isCacheEnabled(): boolean {
        return this.enabled;
    }

    private applyJitter(baseMs: number): number {
        if (this.ttlJitterMs <= 0) return baseMs;
        // Jitter: baseMs ± (random between 0 and ttlJitterMs)
        const delta = Math.floor((Math.random() * 2 - 1) * this.ttlJitterMs);
        return Math.max(1000, baseMs + delta);
    }

    async connect(): Promise<boolean> {
        return this.l2.connect();
    }

    async disconnect(): Promise<void> {
        await this.l2.disconnect();
        this.l1.clear();
        this.singleFlight.clear();
    }

    /**
     * Primary cache interface:
     * 1. Check L1 -> HIT -> return immediately
     * 2. Check L2 -> HIT -> promote to L1 -> return
     * 3. Single-Flight DB query -> SET L1 & L2 -> return
     */
    async getOrCompute(
        key: string,
        compute: () => Promise<Buffer>,
        options: GetOrComputeOptions = {}
    ): Promise<TileCacheResult> {
        // Handle explicit cache bypass
        if (!this.enabled || options.bypass) {
            cacheMetrics.recordBypass();
            const data = await compute();
            const isEmpty = !data || data.length === 0;
            return {
                data,
                source: "BYPASS",
                eTag: generateTileETag(data),
                isEmpty,
            };
        }

        // 1. Check L1 Cache
        const l1Data = this.l1.get(key);
        if (l1Data !== null) {
            const isEmpty = l1Data.length === 0;
            return {
                data: l1Data,
                source: "L1",
                eTag: generateTileETag(l1Data),
                isEmpty,
            };
        }

        // 2. Check L2 Cache (Valkey)
        let l2Data: Buffer | null = null;
        try {
            l2Data = await this.l2.get(key);
        } catch {
            l2Data = null;
        }

        if (l2Data !== null) {
            // Promote to L1 for future sub-millisecond hits
            const l1Ttl = options.customL1TtlSeconds ? options.customL1TtlSeconds * 1000 : this.l1TtlMs;
            this.l1.set(key, l2Data, l1Ttl);

            const isEmpty = l2Data.length === 0;
            return {
                data: l2Data,
                source: "L2",
                eTag: generateTileETag(l2Data),
                isEmpty,
            };
        }

        // 3. Cache MISS: Compute via Single-Flight
        const computeWrapper = async (): Promise<Buffer> => {
            const startTime = Date.now();
            const data = await compute();
            const durationMs = Date.now() - startTime;
            cacheMetrics.recordCompute(durationMs);

            const isEmpty = !data || data.length === 0;
            const bufferToStore = isEmpty ? Buffer.alloc(0) : data;

            // Calculate TTL with jitter or negative TTL for empty tiles
            let l1Ttl: number;
            let l2Ttl: number;

            if (isEmpty) {
                l1Ttl = this.emptyTtlMs;
                l2Ttl = this.emptyTtlMs;
            } else {
                const baseL1 = options.customL1TtlSeconds ? options.customL1TtlSeconds * 1000 : this.l1TtlMs;
                const baseL2 = options.customL2TtlSeconds ? options.customL2TtlSeconds * 1000 : this.l2TtlMs;
                l1Ttl = this.applyJitter(baseL1);
                l2Ttl = this.applyJitter(baseL2);
            }

            // Populate L1 synchronously
            this.l1.set(key, bufferToStore, l1Ttl);

            // Populate L2 asynchronously without blocking or failing the request
            this.l2.set(key, bufferToStore, l2Ttl).catch(() => {
                // Suppress L2 background write errors
            });

            return bufferToStore;
        };

        let resultBuffer: Buffer;
        if (this.singleFlightEnabled) {
            const sfResult = await this.singleFlight.execute(key, computeWrapper);
            resultBuffer = sfResult.value;
        } else {
            resultBuffer = await computeWrapper();
        }

        const isEmpty = !resultBuffer || resultBuffer.length === 0;
        return {
            data: resultBuffer,
            source: "MISS",
            eTag: generateTileETag(resultBuffer),
            isEmpty,
        };
    }
}
