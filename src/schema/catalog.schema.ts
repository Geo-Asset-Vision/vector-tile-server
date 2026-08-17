import z from "zod";

export const GeometryColumnSchema = z.object({
    name: z.string(),
    srid: z.number(),
    type: z.string(),
    dimensions: z.number(),
});

export const CatalogItemSchema = z.object({
    id: z.string(),
    type: z.enum(["table", "view", "materialized_view"]),
    geometry_columns: z.array(GeometryColumnSchema),
});

export const ListCatalogItemSchema = z.array(CatalogItemSchema);

export const ListCatalogQuerySchema = z.object({
    schema: z.string().optional().describe("Schema name to filter spatial catalog items"),
});

export const GetCatalogDetailParamsSchema = z.object({
    catalog_id: z.string().describe("Catalog ID (e.g. table_name or schema.table_name)"),
});

export const GetCatalogDetailQuerySchema = z.object({
    where: z.string().optional().describe("SQL WHERE clause filter (e.g. status = 'active' AND age > 20)"),
});

export const VectorLayerSchema = z.object({
    id: z.string(),
    fields: z.record(z.string(), z.string()),
    description: z.string().optional(),
    minzoom: z.number().int().min(0).max(30).optional(),
    maxzoom: z.number().int().min(0).max(30).optional(),
});

export const TileJSONSchema = z.object({
    tilejson: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
    attribution: z.string().optional(),
    scheme: z.enum(["xyz", "tms"]).optional(),
    minzoom: z.number().int().min(0).max(30).optional(),
    maxzoom: z.number().int().min(0).max(30).optional(),
    bounds: z.array(z.number()).length(4).optional(),
    center: z.array(z.number()).length(3).optional(),
    tiles: z.array(z.string()),
    vector_layers: z.array(VectorLayerSchema),
});

export type TListCatalogItemSchema = z.infer<typeof ListCatalogItemSchema>;
export type TListCatalogQuery = z.infer<typeof ListCatalogQuerySchema>;
export type TGetCatalogDetailParams = z.infer<typeof GetCatalogDetailParamsSchema>;
export type TGetCatalogDetailQuery = z.infer<typeof GetCatalogDetailQuerySchema>;
export type TCatalogItemSchema = z.infer<typeof CatalogItemSchema>;
export type TTileJSONSchema = z.infer<typeof TileJSONSchema>;
export type TVectorLayer = z.infer<typeof VectorLayerSchema>;
