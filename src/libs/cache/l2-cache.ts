import { ValkeyClient, type ValkeyClientOptions } from "./valkey-client";
import { cacheMetrics } from "./metrics";

export interface L2TileCacheOptions extends ValkeyClientOptions {
    defaultTtlMs?: number;
}

export class L2TileCache {
    private valkey: ValkeyClient;
    private defaultTtlMs: number;
    private enabled: boolean;

    constructor(options: L2TileCacheOptions = {}) {
        this.enabled = options.enabled ?? true;
        this.defaultTtlMs = options.defaultTtlMs ?? 60 * 1000; // default 60s
        this.valkey = new ValkeyClient(options);
    }

    get isConfiguredAndEnabled(): boolean {
        return this.enabled && this.valkey.isConfiguredAndEnabled;
    }

    get isConnected(): boolean {
        return this.valkey.isClientConnected;
    }

    get circuitState(): string {
        return this.valkey.getCircuitState();
    }

    async connect(): Promise<boolean> {
        if (!this.enabled) return false;
        return this.valkey.connect();
    }

    async disconnect(): Promise<void> {
        return this.valkey.disconnect();
    }

    /**
     * Retrieve binary tile Buffer from Valkey L2 cache.
     * Returns null on miss or when Valkey is unavailable.
     */
    async get(key: string): Promise<Buffer | null> {
        if (!this.enabled || !this.valkey.isConfiguredAndEnabled) {
            return null;
        }

        try {
            const buf = await this.valkey.getBuffer(key);
            if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
                cacheMetrics.recordL2Hit();
                return buf;
            }
            cacheMetrics.recordL2Miss();
            return null;
        } catch {
            cacheMetrics.recordGetError("L2");
            return null;
        }
    }

    /**
     * Store binary tile Buffer into Valkey L2 cache.
     * Non-blocking error handling to ensure tile delivery is never stalled.
     */
    async set(key: string, value: Buffer, ttlMs?: number): Promise<boolean> {
        if (!this.enabled || !this.valkey.isConfiguredAndEnabled || !value) {
            return false;
        }

        try {
            const finalTtl = ttlMs ?? this.defaultTtlMs;
            const success = await this.valkey.setBuffer(key, value, finalTtl);
            if (success) {
                cacheMetrics.recordSetSuccess("L2");
            } else {
                cacheMetrics.recordSetError("L2");
            }
            return success;
        } catch {
            cacheMetrics.recordSetError("L2");
            return false;
        }
    }

    async delete(key: string): Promise<boolean> {
        if (!this.enabled || !this.valkey.isConfiguredAndEnabled) {
            return false;
        }
        return this.valkey.del(key);
    }
}
