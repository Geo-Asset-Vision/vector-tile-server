import { Hono } from "hono";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createVectorTileMcpServer } from "./index";
import { withAPIKey } from "@/middleware";

function patchNodeResponse(res: ServerResponse): void {
    const originalWriteHead = res.writeHead.bind(res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.writeHead = function (...args: any[]) {
        if (res.headersSent) {
            return res;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalWriteHead as any)(...args);
    };

    const originalEnd = res.end.bind(res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.end = function (...args: any[]) {
        if (res.writableEnded) {
            return res;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalEnd as any)(...args);
    };
}

export function createMcpRoutes(): Hono {
    const app = new Hono();

    // Protect all MCP routes with API Key authentication middleware
    app.use("*", withAPIKey);

    // Map to store active SSE transports and corresponding McpServer instances by sessionId
    const transports = new Map<string, SSEServerTransport>();
    const sessionServers = new Map<string, McpServer>();

    /**
     * SSE Stream Endpoint for Model Context Protocol
     * Connects AI clients (e.g. Mastra MCPClient, Claude, remote agents)
     * Creates an isolated McpServer instance per connection for multi-client concurrency.
     */
    app.get("/sse", async (c) => {
        const req = (c.env as { incoming?: IncomingMessage })?.incoming;
        const res = (c.env as { outgoing?: ServerResponse })?.outgoing;

        if (!req || !res) {
            return c.json({ error: "SSE Transport requires a Node.js server environment" }, 500);
        }

        patchNodeResponse(res);

        // If client authenticated via query param, propagate it to the message endpoint for seamless SSE clients
        const apiKeyParam = c.req.query("apiKey") || c.req.query("api_key");
        const messagesEndpoint = apiKeyParam
            ? `/mcp/messages?apiKey=${encodeURIComponent(apiKeyParam)}`
            : "/mcp/messages";

        // Create an isolated McpServer instance per SSE transport connection
        const mcpServer = createVectorTileMcpServer();
        const transport = new SSEServerTransport(messagesEndpoint, res);
        const sessionId = transport.sessionId;

        transports.set(sessionId, transport);
        sessionServers.set(sessionId, mcpServer);

        res.on("close", async () => {
            transports.delete(sessionId);
            sessionServers.delete(sessionId);
            await mcpServer.close().catch(() => {});
        });

        await mcpServer.connect(transport);

        // Keep Hono handler pending until the SSE stream closes to prevent race conditions with headers
        return new Promise<Response>((resolve) => {
            res.on("close", () => {
                resolve(new Response(null));
            });
        });
    });

    /**
     * Message Endpoint for Model Context Protocol
     * Receives JSON-RPC messages and routes to the appropriate SSE session
     */
    app.post("/messages", async (c) => {
        const req = (c.env as { incoming?: IncomingMessage })?.incoming;
        const res = (c.env as { outgoing?: ServerResponse })?.outgoing;
        const sessionId = c.req.query("sessionId");

        if (!sessionId) {
            return c.json({ error: "Missing sessionId query parameter" }, 400);
        }

        const transport = transports.get(sessionId);
        if (!transport) {
            return c.json({ error: `No active SSE transport session found for id '${sessionId}'` }, 404);
        }

        if (!req || !res) {
            return c.json({ error: "Requires Node.js server environment" }, 500);
        }

        patchNodeResponse(res);
        await transport.handlePostMessage(req, res);

        return new Response(null);
    });

    return app;
}
