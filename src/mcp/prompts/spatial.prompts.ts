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
}
