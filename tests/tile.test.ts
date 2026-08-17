import { describe, it, expect } from "vitest";
import {
    quoteIdentifier,
    qualifyColumn,
    quoteTable,
    remapWhereClause,
    toTileJsonFieldType,
} from "../src/libs/tile";

describe("Tile Helpers", () => {
    it("quoteIdentifier should double quote identifiers and escape inner quotes", () => {
        expect(quoteIdentifier("table")).toBe('"table"');
        expect(quoteIdentifier('table"name')).toBe('"table""name"');
    });

    it("qualifyColumn should qualify column with alias", () => {
        expect(qualifyColumn("src", "geom")).toBe('src."geom"');
    });

    it("quoteTable should format schema.table correctly", () => {
        expect(quoteTable("public", "buildings")).toBe('"public"."buildings"');
    });

    it("remapWhereClause should remap $1 placeholders with offset", () => {
        const sql = "id = $1 AND name = $2";
        expect(remapWhereClause(sql, 4)).toBe("id = $4 AND name = $5");
    });

    it("toTileJsonFieldType should convert postgres data types to TileJSON types", () => {
        expect(toTileJsonFieldType("integer")).toBe("Number");
        expect(toTileJsonFieldType("double precision")).toBe("Number");
        expect(toTileJsonFieldType("boolean")).toBe("Boolean");
        expect(toTileJsonFieldType("character varying")).toBe("String");
        expect(toTileJsonFieldType("timestamp with time zone")).toBe("String");
    });
});
