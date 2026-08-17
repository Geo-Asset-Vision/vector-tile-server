import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ValkeyRateLimitStore, UnauthorizedRateLimiter } from '../src/libs/rate-limiter';
import env from '../src/libs/env';

describe('ValkeyRateLimitStore Integration Tests', () => {
    let valkeyStore: ValkeyRateLimitStore;
    let rateLimiter: UnauthorizedRateLimiter;
    const testIp = '10.200.0.99';

    beforeAll(async () => {
        env.VALKEY_HOST = 'localhost';
        env.VALKEY_PORT = 6379;

        valkeyStore = new ValkeyRateLimitStore();
        const connected = await valkeyStore.connect();

        // Ensure connection to live Valkey instance succeeds and is not skipped
        expect(connected).toBe(true);
        expect(valkeyStore.isValkeyConnected).toBe(true);

        rateLimiter = new UnauthorizedRateLimiter(valkeyStore, 3, 2);
    });

    afterAll(async () => {
        if (valkeyStore) {
            await valkeyStore.reset(testIp);
            await valkeyStore.disconnect();
        }
    });

    it('should connect to Valkey container successfully and return active connection status', () => {
        expect(valkeyStore.isValkeyConnected).toBe(true);
    });

    it('should record failures in Valkey store', async () => {
        await valkeyStore.reset(testIp);

        const fail1 = await rateLimiter.recordFailure(testIp);
        expect(fail1.blocked).toBe(false);
        expect(fail1.attempts).toBe(1);

        const record = await valkeyStore.getRecord(testIp);
        expect(record).not.toBeNull();
        expect(record?.attempts).toBe(1);
    });

    it('should enforce blocking and exponential backoff via Valkey store', async () => {
        // Attempt 2
        await rateLimiter.recordFailure(testIp);

        // Attempt 3 -> Threshold (3 attempts) reached -> Strike 1 -> Blocked for 2 seconds
        const fail3 = await rateLimiter.recordFailure(testIp);
        expect(fail3.blocked).toBe(true);
        expect(fail3.strikes).toBe(1);
        expect(fail3.retryAfterSec).toBe(2);

        // Check block state from Valkey
        const check = await rateLimiter.check(testIp);
        expect(check.blocked).toBe(true);
        expect(check.retryAfterSec).toBeGreaterThanOrEqual(1);

        const record = await valkeyStore.getRecord(testIp);
        expect(record?.strikes).toBe(1);
        expect(record?.blockedUntil).toBeGreaterThan(Date.now());
    });

    it('should reset rate limit record in Valkey upon recordSuccess', async () => {
        await rateLimiter.recordSuccess(testIp);

        const check = await rateLimiter.check(testIp);
        expect(check.blocked).toBe(false);

        const record = await valkeyStore.getRecord(testIp);
        expect(record).toBeNull();
    });
});
