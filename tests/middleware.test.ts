import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { withAPIKey } from "../src/middleware";
import env from "../src/libs/env";

describe("withAPIKey Middleware", () => {
    it("should allow request through if API_KEY env is not set", async () => {
        const originalKey = env.API_KEY;
        env.API_KEY = "";

        const app = new Hono();
        app.use(withAPIKey);
        app.get("/test", (c) => c.text("OK"));

        const res = await app.request("/test");
        expect(res.status).toBe(200);

        env.API_KEY = originalKey;
    });

    it("should reject request with 401 if API_KEY is set and X-API-Key header is missing", async () => {
        const originalKey = env.API_KEY;
        env.API_KEY = "test-secret-key";

        const app = new Hono();
        app.use(withAPIKey);
        app.get("/test", (c) => c.text("OK"));

        const res = await app.request("/test");
        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json).toEqual({ error: "Unauthorized" });

        env.API_KEY = originalKey;
    });

    it("should reject request with 401 if X-API-Key header is invalid", async () => {
        const originalKey = env.API_KEY;
        env.API_KEY = "test-secret-key";

        const app = new Hono();
        app.use(withAPIKey);
        app.get("/test", (c) => c.text("OK"));

        const res = await app.request("/test", {
            headers: { "X-API-Key": "wrong-key" },
        });
        expect(res.status).toBe(401);

        env.API_KEY = originalKey;
    });

    it("should allow request if X-API-Key header matches env.API_KEY", async () => {
        const originalKey = env.API_KEY;
        env.API_KEY = "test-secret-key";

        const app = new Hono();
        app.use(withAPIKey);
        app.get("/test", (c) => c.text("OK"));

        const res = await app.request("/test", {
            headers: {
                "X-API-Key": "test-secret-key",
                "x-forwarded-for": "10.0.0.1",
            },
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("OK");

        env.API_KEY = originalKey;
    });

    it("should trigger 429 Too Many Requests after exceeding max unauthorized attempts", async () => {
        const originalKey = env.API_KEY;
        const originalMax = env.RATE_LIMIT_MAX_ATTEMPTS;
        env.API_KEY = "test-secret-key";
        env.RATE_LIMIT_MAX_ATTEMPTS = 2;

        const app = new Hono();
        app.use(withAPIKey);
        app.get("/test", (c) => c.text("OK"));

        const headers = { "x-forwarded-for": "192.168.100.1" };

        // 1st failed attempt -> 401
        const res1 = await app.request("/test", { headers });
        expect(res1.status).toBe(401);

        // 2nd failed attempt -> 429 (exceeds max 2 attempts threshold)
        const res2 = await app.request("/test", { headers });
        expect(res2.status).toBe(429);
        expect(res2.headers.get("Retry-After")).toBeTruthy();

        const json2 = await res2.json();
        expect(json2.error).toBe("Too Many Requests");

        // 3rd attempt while blocked -> 429 blocked immediately
        const res3 = await app.request("/test", { headers });
        expect(res3.status).toBe(429);

        env.API_KEY = originalKey;
        env.RATE_LIMIT_MAX_ATTEMPTS = originalMax;
    });
});
