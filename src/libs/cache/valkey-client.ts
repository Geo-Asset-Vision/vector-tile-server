import Redis, { type RedisOptions } from "ioredis";
import { cacheMetrics } from "./metrics";

export type CircuitState = "HEALTHY" | "DEGRADED" | "PROBING";

export interface ValkeyClientOptions {
    host?: string;
    port?: number;
    password?: string;
    url?: string;
    enabled?: boolean;
    connectTimeoutMs?: number;
    commandTimeoutMs?: number;
    failThreshold?: number;
    cooldownMs?: number;
}

export class ValkeyClient {
    private client: Redis | null = null;
    private enabled: boolean;
    private isConnected = false;
    private isConnecting = false;

    // Circuit Breaker State
    private circuitState: CircuitState = "HEALTHY";
    private consecutiveFailures = 0;
    private nextProbeTime = 0;
    private readonly failThreshold: number;
    private readonly cooldownMs: number;
    private readonly commandTimeoutMs: number;
    private readonly connectTimeoutMs: number;

    constructor(options: ValkeyClientOptions = {}) {
        const isConfigured = Boolean(options.url || options.host);
        this.enabled = (options.enabled ?? true) && isConfigured;

        this.failThreshold = options.failThreshold ?? 3;
        this.cooldownMs = options.cooldownMs ?? 10000;
        this.commandTimeoutMs = options.commandTimeoutMs ?? 500;
        this.connectTimeoutMs = options.connectTimeoutMs ?? 1000;

        if (this.enabled) {
            const redisOpts: RedisOptions = {
                lazyConnect: true,
                maxRetriesPerRequest: 1,
                enableOfflineQueue: false,
                connectTimeout: this.connectTimeoutMs,
                retryStrategy: (times) => {
                    // Exponential reconnect backoff up to 2 seconds
                    return Math.min(times * 100, 2000);
                },
            };

            if (options.url) {
                this.client = new Redis(options.url, redisOpts);
            } else {
                this.client = new Redis({
                    host: options.host || "localhost",
                    port: options.port || 6379,
                    password: options.password || undefined,
                    ...redisOpts,
                });
            }

            this.client.on("connect", () => {
                this.isConnected = true;
                this.onSuccess();
            });

            this.client.on("ready", () => {
                this.isConnected = true;
                this.onSuccess();
            });

            this.client.on("error", (err: Error) => {
                if (this.isConnected) {
                    console.warn(`[VALKEY CACHE] => Connection error: ${err.message}. Cache operations degraded.`);
                }
                this.isConnected = false;
                this.onFailure();
            });

            this.client.on("close", () => {
                this.isConnected = false;
            });
        }

        // Register circuit state supplier
        cacheMetrics.registerCircuitStateSupplier(() => this.getCircuitState());
    }

    get isConfiguredAndEnabled(): boolean {
        return this.enabled && this.client !== null;
    }

    get isClientConnected(): boolean {
        return this.isConnected;
    }

    getCircuitState(): CircuitState {
        if (!this.isConfiguredAndEnabled) {
            return "DEGRADED";
        }
        if (this.circuitState === "DEGRADED" && Date.now() >= this.nextProbeTime) {
            this.circuitState = "PROBING";
        }
        return this.circuitState;
    }

    private onSuccess(): void {
        this.consecutiveFailures = 0;
        this.circuitState = "HEALTHY";
    }

    private onFailure(): void {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.failThreshold) {
            if (this.circuitState !== "DEGRADED") {
                this.circuitState = "DEGRADED";
                this.nextProbeTime = Date.now() + this.cooldownMs;
            }
        }
    }

    async connect(): Promise<boolean> {
        if (!this.isConfiguredAndEnabled || !this.client) {
            return false;
        }
        if (this.isConnected) {
            return true;
        }
        if (this.isConnecting) {
            return false;
        }

        this.isConnecting = true;
        try {
            await this.client.connect();
            this.isConnected = true;
            this.onSuccess();
            console.log("[VALKEY CACHE] => Connected successfully to Valkey/Redis cache server.");
            return true;
        } catch (err) {
            console.warn(
                `[VALKEY CACHE] => Failed to connect to Valkey server: ${(err as Error).message}. L2 cache disabled.`
            );
            this.isConnected = false;
            this.onFailure();
            return false;
        } finally {
            this.isConnecting = false;
        }
    }

    async disconnect(): Promise<void> {
        if (this.client && this.isConnected) {
            try {
                await this.client.quit();
            } catch {
                this.client.disconnect();
            } finally {
                this.isConnected = false;
            }
        }
    }

    /**
     * Execute a Valkey operation with command timeout and circuit breaker protection.
     */
    private async executeWithTimeout<T>(operation: (client: Redis) => Promise<T>): Promise<T | null> {
        if (!this.isConfiguredAndEnabled || !this.client) {
            return null;
        }

        const state = this.getCircuitState();
        if (state === "DEGRADED") {
            return null; // Fast failover without waiting
        }

        const startTime = Date.now();
        let timeoutHandle: NodeJS.Timeout | null = null;

        try {
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new Error(`Valkey command timed out after ${this.commandTimeoutMs}ms`));
                }, this.commandTimeoutMs);
            });

            const result = await Promise.race([operation(this.client), timeoutPromise]);

            if (timeoutHandle) clearTimeout(timeoutHandle);
            this.onSuccess();

            const latency = Date.now() - startTime;
            cacheMetrics.recordValkeyLatency(latency);

            return result;
        } catch {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            this.onFailure();
            return null;
        }
    }

    /**
     * Binary-safe GET returning Buffer.
     */
    async getBuffer(key: string): Promise<Buffer | null> {
        return this.executeWithTimeout<Buffer | null>(async (client) => {
            // ioredis getBuffer returns Buffer | null
            const buf = await client.getBuffer(key);
            return buf && Buffer.isBuffer(buf) ? buf : null;
        });
    }

    /**
     * Binary-safe SET storing raw Buffer with millisecond TTL.
     */
    async setBuffer(key: string, value: Buffer, ttlMs: number): Promise<boolean> {
        const res = await this.executeWithTimeout<string | null>(async (client) => {
            return client.set(key, value, "PX", ttlMs);
        });
        return res === "OK";
    }

    /**
     * Delete key from Valkey.
     */
    async del(key: string): Promise<boolean> {
        const res = await this.executeWithTimeout<number>(async (client) => {
            return client.del(key);
        });
        return Boolean(res && res > 0);
    }
}
