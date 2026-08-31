import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { openAPIRouteHandler, generateSpecs } from "hono-openapi";
import { createMarkdownFromOpenApi } from "@scalar/openapi-to-markdown";
import appRouter from "../src/routes/index";

describe("OpenAPI & LLMs Markdown Integration Tests", () => {
    const app = new Hono();
    app.route("/", appRouter);

    const openApiDocConfig = {
        documentation: {
            info: {
                title: "Vector Tile Server API",
                version: "1.0.0",
                description: "High-performance PostGIS-backed Vector Tile Server API",
            },
            servers: [
                {
                    url: "http://localhost:3000",
                    description: "Test Environment URL",
                },
            ],
            components: {
                securitySchemes: {
                    API_KEY: {
                        type: "apiKey" as const,
                        in: "header" as const,
                        name: "X-API-Key",
                    },
                },
            },
        },
    };

    app.get("/openapi", openAPIRouteHandler(app, openApiDocConfig));

    app.get("/llms.txt", async (c) => {
        const specs = await generateSpecs(app, openApiDocConfig, c);
        const markdown = await createMarkdownFromOpenApi(specs);
        return c.text(markdown);
    });

    it("GET /openapi returns valid OpenAPI JSON schema", async () => {
        const res = await app.request("/openapi");
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.info.title).toBe("Vector Tile Server API");
        expect(json.paths).toBeDefined();
    });

    it("GET /llms.txt returns valid Markdown representation of API reference", async () => {
        const res = await app.request("/llms.txt");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/plain");
        const text = await res.text();
        expect(text).toContain("# Vector Tile Server API");
        expect(text).toContain("/tiles");
        expect(text).toContain("/catalog");
    });
});
