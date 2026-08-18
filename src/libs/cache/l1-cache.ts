import { LRUCache } from "lru-cache";
import { cacheMetrics } from "./metrics";

export interface L1TileCacheOptions {
    maxItems?: number;
    maxSizeMb?: number;
    ttlMs?: number;
    enabled?: boolean;
}

export class L1TileCache {
    private cache: LRUCache<string, Buffer>;
    private enabled: boolean;
    private defaultTtlMs: number;

    constructor(options: L1TileCacheOptions = {}) {
        this.enabled = options.enabled ?? true;
        this.defaultTtlMs = options.ttlMs ?? 60 * 1000; // default 60s

        const maxSizeMb = options.maxSizeMb ?? 256;
        const maxSizeBytes = Math.max(1, Math.floor(maxSizeMb * 1024 * 1024));
        const maxItems = options.maxItems ?? 10000;

        this.cache = new LRUCache<string, Buffer>({
            max: maxItems,
            maxSize: maxSizeBytes,
            sizeCalculation: (value: Buffer) => (value ? value.byteLength : 0),
            ttl: this.defaultTtlMs,
            allowStale: false,
            updateAgeOnGet: true,
        });

        // Register metrics suppliers
        cacheMetrics.registerL1Suppliers(
            () => this.calculatedSize,
            () => this.itemCount
        );
    }

    get isEnabled(): boolean {
        return this.enabled;
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) {
            this.clear();
        }
    }

    /**
     * Total allocated bytes in the LRU cache.
     */
    get calculatedSize(): number {
        return this.cache.calculatedSize;
    }

    /**
     * Total number of stored items in LRU cache.
     */
    get itemCount(): number {
        return this.cache.size;
    }

    /**
     * Retrieve tile Buffer from L1 cache.
     * Returns null if missing or expired.
     */
    get(key: string): Buffer | null {
        if (!this.enabled) {
            return null;
        }

        const value = this.cache.get(key);
        if (value !== undefined) {
            cacheMetrics.recordL1Hit();
            return value;
        }

        cacheMetrics.recordL1Miss();
        return null;
    }

    /**
     * Store tile Buffer into L1 cache with optional custom TTL.
     */
    set(key: string, value: Buffer, ttlMs?: number): void {
        if (!this.enabled || !value) {
            return;
        }

        try {
            this.cache.set(key, value, {
                ttl: ttlMs ?? this.defaultTtlMs,
            });
            cacheMetrics.recordSetSuccess("L1");
        } catch {
            cacheMetrics.recordSetError("L1");
        }
    }

    has(key: string): boolean {
        return this.enabled && this.cache.has(key);
    }

    delete(key: string): boolean {
        return this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }
}
