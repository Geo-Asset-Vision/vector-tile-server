import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import env from "@/libs/env";
import { getTileJSONDetail } from "@/services/catalog.service";

export function registerStylingTools(server: McpServer) {
    server.registerTool(
        "generate_tile_url",
        {
            description: "Generate XYZ Tile URL templates with optional WHERE filter and documentation on headers/query params",
            inputSchema: {
                catalog_id: z.string().describe("Catalog identifier 'schema.table' or 'table'"),
                where: z.string().optional().describe("Optional SQL WHERE filter"),
            },
        },
        async ({ catalog_id, where }) => {
            let tilesUrl = `${env.APP_BASE_URL}/tiles/${catalog_id}/{z}/{x}/{y}`;
            if (where && where.trim().length > 0) {
                tilesUrl += `?where=${encodeURIComponent(where.trim())}`;
            }

            const tileJsonUrl = `${env.APP_BASE_URL}/catalog/${catalog_id}`;

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                catalog_id,
                                tile_url_template: tilesUrl,
                                tilejson_url: tileJsonUrl,
                                usage: {
                                    maplibre_raster_or_vector: {
                                        type: "vector",
                                        tiles: [tilesUrl],
                                    },
                                    leaflet: tilesUrl,
                                },
                                auth_note: env.API_KEY
                                    ? "Server has API Key security enabled. Pass header 'X-API-Key: <your-key>' in requests."
                                    : "No API Key required (public access).",
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
        "generate_maplibre_style",
        {
            description: "Generate ready-to-use MapLibre GL JS / GeoLibre style JSON layer definition for vector tiles",
            inputSchema: {
                catalog_id: z.string().describe("Catalog identifier 'schema.table' or 'table'"),
                layer_type: z.enum(["fill", "line", "circle"]).default("fill").describe("Visual layer type: 'fill' (polygons), 'line' (lines/boundaries), or 'circle' (points)"),
                color: z.string().default("#3b82f6").describe("Hex color or CSS color string (e.g. '#3b82f6', '#ef4444')"),
                opacity: z.number().min(0).max(1).default(0.7).describe("Layer opacity between 0.0 and 1.0"),
                where: z.string().optional().describe("Optional SQL WHERE filter"),
            },
        },
        async ({ catalog_id, layer_type, color, opacity, where }) => {
            try {
                const tileJson = await getTileJSONDetail(catalog_id, { where });
                const sourceId = catalog_id.replace(/[^a-zA-Z0-9_-]/g, "_");
                const defaultSourceLayer = tileJson.vector_layers[0]?.id || catalog_id.split(".").pop() || catalog_id;

                let paintProps: Record<string, unknown> = {};

                if (layer_type === "fill") {
                    paintProps = {
                        "fill-color": color,
                        "fill-opacity": opacity,
                        "fill-outline-color": "#1e293b",
                    };
                } else if (layer_type === "line") {
                    paintProps = {
                        "line-color": color,
                        "line-width": 2,
                        "line-opacity": opacity,
                    };
                } else if (layer_type === "circle") {
                    paintProps = {
                        "circle-color": color,
                        "circle-radius": 6,
                        "circle-opacity": opacity,
                        "circle-stroke-width": 1,
                        "circle-stroke-color": "#ffffff",
                    };
                }

                const styleConfig = {
                    source_definition: {
                        [sourceId]: {
                            type: "vector",
                            url: `${env.APP_BASE_URL}/catalog/${catalog_id}${where ? `?where=${encodeURIComponent(where)}` : ""}`,
                        },
                    },
                    layer_definition: {
                        id: `${sourceId}_layer`,
                        type: layer_type,
                        source: sourceId,
                        "source-layer": defaultSourceLayer,
                        minzoom: tileJson.minzoom || 0,
                        maxzoom: tileJson.maxzoom || 22,
                        paint: paintProps,
                    },
                    maplibre_js_snippet: `
map.addSource('${sourceId}', {
  type: 'vector',
  url: '${env.APP_BASE_URL}/catalog/${catalog_id}${where ? `?where=${encodeURIComponent(where)}` : ""}'
});

map.addLayer(${JSON.stringify(
                        {
                            id: `${sourceId}_layer`,
                            type: layer_type,
                            source: sourceId,
                            "source-layer": defaultSourceLayer,
                            paint: paintProps,
                        },
                        null,
                        2
                    )});
                    `.trim(),
                };

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(styleConfig, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Failed to generate MapLibre style: ${(error as Error).message}`,
                        },
                    ],
                };
            }
        }
    );

    server.registerTool(
        "export_geolibre_config",
        {
            description: "Generate a complete layer specification JSON ready to be added to GeoLibre workspace",
            inputSchema: {
                catalog_id: z.string().describe("Catalog identifier"),
                where: z.string().optional().describe("Optional SQL WHERE filter"),
            },
        },
        async ({ catalog_id, where }) => {
            try {
                const tileJson = await getTileJSONDetail(catalog_id, { where });
                const layerName = catalog_id.split(".").pop() || catalog_id;

                const geolibreLayerConfig = {
                    name: layerName,
                    type: "vector-tile",
                    url: `${env.APP_BASE_URL}/catalog/${catalog_id}${where ? `?where=${encodeURIComponent(where)}` : ""}`,
                    bounds: tileJson.bounds,
                    center: tileJson.center,
                    sourceLayer: tileJson.vector_layers[0]?.id || layerName,
                    availableFields: tileJson.vector_layers[0]?.fields || {},
                    metadata: {
                        catalogId: catalog_id,
                        description: tileJson.description,
                        generatedAt: new Date().toISOString(),
                    },
                };

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(geolibreLayerConfig, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Failed to export GeoLibre config: ${(error as Error).message}`,
                        },
                    ],
                };
            }
        }
    );
}
