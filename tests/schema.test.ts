import { describe, it, expect } from "vitest";
import {
    CatalogItemSchema,
    ListCatalogItemSchema,
    TileJSONSchema,
    ListCatalogQuerySchema,
    GetCatalogDetailParamsSchema,
    GetCatalogDetailQuerySchema,
} from "../src/schema/catalog.schema";
import {
    GetTileParamsSchema,
    GetTileQuerySchema,
} from "../src/schema/tile.schema";

describe("Catalog & Tile Zod Schemas", () => {
    it("should validate CatalogItemSchema and ListCatalogItemSchema", () => {
        const item = {
            id: "public.buildings",
            type: "table",
            geometry_columns: [
                { name: "geom", srid: 4326, type: "POLYGON", dimensions: 2 },
            ],
        };
        expect(CatalogItemSchema.safeParse(item).success).toBe(true);

        const list = [item];
        expect(ListCatalogItemSchema.safeParse(list).success).toBe(true);
    });

    it("should validate TileJSONSchema", () => {
        const tileJson = {
            tilejson: "3.0.0",
            name: "public.buildings",
            description: "Buildings catalog",
            version: "1.0.0",
            scheme: "xyz",
            minzoom: 0,
            maxzoom: 22,
            bounds: [-180, -85, 180, 85],
            center: [0, 0, 6],
            tiles: ["http://localhost:3000/tiles/public.buildings/{z}/{x}/{y}"],
            vector_layers: [
                {
                    id: "buildings",
                    description: "Buildings layer",
                    minzoom: 0,
                    maxzoom: 22,
                    fields: { id: "Number", name: "String" },
                },
            ],
        };
        expect(TileJSONSchema.safeParse(tileJson).success).toBe(true);
    });

    it("should validate ListCatalogQuerySchema", () => {
        expect(ListCatalogQuerySchema.safeParse({}).success).toBe(true);
        expect(ListCatalogQuerySchema.safeParse({ schema: "public" }).success).toBe(true);
    });

    it("should validate GetCatalogDetailParamsSchema and GetCatalogDetailQuerySchema", () => {
        expect(GetCatalogDetailParamsSchema.safeParse({ catalog_id: "public.buildings" }).success).toBe(true);
        expect(GetCatalogDetailQuerySchema.safeParse({ where: "status = 'active'" }).success).toBe(true);
    });

    it("should validate GetTileParamsSchema", () => {
        const validParams = { catalog_id: "buildings", z: "14", x: "100", y: "200.mvt" };
        expect(GetTileParamsSchema.safeParse(validParams).success).toBe(true);
    });

    it("should validate GetTileQuerySchema", () => {
        const query = {
            where: "age > 18",
            geom: "geom",
            properties: "id,name",
            extent: "4096",
            buffer: "64",
            clip: "true",
            layer: "custom_layer",
        };
        expect(GetTileQuerySchema.safeParse(query).success).toBe(true);
    });
});
