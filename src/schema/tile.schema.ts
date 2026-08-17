import z from "zod";

export const GetTileParamsSchema = z.object({
    catalog_id: z.string().describe("Catalog ID (e.g. table_name or schema.table_name)"),
    z: z.string().describe("Zoom level z (0-30)"),
    x: z.string().describe("Tile X coordinate"),
    y: z.string().describe("Tile Y coordinate (optionally with .mvt or .pbf extension)"),
});

export const GetTileQuerySchema = z.object({
    where: z.string().optional().describe("SQL WHERE clause filter (e.g. status = 'active' AND age > 20)"),
    geom: z.string().optional().describe("Geometry column name if table has multiple geometry columns"),
    properties: z.string().optional().describe("Comma-separated list of column names to include in tile attributes"),
    extent: z.string().optional().describe("Vector tile extent in pixels (default: 4096)"),
    buffer: z.string().optional().describe("Vector tile buffer in pixels (default: 64)"),
    clip: z.string().optional().describe("Clip geometries to tile bounds (true/false, default: true)"),
    layer: z.string().optional().describe("Custom layer name in vector tile"),
});

export type TGetTileParams = z.infer<typeof GetTileParamsSchema>;
export type TGetTileQuery = z.infer<typeof GetTileQuerySchema>;
