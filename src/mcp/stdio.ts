import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVectorTileMcpServer } from "./index";
import { checkConnection, disconnect } from "@/libs/db";
import { tileCache } from "@/libs/cache";

async function main() {
    // Suppress regular stdout logging in stdio mode so as not to corrupt JSON-RPC stream
    const isDbConnected = await checkConnection();
    if (!isDbConnected) {
        process.stderr.write("[MCP STDIO] Error: Could not connect to PostGIS Database.\n");
        process.exit(1);
    }

    const server = createVectorTileMcpServer();
    const transport = new StdioServerTransport();

    process.stderr.write("[MCP STDIO] Starting Vector Tile MCP Server on Stdio...\n");
    await server.connect(transport);
    process.stderr.write("[MCP STDIO] Server connected and ready for JSON-RPC messages.\n");

    const cleanup = async () => {
        process.stderr.write("[MCP STDIO] Shutting down...\n");
        await Promise.allSettled([
            server.close(),
            disconnect(),
            tileCache.disconnect(),
        ]);
        process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
}

main().catch((err) => {
    process.stderr.write(`[MCP STDIO FATAL] ${err?.stack || err}\n`);
    process.exit(1);
});
