import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import env from "@/libs/env";
import { discoverCatalog, getTileJSONDetail } from "@/services/catalog.service";
import { findTableGeomLayers } from "@/repositories/catalog.repo";

export function registerCatalogTools(server: McpServer) {
    server.registerTool(
        "list_spatial_catalogs",
        {
            description: "List all spatial tables, views, and geometry layers available in PostGIS with their geometry types and columns",
            inputSchema: {
                schema: z
                    .string()
                    .optional()
                    .describe("Optional PostgreSQL schema name. Defaults to POSTGIS_SCHEMA from env (e.g. 'public')"),
            },
        },
        async ({ schema }) => {
            try {
                const catalogs = await discoverCatalog(schema);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    total_catalogs: catalogs.length,
                                    catalogs,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Failed to discover spatial catalogs: ${(error as Error).message}`,
                        },
                    ],
                };
            }
        }
    );

    server.registerTool(
        "get_catalog_schema",
        {
            description: "Get detailed schema information for a spatial catalog item (columns, data types, SRID, table/column descriptions)",
            inputSchema: {
                catalog_id: z
                    .string()
                    .describe("Catalog identifier in the format 'schema.table' or 'table' (e.g. 'public.indonesia_provinces' or 'roads')"),
            },
        },
        async ({ catalog_id }) => {
            try {
                let schemaName = env.POSTGIS_SCHEMA || "public";
                let tableName = catalog_id;

                if (catalog_id.includes(".")) {
                    const parts = catalog_id.split(".");
                    schemaName = parts[0];
                    tableName = parts.slice(1).join(".");
                }

                const geomLayers = await findTableGeomLayers({ schemaName, tableName });
                if (!geomLayers || geomLayers.length === 0) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Catalog item '${catalog_id}' not found or contains no geometry columns.`,
                            },
                        ],
                    };
                }

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    catalog_id,
                                    schema_name: schemaName,
                                    table_name: tableName,
                                    layers: geomLayers,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Error retrieving catalog schema: ${(error as Error).message}`,
                        },
                    ],
                };
            }
        }
    );

    server.registerTool(
        "get_tilejson",
        {
            description: "Get the TileJSON 3.0.0 specification for a spatial catalog item, including bounding box, center, vector layers, and tile URLs",
            inputSchema: {
                catalog_id: z
                    .string()
                    .describe("Catalog identifier in format 'schema.table' or 'table'"),
                where: z
                    .string()
                    .optional()
                    .describe("Optional SQL WHERE filter expression (e.g. \"status = 'active' AND population > 100000\")"),
            },
        },
        async ({ catalog_id, where }) => {
            try {
                const tileJson = await getTileJSONDetail(catalog_id, { where });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(tileJson, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Failed to generate TileJSON: ${(error as Error).message}`,
                        },
                    ],
                };
            }
        }
    );
}
