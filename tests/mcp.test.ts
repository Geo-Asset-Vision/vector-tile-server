import { describe, it, expect } from "vitest";
import { createVectorTileMcpServer } from "@/mcp";
import { latLonToTile, tileToBBox } from "@/mcp/tools/spatial.tools";
import { Hono } from "hono";
import { createMcpRoutes } from "@/mcp/routes";
import env from "@/libs/env";

describe("MCP Server Foundation & Tool Registration", () => {
    it("should initialize McpServer instance with registered tools and resources", () => {
        const server = createVectorTileMcpServer();
        expect(server).toBeDefined();
    });

    it("should correctly convert Lat/Lon to Tile XYZ coordinates", () => {
        // Jakarta, Indonesia (-6.2088, 106.8456) at zoom 10
        const tile = latLonToTile(-6.2088, 106.8456, 10);
        expect(tile.z).toBe(10);
        expect(tile.x).toBe(815);
        expect(tile.y).toBe(529);

        // Clamping check
        const clampedTile = latLonToTile(0, 0, 0);
        expect(clampedTile).toEqual({ z: 0, x: 0, y: 0 });
    });

    it("should correctly calculate BBox from Tile XYZ coordinates", () => {
        const bbox = tileToBBox(10, 815, 529);
        expect(bbox).toHaveLength(4);
        const [minLon, minLat, maxLon, maxLat] = bbox;
        expect(minLon).toBeLessThan(maxLon);
        expect(minLat).toBeLessThan(maxLat);
        expect(minLon).toBeGreaterThan(100);
        expect(maxLon).toBeLessThan(110);
    });

    it("should enforce API Key security on MCP routes when API_KEY is set", async () => {
        const originalKey = env.API_KEY;
        env.API_KEY = "super-secret-mcp-key";

        const app = new Hono();
        app.route("/mcp", createMcpRoutes());

        // 1. Without API key -> 401
        const resUnauth = await app.request("/mcp/messages", { method: "POST" });
        expect(resUnauth.status).toBe(401);

        // 2. With invalid header -> 401
        const resWrong = await app.request("/mcp/messages", {
            method: "POST",
            headers: { "X-API-Key": "wrong-key" },
        });
        expect(resWrong.status).toBe(401);

        // 3. With valid X-API-Key header -> reaches handler (missing sessionId -> 400)
        const resValidHeader = await app.request("/mcp/messages", {
            method: "POST",
            headers: { "X-API-Key": "super-secret-mcp-key" },
        });
        expect(resValidHeader.status).toBe(400);

        // 4. With valid Bearer token -> reaches handler (400)
        const resValidBearer = await app.request("/mcp/messages", {
            method: "POST",
            headers: { Authorization: "Bearer super-secret-mcp-key" },
        });
        expect(resValidBearer.status).toBe(400);

        // 5. With valid query param (?apiKey=...) -> reaches handler (400)
        const resValidQuery = await app.request("/mcp/messages?apiKey=super-secret-mcp-key", {
            method: "POST",
        });
        expect(resValidQuery.status).toBe(400);

        env.API_KEY = originalKey;
    });
});
