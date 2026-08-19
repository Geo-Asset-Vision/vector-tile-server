import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import { getTile } from "@/services/tile.service";

const GEOM_TYPE_MAP: Record<number, string> = {
    1: "Point",
    2: "LineString",
    3: "Polygon",
};

export function registerInspectTools(server: McpServer) {
    server.registerTool(
        "inspect_mvt_tile",
        {
            description: "Fetch and decode a binary Vector Tile (.mvt/.pbf) for a specific coordinate (z, x, y), returning layer details, feature counts, geometry types, and sample attributes",
            inputSchema: {
                catalog_id: z.string().describe("Catalog identifier (e.g. 'public.provinces' or 'roads')"),
                z: z.number().int().min(0).max(22).describe("Zoom level (0-22)"),
                x: z.number().int().min(0).describe("Tile X coordinate"),
                y: z.number().int().min(0).describe("Tile Y coordinate"),
                where: z.string().optional().describe("Optional SQL WHERE filter"),
                max_sample_features: z.number().int().min(0).max(20).default(5).describe("Max sample features per layer to inspect (0-20, default 5)"),
            },
        },
        async ({ catalog_id, z: zoom, x, y, where, max_sample_features = 5 }) => {
            try {
                const response = await getTile({
                    catalogId: catalog_id,
                    z: zoom,
                    x,
                    y,
                    where,
                });

                if (!response.ok) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Tile generation failed with status ${response.status}: ${response.message || "Unknown error"}`,
                            },
                        ],
                    };
                }

                const buffer = response.data;
                const byteSize = buffer.length;

                if (byteSize === 0) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        catalog_id,
                                        coordinate: { z: zoom, x, y },
                                        status: "EMPTY_TILE",
                                        byte_size: 0,
                                        layers: {},
                                        note: "Tile is empty (no features intersecting this tile coordinate).",
                                    },
                                    null,
                                    2
                                ),
                            },
                        ],
                    };
                }

                const pbf = new PbfReader(buffer);
                const vt = new VectorTile(pbf as any);

                const layerSummaries: Record<
                    string,
                    {
                        version: number;
                        extent: number;
                        feature_count: number;
                        geometry_types: Record<string, number>;
                        sample_features: Array<{
                            id?: number | string;
                            geometry_type: string;
                            properties: Record<string, unknown>;
                        }>;
                    }
                > = {};

                let totalFeatures = 0;

                for (const [layerName, layer] of Object.entries(vt.layers)) {
                    totalFeatures += layer.length;
                    const geomCounts: Record<string, number> = {};
                    const samples: Array<{
                        id?: number | string;
                        geometry_type: string;
                        properties: Record<string, unknown>;
                    }> = [];

                    for (let i = 0; i < layer.length; i++) {
                        const feat = layer.feature(i);
                        const geomType = GEOM_TYPE_MAP[feat.type] || `Unknown(${feat.type})`;
                        geomCounts[geomType] = (geomCounts[geomType] || 0) + 1;

                        if (samples.length < max_sample_features) {
                            samples.push({
                                id: feat.id,
                                geometry_type: geomType,
                                properties: feat.properties,
                            });
                        }
                    }

                    layerSummaries[layerName] = {
                        version: layer.version,
                        extent: layer.extent,
                        feature_count: layer.length,
                        geometry_types: geomCounts,
                        sample_features: samples,
                    };
                }

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    catalog_id,
                                    coordinate: { z: zoom, x, y },
                                    byte_size: byteSize,
                                    cache_source: response.meta?.source || "UNKNOWN",
                                    etag: response.meta?.eTag,
                                    total_layers: Object.keys(vt.layers).length,
                                    total_features: totalFeatures,
                                    layers: layerSummaries,
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
                            text: `Failed to inspect MVT tile: ${(error as Error).message}`,
                        },
                    ],
                };
            }
        }
    );
}
