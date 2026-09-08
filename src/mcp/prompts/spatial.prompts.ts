import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer) {
    server.registerPrompt(
        "analyze-spatial-dataset",
        {
            description: "Workflow to analyze a spatial catalog dataset: discover fields, compute attribute stats, and recommend MapLibre/GeoLibre visualization styles",
            argsSchema: {
                catalog_id: z.string().describe("The catalog identifier (e.g. 'public.provinces' or 'roads')"),
            },
        },
        ({ catalog_id }) => {
            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `Please analyze the spatial dataset '${catalog_id}'.
Follow these steps:
1. Call 'get_catalog_schema' to inspect the geometry type, SRID, and available attribute columns.
2. Call 'get_tilejson' to retrieve the spatial bounding box and default zoom levels.
3. For key categorical or numerical columns, call 'get_attribute_statistics' to understand data distribution.
4. Based on the analysis, suggest:
   - Safe SQL WHERE filter examples (using Pratt syntax supported by the server).
   - Recommended MapLibre / GeoLibre layer styling (using 'generate_maplibre_style').
   - Sample XYZ tile URL (using 'generate_tile_url').`,
                        },
                    },
                ],
            };
        }
    );

    server.registerPrompt(
        "debug-tile-rendering",
        {
            description: "Workflow to debug why a vector tile might be empty, slow, or malformed at a specific zoom/x/y coordinate",
            argsSchema: {
                catalog_id: z.string().describe("The catalog identifier"),
                z: z.string().describe("Zoom level"),
                x: z.string().describe("Tile X coordinate"),
                y: z.string().describe("Tile Y coordinate"),
            },
        },
        ({ catalog_id, z: zoom, x, y }) => {
            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `Please debug the vector tile for dataset '${catalog_id}' at coordinate z=${zoom}, x=${x}, y=${y}.
1. Call 'tile_to_bbox' to calculate the WGS84 geographical bounding box for this tile.
2. Call 'inspect_mvt_tile' to decode the binary MVT buffer and check feature count, layers, and sample geometry types.
3. Call 'get_cache_and_server_metrics' to check server latency and cache status.
4. Report your findings and diagnose if the tile is empty due to lack of features in that bounding box, or if there is a query/filtering issue.`,
                        },
                    },
                ],
            };
        }
    );

    server.registerPrompt(
        "search-spatial-semantic",
        {
            description: "Workflow to semantically search the spatial catalog with a natural-language query, inspect the top-ranked layer, and produce a recommended tile URL and MapLibre style",
            argsSchema: {
                query: z.string().describe("Natural-language query describing the spatial layer to find (e.g. 'cari lahan kosong', 'jalan banjir')"),
                top_k: z.number().int().min(1).max(10).optional().describe("Number of top-ranked results to consider (1-10)"),
                schema: z.string().optional().describe("Filter catalog schema (e.g. 'public')"),
            },
        },
        ({ query, top_k, schema }) => {
            const args = [
                `query: '${query}'`,
                ...(top_k !== undefined ? [`top_k: ${top_k}`] : []),
                ...(schema !== undefined ? [`schema: '${schema}'`] : []),
            ].join(", ");
            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `Please semantically search the spatial catalog and produce a tile-ready recommendation.
Follow these steps:
1. Call 'search_spatial_catalogs' with ${args}. Note the top-ranked result's catalogId and score from the returned results array.
2. Call 'get_catalog_schema' on that catalogId to inspect the geometry type, SRID, and available attribute columns.
3. Call 'get_tilejson' for that catalogId to retrieve the spatial bounding box and available zoom levels.
4. Call 'generate_tile_url' to produce a sample tile URL for the catalogId.
5. Call 'generate_maplibre_style' to get a recommended MapLibre style for the layer.
6. Report the catalogId, score, geometry type, SRID, and the generated tile URL and style recommendation.`,
                        },
                    },
                ],
            };
        }
    );
}
