import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import env from "@/libs/env";
import { query } from "@/libs/db";
import { quoteTable, qualifyColumn, quoteIdentifier } from "@/libs/tile";
import { findTableGeomLayers } from "@/repositories/catalog.repo";
import sanitizeWhereParam from "@/libs/sanitized-query";

export function latLonToTile(lat: number, lon: number, zoom: number): { z: number; x: number; y: number } {
    const clampedZoom = Math.max(0, Math.min(22, Math.floor(zoom)));
    const n = Math.pow(2, clampedZoom);
    const x = Math.floor(((lon + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    );
    return { z: clampedZoom, x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

export function tileToBBox(z: number, x: number, y: number): [number, number, number, number] {
    const tile2lon = (tileX: number, zoom: number) => (tileX / Math.pow(2, zoom)) * 360 - 180;
    const tile2lat = (tileY: number, zoom: number) => {
        const n = Math.PI - (2 * Math.PI * tileY) / Math.pow(2, zoom);
        return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    };

    const minLon = tile2lon(x, z);
    const maxLon = tile2lon(x + 1, z);
    const maxLat = tile2lat(y, z);
    const minLat = tile2lat(y + 1, z);

    return [minLon, minLat, maxLon, maxLat];
}

export function registerSpatialTools(server: McpServer) {
    server.registerTool(
        "latlon_to_tile",
        {
            description: "Convert Latitude, Longitude, and Zoom level into XYZ vector tile coordinates",
            inputSchema: {
                latitude: z.number().min(-85.0511).max(85.0511).describe("Latitude (-85.0511 to 85.0511)"),
                longitude: z.number().min(-180).max(180).describe("Longitude (-180 to 180)"),
                zoom: z.number().min(0).max(22).describe("Zoom level (0 to 22)"),
            },
        },
        async ({ latitude, longitude, zoom }) => {
            const tile = latLonToTile(latitude, longitude, zoom);
            const bbox = tileToBBox(tile.z, tile.x, tile.y);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                tile_coordinates: tile,
                                tile_url_path: `/tiles/${tile.z}/${tile.x}/${tile.y}`,
                                tile_bbox_wgs84: bbox,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "tile_to_bbox",
        {
            description: "Calculate WGS84 bounding box [minLon, minLat, maxLon, maxLat] from XYZ tile coordinates",
            inputSchema: {
                z: z.number().min(0).max(22).describe("Zoom level (z)"),
                x: z.number().min(0).describe("Tile X coordinate"),
                y: z.number().min(0).describe("Tile Y coordinate"),
            },
        },
        async ({ z: zoom, x, y }) => {
            const bbox = tileToBBox(zoom, x, y);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                z: zoom,
                                x,
                                y,
                                bbox_wgs84: {
                                    min_longitude: bbox[0],
                                    min_latitude: bbox[1],
                                    max_longitude: bbox[2],
                                    max_latitude: bbox[3],
                                },
                                bbox_array: bbox,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    server.registerTool(
        "query_layer_features",
        {
            description: "Query spatial features from PostGIS table with optional WHERE filter, returning a GeoJSON FeatureCollection (for inspection/analysis)",
            inputSchema: {
                catalog_id: z.string().describe("Catalog identifier in format 'schema.table' or 'table'"),
                where: z.string().optional().describe("Optional SQL WHERE filter expression (e.g. \"status = 'active' AND population > 50000\")"),
                limit: z.number().min(1).max(200).default(50).describe("Maximum number of features to return (1-200, default 50)"),
            },
        },
        async ({ catalog_id, where, limit = 50 }) => {
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
                        content: [{ type: "text", text: `Catalog item '${catalog_id}' not found.` }],
                    };
                }

                const layer = geomLayers[0];
                const geomCol = layer.geometry_column;
                const allowedFields = new Set<string>();
                const fieldTypes: Record<string, string> = {};

                if (layer.fields) {
                    for (const [col, t] of Object.entries(layer.fields)) {
                        allowedFields.add(col);
                        allowedFields.add(col.toLowerCase());
                        fieldTypes[col] = t;
                    }
                }
                allowedFields.add(geomCol);

                let sanitizedWhere: string | undefined = undefined;
                if (where && where.trim().length > 0) {
                    const sanitized = sanitizeWhereParam(where.trim(), {
                        allowedFields,
                        fieldTypes,
                    });
                    if (sanitized === null) {
                        return {
                            isError: true,
                            content: [{ type: "text", text: `Invalid or unsafe WHERE clause: '${where}'` }],
                        };
                    }
                    sanitizedWhere = sanitized;
                }

                const propColumns = Object.keys(layer.fields || {})
                    .filter((col) => col !== geomCol)
                    .map((col) => quoteIdentifier(col))
                    .join(", ");

                const selectProps = propColumns.length > 0 ? `${propColumns}, ` : "";
                const whereClause = sanitizedWhere ? `AND (${sanitizedWhere})` : "";

                const sql = `
                    SELECT 
                        ${selectProps}
                        ST_AsGeoJSON(ST_Transform(${qualifyColumn("t", geomCol)}, 4326))::json AS geometry
                    FROM ${quoteTable(schemaName, tableName)} AS t
                    WHERE ${qualifyColumn("t", geomCol)} IS NOT NULL
                        ${whereClause}
                    LIMIT $1;
                `;

                const result = await query<Record<string, unknown>>(sql, [limit]);

                const featureCollection = {
                    type: "FeatureCollection",
                    features: result.rows.map((row) => {
                        const { geometry, ...properties } = row;
                        return {
                            type: "Feature",
                            geometry,
                            properties,
                        };
                    }),
                    total_returned: result.rows.length,
                };

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(featureCollection, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Failed to query spatial features: ${(error as Error).message}`,
                        },
                    ],
                };
            }
        }
    );

    server.registerTool(
        "get_attribute_statistics",
        {
            description: "Get distinct values or min/max statistics for a specific column in a spatial table to assist in filtering and styling",
            inputSchema: {
                catalog_id: z.string().describe("Catalog identifier 'schema.table' or 'table'"),
                column_name: z.string().describe("The attribute column name to analyze"),
                sample_size: z.number().min(1).max(50).default(20).describe("Max sample/distinct values to return"),
            },
        },
        async ({ catalog_id, column_name, sample_size = 20 }) => {
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
                        content: [{ type: "text", text: `Catalog item '${catalog_id}' not found.` }],
                    };
                }

                const rawType = geomLayers[0].fields?.[column_name] || geomLayers[0].fields?.[column_name.toLowerCase()];
                if (!rawType) {
                    return {
                        isError: true,
                        content: [{ type: "text", text: `Column '${column_name}' does not exist on table '${catalog_id}'.` }],
                    };
                }

                const colQuoted = quoteIdentifier(column_name);
                const tableQuoted = quoteTable(schemaName, tableName);

                const statsSql = `
                    SELECT 
                        COUNT(*)::int AS total_rows,
                        COUNT(${colQuoted})::int AS non_null_count,
                        COUNT(DISTINCT ${colQuoted})::int AS distinct_count,
                        MIN(${colQuoted}::text) AS min_val,
                        MAX(${colQuoted}::text) AS max_val
                    FROM ${tableQuoted};
                `;
                const statsResult = await query<Record<string, unknown>>(statsSql);
                const stats = statsResult.rows[0];

                const distinctSql = `
                    SELECT ${colQuoted} AS val, COUNT(*)::int AS count
                    FROM ${tableQuoted}
                    WHERE ${colQuoted} IS NOT NULL
                    GROUP BY ${colQuoted}
                    ORDER BY count DESC
                    LIMIT $1;
                `;
                const distinctResult = await query<{ val: unknown; count: number }>(distinctSql, [sample_size]);

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    column_name,
                                    data_type: rawType,
                                    summary: stats,
                                    top_values: distinctResult.rows,
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
                            text: `Failed to compute attribute statistics: ${(error as Error).message}`,
                        },
                    ],
                };
            }
        }
    );
}
