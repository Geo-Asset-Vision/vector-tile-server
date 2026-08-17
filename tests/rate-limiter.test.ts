import { describe, it, expect, beforeEach } from 'vitest';
import { UnauthorizedRateLimiter, MemoryRateLimitStore } from '../src/libs/rate-limiter';

describe('UnauthorizedRateLimiter Unit Tests', () => {
    let memoryStore: MemoryRateLimitStore;
    let rateLimiter: UnauthorizedRateLimiter;

    beforeEach(() => {
        memoryStore = new MemoryRateLimitStore();
        // Max 3 attempts, base block time 2 seconds for fast testing
        rateLimiter = new UnauthorizedRateLimiter(memoryStore, 3, 2);
    });

    it('should allow requests when IP has no failures', async () => {
        const check = await rateLimiter.check('192.168.1.1');
        expect(check.blocked).toBe(false);
    });

    it('should track failure attempts up to maxAttempts', async () => {
        const ip = '192.168.1.2';

        const fail1 = await rateLimiter.recordFailure(ip);
        expect(fail1.blocked).toBe(false);
        expect(fail1.attempts).toBe(1);

        const fail2 = await rateLimiter.recordFailure(ip);
        expect(fail2.blocked).toBe(false);
        expect(fail2.attempts).toBe(2);
    });

    it('should block IP when maxAttempts threshold is reached and apply exponential backoff', async () => {
        const ip = '192.168.1.3';

        // Attempt 1 & 2
        await rateLimiter.recordFailure(ip);
        await rateLimiter.recordFailure(ip);

        // Attempt 3 -> Strikes 1 -> Blocked for 2 seconds (baseBlockSec * 2^0)
        const fail3 = await rateLimiter.recordFailure(ip);
        expect(fail3.blocked).toBe(true);
        expect(fail3.strikes).toBe(1);
        expect(fail3.retryAfterSec).toBe(2);

        // Immediate check should return blocked
        const check = await rateLimiter.check(ip);
        expect(check.blocked).toBe(true);
        expect(check.retryAfterSec).toBeGreaterThanOrEqual(1);
    });

    it('should escalate block duration exponentially on subsequent strikes', async () => {
        const ip = '192.168.1.4';

        // Strike 1 (3 failed attempts) -> 2s block (2 * 2^0)
        await rateLimiter.recordFailure(ip);
        await rateLimiter.recordFailure(ip);
        const strike1 = await rateLimiter.recordFailure(ip);
        expect(strike1.blocked).toBe(true);
        expect(strike1.retryAfterSec).toBe(2);
        expect(strike1.strikes).toBe(1);

        // Strike 2 (3 failed attempts) -> 4s block (2 * 2^1)
        await rateLimiter.recordFailure(ip);
        await rateLimiter.recordFailure(ip);
        const strike2 = await rateLimiter.recordFailure(ip);
        expect(strike2.blocked).toBe(true);
        expect(strike2.retryAfterSec).toBe(4);
        expect(strike2.strikes).toBe(2);

        // Strike 3 (3 failed attempts) -> 8s block (2 * 2^2)
        await rateLimiter.recordFailure(ip);
        await rateLimiter.recordFailure(ip);
        const strike3 = await rateLimiter.recordFailure(ip);
        expect(strike3.blocked).toBe(true);
        expect(strike3.retryAfterSec).toBe(8);
        expect(strike3.strikes).toBe(3);
    });

    it('should reset failure record and strikes on recordSuccess', async () => {
        const ip = '192.168.1.5';

        await rateLimiter.recordFailure(ip);
        await rateLimiter.recordFailure(ip);

        await rateLimiter.recordSuccess(ip);

        const check = await rateLimiter.check(ip);
        expect(check.blocked).toBe(false);

        const record = await memoryStore.getRecord(ip);
        expect(record).toBeNull();
    });
});
