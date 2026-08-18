import { describe, it, expect } from "vitest";
import {
    buildTileCacheKey,
    canonicalizeQueryParams,
    generateQueryHash,
    validateTileCoordinates,
} from "../src/libs/cache/cache-key";

describe("Cache Key Generator & Canonical Normalization", () => {
    describe("validateTileCoordinates", () => {
        it("should accept valid coordinates", () => {
            expect(() => validateTileCoordinates(0, 0, 0)).not.toThrow();
            expect(() => validateTileCoordinates(14, 100, 200)).not.toThrow();
            expect(() => validateTileCoordinates(30, 1000, 2000)).not.toThrow();
        });

        it("should reject non-integer coordinates", () => {
            expect(() => validateTileCoordinates(1.5, 0, 0)).toThrow(/must be integers/);
            expect(() => validateTileCoordinates(0, 1.2, 0)).toThrow(/must be integers/);
            expect(() => validateTileCoordinates(0, 0, 2.8)).toThrow(/must be integers/);
        });

        it("should reject negative coordinates", () => {
            expect(() => validateTileCoordinates(-1, 0, 0)).toThrow(/between 0 and 30/);
            expect(() => validateTileCoordinates(5, -1, 0)).toThrow(/non-negative/);
            expect(() => validateTileCoordinates(5, 0, -1)).toThrow(/non-negative/);
        });

        it("should reject zoom levels beyond 30", () => {
            expect(() => validateTileCoordinates(31, 0, 0)).toThrow(/between 0 and 30/);
        });

        it("should reject coordinates out of bounds for the zoom level", () => {
            // At z=2, 2^2 = 4 (valid: 0, 1, 2, 3)
            expect(() => validateTileCoordinates(2, 4, 0)).toThrow(/out of bounds/);
            expect(() => validateTileCoordinates(2, 0, 4)).toThrow(/out of bounds/);
        });
    });

    describe("canonicalizeQueryParams", () => {
        it("should trim strings and remove empty values", () => {
            const canonical = canonicalizeQueryParams({
                where: "  status = 'active'  ",
                geom: "  the_geom  ",
                layerName: "  custom_layer  ",
            });

            expect(canonical.where).toBe("status = 'active'");
            expect(canonical.geom).toBe("the_geom");
            expect(canonical.layerName).toBe("custom_layer");
        });

        it("should sort and deduplicate properties deterministically", () => {
            const c1 = canonicalizeQueryParams({
                properties: ["name", "id", "status", "id"],
            });
            const c2 = canonicalizeQueryParams({
                properties: ["status", "name", "id"],
            });
            const c3 = canonicalizeQueryParams({
                properties: "id, name, status",
            });

            expect(c1.properties).toEqual(["id", "name", "status"]);
            expect(c2.properties).toEqual(["id", "name", "status"]);
            expect(c3.properties).toEqual(["id", "name", "status"]);
        });
    });

    describe("buildTileCacheKey", () => {
        it("should produce the same key regardless of query property order", () => {
            const key1 = buildTileCacheKey({
                catalogId: "buildings",
                z: 14,
                x: 100,
                y: 200,
                where: "status = 'active'",
                extent: 4096,
                properties: ["id", "name"],
            });

            const key2 = buildTileCacheKey({
                catalogId: "buildings",
                z: 14,
                x: 100,
                y: 200,
                properties: ["name", "id"],
                extent: 4096,
                where: "status = 'active'",
            });

            expect(key1).toBe(key2);
        });

        it("should produce different keys for different filter values", () => {
            const key1 = buildTileCacheKey({
                catalogId: "buildings",
                z: 14,
                x: 100,
                y: 200,
                where: "status = 'active'",
            });

            const key2 = buildTileCacheKey({
                catalogId: "buildings",
                z: 14,
                x: 100,
                y: 200,
                where: "status = 'inactive'",
            });

            expect(key1).not.toBe(key2);
        });

        it("should produce different keys for different tiles", () => {
            const key1 = buildTileCacheKey({ catalogId: "buildings", z: 14, x: 100, y: 200 });
            const key2 = buildTileCacheKey({ catalogId: "buildings", z: 14, x: 101, y: 200 });
            const key3 = buildTileCacheKey({ catalogId: "buildings", z: 15, x: 100, y: 200 });

            expect(key1).not.toBe(key2);
            expect(key1).not.toBe(key3);
        });

        it("should produce different keys for different layers", () => {
            const key1 = buildTileCacheKey({ catalogId: "buildings", z: 14, x: 100, y: 200 });
            const key2 = buildTileCacheKey({ catalogId: "roads", z: 14, x: 100, y: 200 });

            expect(key1).not.toBe(key2);
        });

        it("should produce different keys for different dataset versions", () => {
            const keyV1 = buildTileCacheKey({
                catalogId: "buildings",
                datasetVersion: 1,
                z: 14,
                x: 100,
                y: 200,
            });

            const keyV2 = buildTileCacheKey({
                catalogId: "buildings",
                datasetVersion: 2,
                z: 14,
                x: 100,
                y: 200,
            });

            expect(keyV1).toContain(":d1:");
            expect(keyV2).toContain(":d2:");
            expect(keyV1).not.toBe(keyV2);
        });

        it("should produce different keys for different tenant IDs", () => {
            const keyA = buildTileCacheKey({
                catalogId: "buildings",
                z: 14,
                x: 100,
                y: 200,
                tenantId: "tenant_alpha",
            });

            const keyB = buildTileCacheKey({
                catalogId: "buildings",
                z: 14,
                x: 100,
                y: 200,
                tenantId: "tenant_beta",
            });

            expect(keyA).toContain(":ttenant_alpha");
            expect(keyB).toContain(":ttenant_beta");
            expect(keyA).not.toBe(keyB);
        });

        it("should follow the standard format mvt:v1:{layer}:d{datasetVersion}:z{z}:x{x}:y{y}:q{queryHash}", () => {
            const key = buildTileCacheKey({
                catalogId: "public.titik_api",
                datasetVersion: 183,
                z: 13,
                x: 1234,
                y: 5678,
            });

            expect(key).toMatch(/^mvt:v1:public\.titik_api:d183:z13:x1234:y5678:q[a-f0-9]{16}$/);
        });
    });
});
