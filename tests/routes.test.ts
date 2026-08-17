import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import appRouter from "../src/routes/index";
import env from "../src/libs/env";
import * as tileService from "../src/services/tile.service";
import * as catalogService from "../src/services/catalog.service";

describe("API Routes Integration Tests", () => {
    const app = new Hono();
    app.route("/", appRouter);

    it("GET /tiles/:catalog_id/:z/:x/:y should reject invalid numeric parameters with 400", async () => {
        const originalKey = env.API_KEY;
        env.API_KEY = "";

        const invalidUrls = [
            "/tiles/buildings/abc/10/20",
            "/tiles/buildings/-1/10/20",
            "/tiles/buildings/31/10/20",
            "/tiles/buildings/14/-5/20",
            "/tiles/buildings/14/10/-5",
        ];

        for (const url of invalidUrls) {
            const res = await app.request(url);
            expect(res.status).toBe(400);
            const json = await res.json();
            expect(json).toHaveProperty("error");
        }

        env.API_KEY = originalKey;
    });

    it("GET /tiles/:catalog_id/:z/:x/:y should reject tile coordinates out of bounds with 400", async () => {
        const originalKey = env.API_KEY;
        env.API_KEY = "";

        // At zoom z=2, max coordinate is 2^2 = 4 (valid coords: 0, 1, 2, 3)
        const res = await app.request("/tiles/buildings/2/4/0");
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toContain("out of bounds");

        env.API_KEY = originalKey;
    });

    it("GET /tiles/:catalog_id/:z/:x/:y should strip .mvt or .pbf extension from y parameter", async () => {
        const originalKey = env.API_KEY;
        env.API_KEY = "";

        const spy = vi.spyOn(tileService, "getTile").mockResolvedValueOnce({
            ok: true,
            data: Buffer.from("mock-mvt"),
            contentType: "application/vnd.mapbox-vector-tile",
        });

        const res = await app.request("/tiles/buildings/14/100/200.mvt");
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({
                catalogId: "buildings",
                z: 14,
                x: 100,
                y: 200,
            })
        );

        spy.mockRestore();
        env.API_KEY = originalKey;
    });

    it("GET /catalog/:catalog_id should return TileJSON detail when item exists", async () => {
        const originalKey = env.API_KEY;
        env.API_KEY = "";

        const mockTileJson = {
            tilejson: "3.0.0",
            name: "public.buildings",
            tiles: ["http://localhost:3000/tiles/public.buildings/{z}/{x}/{y}"],
            vector_layers: [],
        };

        const spy = vi.spyOn(catalogService, "getTileJSONDetail").mockResolvedValueOnce(mockTileJson as any);

        const res = await app.request("/catalog/public.buildings");
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.name).toBe("public.buildings");

        spy.mockRestore();
        env.API_KEY = originalKey;
    });

    it("GET /catalog/:catalog_id should return 404 if spatial item is not found", async () => {
        const originalKey = env.API_KEY;
        env.API_KEY = "";

        const spy = vi.spyOn(catalogService, "getTileJSONDetail").mockRejectedValueOnce(
            new Error("CATALOG_NOT_FOUND")
        );

        const res = await app.request("/catalog/non_existent_table");
        expect(res.status).toBe(404);
        const json = await res.json();
        expect(json.error).toBe("Spatial catalog item not found");

        spy.mockRestore();
        env.API_KEY = originalKey;
    });
});
