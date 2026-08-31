import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import env from "@/libs/env";
import { discoverCatalog, getTileJSONDetail } from "@/services/catalog.service";
import { cacheMetrics } from "@/libs/cache";
import { checkConnection } from "@/libs/db";

export function registerResources(server: McpServer) {
    server.registerResource(
        "catalogs-list",
        "vectortiles://catalogs",
        {
            description: "List of all discovered PostGIS spatial tables and geometry columns",
            mimeType: "application/json",
        },
        async (uri: URL) => {
            const catalogs = await discoverCatalog(env.POSTGIS_SCHEMA);
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: "application/json",
                        text: JSON.stringify(catalogs, null, 2),
                    },
                ],
            };
        }
    );

    server.registerResource(
        "catalog-tilejson",
        new ResourceTemplate("vectortiles://catalog/{catalogId}/tilejson", { list: undefined }),
        {
            description: "TileJSON 3.0.0 metadata for a specific spatial layer",
            mimeType: "application/json",
        },
        async (uri: URL, { catalogId }: Record<string, string | string[]>) => {
            const id = Array.isArray(catalogId) ? catalogId[0] : catalogId;
            const tileJson = await getTileJSONDetail(id);
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: "application/json",
                        text: JSON.stringify(tileJson, null, 2),
                    },
                ],
            };
        }
    );

    server.registerResource(
        "server-metrics",
        "vectortiles://server/metrics",
        {
            description: "Real-time metrics, cache statistics, and server health status",
            mimeType: "application/json",
        },
        async (uri: URL) => {
            const dbHealthy = await checkConnection();
            const snapshot = cacheMetrics.getSnapshot();
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: "application/json",
                        text: JSON.stringify(
                            {
                                status: dbHealthy ? "OK" : "DEGRADED",
                                metrics: snapshot,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );
}
