import env from "@/libs/env";
import { rateLimiter } from "@/libs/rate-limiter";
import type { Context, Next } from "hono";

export function getClientIP(c: Context): string {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) {
        return forwarded.split(",")[0].trim();
    }
    return c.req.header("x-real-ip") || "127.0.0.1";
}

export async function withAPIKey(c: Context, next: Next) {
    if (!env.API_KEY) {
        return next();
    }

    const ip = getClientIP(c);

    // 1. Check if IP is currently blocked due to rate limit
    const checkResult = await rateLimiter.check(ip);
    if (checkResult.blocked) {
        c.header("Retry-After", String(checkResult.retryAfterSec || 60));
        return c.json({
            error: "Too Many Requests",
            message: "Too many unauthorized attempts. Please try again later.",
            retryAfter: checkResult.retryAfterSec,
        }, 429);
    }

    const apiKey = c.req.header("X-API-Key");

    // 2. Validate API Key
    if (!apiKey || apiKey !== env.API_KEY) {
        const failure = await rateLimiter.recordFailure(ip);

        if (failure.blocked) {
            c.header("Retry-After", String(failure.retryAfterSec || 60));
            return c.json({
                error: "Too Many Requests",
                message: "Too many unauthorized attempts. Please try again later.",
                retryAfter: failure.retryAfterSec,
            }, 429);
        }

        return c.json({ error: "Unauthorized" }, 401);
    }

    // 3. Reset strikes/attempts on successful authorization
    await rateLimiter.recordSuccess(ip);

    return next();
}