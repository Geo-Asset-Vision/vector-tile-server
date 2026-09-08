import env from "@/libs/env";
import { rateLimiter } from "@/libs/rate-limiter";
import type { Context, MiddlewareHandler, Next } from "hono";
import { cors } from "hono/cors";

export function createCorsMiddleware(allowedOriginsInput?: string): MiddlewareHandler {
    const corsOrigins = (allowedOriginsInput ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);

    const allowAllOrigins = corsOrigins.includes("*");

    if (allowAllOrigins) {
        return cors({
            origin: "*",
            exposeHeaders: ["Content-Type", "Cache-Control"],
        });
    }

    if (corsOrigins.length > 0) {
        return cors({
            origin: corsOrigins,
            exposeHeaders: ["Content-Type", "Cache-Control"],
        });
    }

    return async (c, next) => {
        const origin = c.req.header("Origin");
        // Same-origin requests carry no Origin header; reject cross-origin browser access
        // when no allowlist is configured so the browser cannot read tile bytes directly.
        if (origin) {
            return c.json({ error: "Forbidden" }, 403);
        }
        await next();
    };
}

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

    const checkResult = await rateLimiter.check(ip);
    if (checkResult.blocked) {
        c.header("Retry-After", String(checkResult.retryAfterSec || 60));
        return c.json({
            error: "Too Many Requests",
            message: "Too many unauthorized attempts. Please try again later.",
            retryAfter: checkResult.retryAfterSec,
        }, 429);
    }

    const authHeader = c.req.header("Authorization");
    const bearerKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
    const apiKey = c.req.header("X-API-Key") || bearerKey || c.req.query("apiKey") || c.req.query("api_key");

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

    await rateLimiter.recordSuccess(ip);

    return next();
}