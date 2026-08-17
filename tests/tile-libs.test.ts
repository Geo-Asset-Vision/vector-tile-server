import { describe, it, expect } from "vitest";
import {
    quoteIdentifier,
    qualifyColumn,
    quoteTable,
    remapWhereClause,
    buildGeomExpression,
    appendWhereClause,
    toTileJsonFieldType,
    type SingleTileOptions,
} from "../src/libs/tile";

describe("Tile Helpers & Utility Functions", () => {
    it("quoteIdentifier should double quote identifiers and escape inner double quotes", () => {
        expect(quoteIdentifier("table")).toBe('"table"');
        expect(quoteIdentifier('table"name')).toBe('"table""name"');
    });

    it("qualifyColumn should qualify column with alias and quoted identifier", () => {
        expect(qualifyColumn("src", "geom")).toBe('src."geom"');
        expect(qualifyColumn("tbl", "my_column")).toBe('tbl."my_column"');
    });

    it("quoteTable should format schema.table correctly", () => {
        expect(quoteTable("public", "buildings")).toBe('"public"."buildings"');
        expect(quoteTable("geo_schema", "spatial_table")).toBe('"geo_schema"."spatial_table"');
    });

    it("remapWhereClause should remap $1 placeholders with offset", () => {
        const sql = "id = $1 AND name = $2";
        expect(remapWhereClause(sql, 4)).toBe("id = $4 AND name = $5");
    });

    it("buildGeomExpression should handle SRID 3857 and non-3857 transformations", () => {
        const expr3857 = buildGeomExpression("src", "geom", 3857);
        expect(expr3857).toBe('ST_SetSRID(src."geom", 3857)');

        const expr4326 = buildGeomExpression("src", "geom", 4326);
        expect(expr4326).toContain("ST_Transform");
        expect(expr4326).toContain("src.\"geom\"");
        expect(expr4326).toContain("4326");
    });

    it("appendWhereClause should return empty string if whereSql is missing", () => {
        const layer: SingleTileOptions = { table: "buildings", geom: "geom" };
        const params: unknown[] = [14, 100, 200];
        const clause = appendWhereClause(layer, params);
        expect(clause).toBe("");
        expect(params).toHaveLength(3);
    });

    it("appendWhereClause should append remapped WHERE clause and push whereParams", () => {
        const layer: SingleTileOptions = {
            table: "buildings",
            geom: "geom",
            whereSql: '"status" = \'active\' AND "age" > $1',
            whereParams: [18],
        };
        const params: unknown[] = [14, 100, 200]; // 3 existing params ($1, $2, $3)
        const clause = appendWhereClause(layer, params);
        expect(clause).toBe(' AND ("status" = \'active\' AND "age" > $4)');
        expect(params).toHaveLength(4);
        expect(params[3]).toBe(18);
    });

    it("toTileJsonFieldType should convert postgres data types to TileJSON types", () => {
        expect(toTileJsonFieldType("integer")).toBe("Number");
        expect(toTileJsonFieldType("int4")).toBe("Number");
        expect(toTileJsonFieldType("int8")).toBe("Number");
        expect(toTileJsonFieldType("double precision")).toBe("Number");
        expect(toTileJsonFieldType("numeric")).toBe("Number");
        expect(toTileJsonFieldType("real")).toBe("Number");
        expect(toTileJsonFieldType("boolean")).toBe("Boolean");
        expect(toTileJsonFieldType("bool")).toBe("Boolean");
        expect(toTileJsonFieldType("character varying")).toBe("String");
        expect(toTileJsonFieldType("text")).toBe("String");
        expect(toTileJsonFieldType("timestamp with time zone")).toBe("String");
        expect(toTileJsonFieldType("date")).toBe("String");
        expect(toTileJsonFieldType(undefined)).toBe("String");
    });
});
