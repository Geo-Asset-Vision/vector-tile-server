import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tileCache, cacheMetrics, datasetVersionProvider } from "@/libs/cache";
import { checkConnection } from "@/libs/db";

export function registerCacheTools(server: McpServer) {
    server.registerTool(
        "get_cache_and_server_metrics",
        {
            description: "Retrieve real-time vector tile server metrics, 2-level cache (L1 LRU & L2 Valkey) hit ratios, latency stats, and database connectivity",
            inputSchema: {
                format: z.enum(["json", "prometheus"]).default("json").describe("Output format: 'json' for structured object, 'prometheus' for plain text exposition"),
            },
        },
        async ({ format = "json" }) => {
            try {
                const dbHealthy = await checkConnection();
                const snapshot = cacheMetrics.getSnapshot();

                if (format === "prometheus") {
                    return {
                        content: [
                            {
                                type: "text",
                                text: cacheMetrics.toPrometheus(),
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
                                    server_health: {
                                        postgis_database: dbHealthy ? "HEALTHY" : "UNHEALTHY",
                                        valkey_l2_cache: tileCache.l2Cache.isConnected ? "CONNECTED" : "DISCONNECTED_OR_DISABLED",
                                        valkey_circuit_state: tileCache.l2Cache.circuitState,
                                    },
                                    cache_configuration: {
                                        master_enabled: tileCache.isCacheEnabled,
                                    },
                                    metrics: snapshot,
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
                            text: `Failed to retrieve metrics: ${(error as Error).message}`,
                        },
                    ],
                };
            }
        }
    );

    server.registerTool(
        "purge_layer_cache",
        {
            description: "Invalidate cached vector tiles for a specific layer or all layers (by bumping dataset version and clearing L1 LRU)",
            inputSchema: {
                catalog_id: z.string().optional().describe("Catalog ID / layer name to invalidate. If omitted, all L1 in-memory cache is purged."),
            },
        },
        async ({ catalog_id }) => {
            try {
                if (catalog_id) {
                    const newVersion = await datasetVersionProvider.bumpVersion(catalog_id);
                    tileCache.l1Cache.clear();
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        status: "SUCCESS",
                                        message: `Cache invalidated for layer '${catalog_id}'.`,
                                        layer: catalog_id,
                                        new_dataset_version: newVersion,
                                    },
                                    null,
                                    2
                                ),
                            },
                        ],
                    };
                } else {
                    tileCache.l1Cache.clear();
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        status: "SUCCESS",
                                        message: "All L1 in-memory cache cleared.",
                                    },
                                    null,
                                    2
                                ),
                            },
                        ],
                    };
                }
            } catch (error) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Failed to purge cache: ${(error as Error).message}`,
                        },
                    ],
                };
            }
        }
    );
}
