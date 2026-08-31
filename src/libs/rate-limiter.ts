import env from '@/libs/env';
import Redis from 'ioredis';
import { LRUCache } from 'lru-cache';

export interface RateLimitRecord {
    attempts: number;
    strikes: number;
    blockedUntil?: number;
}

export interface RateLimitStore {
    getRecord(ip: string): Promise<RateLimitRecord | null>;
    setRecord(ip: string, record: RateLimitRecord, ttlMs: number): Promise<void>;
    reset(ip: string): Promise<void>;
}

export class MemoryRateLimitStore implements RateLimitStore {
    private cache: LRUCache<string, RateLimitRecord>;

    constructor(maxItems = 5000) {
        this.cache = new LRUCache<string, RateLimitRecord>({
            max: maxItems,
        });
    }

    async getRecord(ip: string): Promise<RateLimitRecord | null> {
        return this.cache.get(ip) || null;
    }

    async setRecord(ip: string, record: RateLimitRecord, ttlMs: number): Promise<void> {
        this.cache.set(ip, record, { ttl: ttlMs });
    }

    async reset(ip: string): Promise<void> {
        this.cache.delete(ip);
    }
}

export class ValkeyRateLimitStore implements RateLimitStore {
    private client: Redis;
    private fallbackStore: MemoryRateLimitStore;
    private isConnected = false;

    constructor() {
        this.fallbackStore = new MemoryRateLimitStore();

        if (env.VALKEY_URL) {
            this.client = new Redis(env.VALKEY_URL, {
                lazyConnect: true,
                maxRetriesPerRequest: 1,
                enableOfflineQueue: false,
            });
        } else {
            this.client = new Redis({
                host: env.VALKEY_HOST || 'localhost',
                port: env.VALKEY_PORT || 6379,
                password: env.VALKEY_PASSWORD || undefined,
                lazyConnect: true,
                maxRetriesPerRequest: 1,
                enableOfflineQueue: false,
            });
        }

        this.client.on('connect', () => {
            this.isConnected = true;
        });

        this.client.on('error', (err) => {
            if (this.isConnected) {
                console.warn(`[VALKEY] => Connection error: ${err.message}. Falling back to MemoryStore.`);
            }
            this.isConnected = false;
        });
    }

    async connect(): Promise<boolean> {
        try {
            await this.client.connect();
            this.isConnected = true;
            console.log('[VALKEY] => Connected successfully to Valkey/KeyDB server.');
            return true;
        } catch (err) {
            console.warn(`[VALKEY] => Failed to connect to Valkey server: ${(err as Error).message}. Falling back to MemoryStore.`);
            this.isConnected = false;
            return false;
        }
    }

    get isValkeyConnected(): boolean {
        return this.isConnected;
    }

    async disconnect(): Promise<void> {
        if (this.isConnected) {
            await this.client.quit();
            this.isConnected = false;
        }
    }

    async getRecord(ip: string): Promise<RateLimitRecord | null> {
        if (!this.isConnected) {
            return this.fallbackStore.getRecord(ip);
        }
        try {
            const data = await this.client.get(`rate_limit:unauth:${ip}`);
            if (!data) return null;
            return JSON.parse(data) as RateLimitRecord;
        } catch {
            return this.fallbackStore.getRecord(ip);
        }
    }

    async setRecord(ip: string, record: RateLimitRecord, ttlMs: number): Promise<void> {
        if (!this.isConnected) {
            return this.fallbackStore.setRecord(ip, record, ttlMs);
        }
        try {
            const key = `rate_limit:unauth:${ip}`;
            await this.client.set(key, JSON.stringify(record), 'PX', ttlMs);
        } catch {
            await this.fallbackStore.setRecord(ip, record, ttlMs);
        }
    }

    async reset(ip: string): Promise<void> {
        if (!this.isConnected) {
            return this.fallbackStore.reset(ip);
        }
        try {
            await this.client.del(`rate_limit:unauth:${ip}`);
        } catch {
            await this.fallbackStore.reset(ip);
        }
    }
}

export class UnauthorizedRateLimiter {
    private store: RateLimitStore;
    private maxAttempts?: number;
    private baseBlockSec?: number;

    constructor(
        store?: RateLimitStore,
        maxAttempts?: number,
        baseBlockSec?: number
    ) {
        this.maxAttempts = maxAttempts;
        this.baseBlockSec = baseBlockSec;

        if (store) {
            this.store = store;
        } else if (env.VALKEY_HOST || env.VALKEY_URL) {
            const valkeyStore = new ValkeyRateLimitStore();
            valkeyStore.connect().catch(() => {});
            this.store = valkeyStore;
        } else {
            this.store = new MemoryRateLimitStore();
        }
    }

    async check(ip: string): Promise<{ blocked: boolean; retryAfterSec?: number }> {
        const record = await this.store.getRecord(ip);
        if (!record || !record.blockedUntil) {
            return { blocked: false };
        }

        const now = Date.now();
        if (now < record.blockedUntil) {
            const retryAfterSec = Math.max(1, Math.ceil((record.blockedUntil - now) / 1000));
            return { blocked: true, retryAfterSec };
        }

        return { blocked: false };
    }

    async recordFailure(
        ip: string,
        maxAttempts = this.maxAttempts ?? env.RATE_LIMIT_MAX_ATTEMPTS,
        baseBlockSec = this.baseBlockSec ?? env.RATE_LIMIT_BASE_BLOCK_SEC
    ): Promise<{ blocked: boolean; retryAfterSec?: number; attempts: number; strikes: number }> {
        const record = (await this.store.getRecord(ip)) || { attempts: 0, strikes: 0 };
        const now = Date.now();

        // If previous block expired, keep strikes but increment attempts
        const attempts = record.attempts + 1;
        let strikes = record.strikes;
        let blockedUntil: number | undefined = undefined;
        let retryAfterSec: number | undefined = undefined;

        if (attempts >= maxAttempts) {
            strikes += 1;
            // Exponential backoff: baseBlockSec * 2^(strikes - 1), capped at strike 10 (1024x)
            const exponent = Math.min(strikes - 1, 10);
            const blockSec = baseBlockSec * Math.pow(2, exponent);

            blockedUntil = now + blockSec * 1000;
            retryAfterSec = blockSec;

            const updatedRecord: RateLimitRecord = {
                attempts: 0, // Reset attempt counter for next cycle
                strikes,
                blockedUntil,
            };

            // Keep record in store until block expires + 24 hours retention
            const ttlMs = blockSec * 1000 + 24 * 60 * 60 * 1000;
            await this.store.setRecord(ip, updatedRecord, ttlMs);

            return { blocked: true, retryAfterSec, attempts: 0, strikes };
        }

        const updatedRecord: RateLimitRecord = {
            attempts,
            strikes,
            blockedUntil: undefined,
        };

        // Standard attempt window retention: 1 hour
        await this.store.setRecord(ip, updatedRecord, 60 * 60 * 1000);
        return { blocked: false, attempts, strikes };
    }

    async recordSuccess(ip: string): Promise<void> {
        await this.store.reset(ip);
    }

    async disconnect(): Promise<void> {
        if (this.store instanceof ValkeyRateLimitStore) {
            await this.store.disconnect();
        }
    }
}

export const rateLimiter = new UnauthorizedRateLimiter();
