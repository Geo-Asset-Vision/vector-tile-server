import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import appRouter from "../src/routes/index";
import env from "../src/libs/env";
import { tileCache } from "../src/libs/cache";
import * as tileRepo from "../src/repositories/tile.repo";
import * as catalogRepo from "../src/repositories/catalog.repo";

describe("Tile Cache End-to-End Route Tests", () => {
    const app = new Hono();
    app.route("/", appRouter);

    beforeEach(() => {
        tileCache.l1Cache.clear();
        env.API_KEY = "";
    });

    it("GET /tiles/:catalog_id/:z/:x/:y should return 200 with ETag and Cache-Control headers", async () => {
        const mockGeomLayers = [
            {
                schema_name: "public",
                table_name: "buildings",
                geometry_column: "geom",
                geometry_type: "MultiPolygon",
                srid: 4326,
                fields: { id: "int4", name: "text" },
            },
        ];

        const mockTileBuffer = Buffer.from("mock-mvt-binary-data");

        vi.spyOn(catalogRepo, "findTableGeomLayers").mockResolvedValue(mockGeomLayers as any);
        vi.spyOn(tileRepo, "findVectorTileBuffer").mockResolvedValue(mockTileBuffer);

        const res = await app.request("/tiles/buildings/14/100/200");
        expect(res.status).toBe(200);

        const etag = res.headers.get("etag");
        expect(etag).not.toBeNull();
        expect(etag).toContain('W/"');

        const cacheControl = res.headers.get("cache-control");
        expect(cacheControl).toContain("public");
        expect(cacheControl).toContain("max-age=");

        const body = await res.arrayBuffer();
        expect(Buffer.from(body)).toEqual(mockTileBuffer);
    });

    it("GET /tiles/:catalog_id/:z/:x/:y with If-None-Match should return 304 Not Modified when ETag matches", async () => {
        const mockGeomLayers = [
            {
                schema_name: "public",
                table_name: "roads",
                geometry_column: "geom",
                geometry_type: "LineString",
                srid: 4326,
                fields: { id: "int4" },
            },
        ];

        const mockTileBuffer = Buffer.from("mock-roads-tile-data");

        vi.spyOn(catalogRepo, "findTableGeomLayers").mockResolvedValue(mockGeomLayers as any);
        vi.spyOn(tileRepo, "findVectorTileBuffer").mockResolvedValue(mockTileBuffer);

        // 1st request -> 200 OK + ETag
        const res1 = await app.request("/tiles/roads/14/50/60");
        expect(res1.status).toBe(200);
        const etag = res1.headers.get("etag") as string;
        expect(etag).toBeTruthy();

        // 2nd request with If-None-Match: etag -> 304 Not Modified
        const res2 = await app.request("/tiles/roads/14/50/60", {
            headers: {
                "If-None-Match": etag,
            },
        });

        expect(res2.status).toBe(304);
        expect(res2.headers.get("etag")).toBe(etag);
        const bodyText = await res2.text();
        expect(bodyText).toBe(""); // No body transferred on 304
    });

    it("GET /tiles/:catalog_id/:z/:x/:y should include X-MVT-Cache header when MVT_CACHE_DEBUG_HEADERS=true", async () => {
        const originalDebug = env.MVT_CACHE_DEBUG_HEADERS;
        env.MVT_CACHE_DEBUG_HEADERS = true;

        const mockGeomLayers = [
            {
                schema_name: "public",
                table_name: "parcels",
                geometry_column: "geom",
                geometry_type: "Polygon",
                srid: 4326,
                fields: { id: "int4" },
            },
        ];

        vi.spyOn(catalogRepo, "findTableGeomLayers").mockResolvedValue(mockGeomLayers as any);
        vi.spyOn(tileRepo, "findVectorTileBuffer").mockResolvedValue(Buffer.from("parcels-tile"));

        // 1st request -> MISS
        const res1 = await app.request("/tiles/parcels/14/11/21");
        expect(res1.status).toBe(200);
        expect(res1.headers.get("x-mvt-cache")).toBe("MISS");

        // 2nd request -> L1
        const res2 = await app.request("/tiles/parcels/14/11/21");
        expect(res2.status).toBe(200);
        expect(res2.headers.get("x-mvt-cache")).toBe("L1");

        // 3rd request with cache bypass -> BYPASS
        const res3 = await app.request("/tiles/parcels/14/11/21?cache=false");
        expect(res3.status).toBe(200);
        expect(res3.headers.get("x-mvt-cache")).toBe("BYPASS");

        env.MVT_CACHE_DEBUG_HEADERS = originalDebug;
    });

    it("GET /metrics should return Prometheus metrics or JSON", async () => {
        // Prometheus format
        const promRes = await app.request("/metrics");
        expect(promRes.status).toBe(200);
        expect(promRes.headers.get("content-type")).toContain("text/plain");
        const promText = await promRes.text();
        expect(promText).toContain("mvt_cache_l1_hits_total");
        expect(promText).toContain("mvt_cache_singleflight_total");

        // JSON format
        const jsonRes = await app.request("/metrics", {
            headers: {
                Accept: "application/json",
            },
        });
        expect(jsonRes.status).toBe(200);
        expect(jsonRes.headers.get("content-type")).toContain("application/json");
        const json = await jsonRes.json();
        expect(json).toHaveProperty("l1Hits");
        expect(json).toHaveProperty("l1HitRatio");
        expect(json).toHaveProperty("singleFlightExecutions");
    });
});
