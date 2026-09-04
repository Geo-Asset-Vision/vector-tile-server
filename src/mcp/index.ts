import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCatalogTools } from "./tools/catalog.tools";
import { registerSpatialTools } from "./tools/spatial.tools";
import { registerInspectTools } from "./tools/inspect.tools";
import { registerStylingTools } from "./tools/styling.tools";
import { registerCacheTools } from "./tools/cache.tools";
import { registerResources } from "./resources/catalog.resources";
import { registerPrompts } from "./prompts/spatial.prompts";

export function createVectorTileMcpServer(): McpServer {
    const server = new McpServer({
        name: "vector-tile-server-mcp",
        version: "1.0.0",
    });

    registerCatalogTools(server);
    registerSpatialTools(server);
    registerInspectTools(server);
    registerStylingTools(server);
    registerCacheTools(server);
    registerResources(server);
    registerPrompts(server);

    return server;
}
