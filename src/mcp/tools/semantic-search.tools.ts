import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { SEMANTIC_TOP_K_MAX } from "@/libs/semantic/contracts";
import { SemanticSearchError } from "@/libs/semantic/contracts";
import { getRetrievalService } from "@/libs/semantic/runtime";

/**
 * Semantic spatial-catalog search tool.
 *
 * Registration is import-lazy: the semantic stack (`semanticEnv`, transformers,
 * model artifacts, Valkey) loads only on the first tool call via the
 * `runtime` seam — importing the MCP server never touches it. Each call
 * delegates to RetrievalService.search with the EXACT filters the caller
 * supplied (topK/schema/geometryType pass through unchanged). Absent
 * model/index or a degraded store throws a typed SemanticSearchError which is
 * mapped to `isError: true` with a serializable code + actionable message —
 * never a `[]` ranking.
 */
const inputSchema = {
    query: z
        .string()
        .trim()
        .min(1, "query must not be blank")
        .describe("Natural-language description of the spatial catalog layers to find (e.g. 'cari lahan kosong', 'jalan banjir')"),
    top_k: z
        .number()
        .int()
        .min(1, "top_k must be between 1 and 100")
        .max(SEMANTIC_TOP_K_MAX, `top_k must be between 1 and ${SEMANTIC_TOP_K_MAX}`)
        .optional()
        .describe("Maximum number of ranked results to return (1-100; defaults to SEMANTIC_TOP_K_DEFAULT)"),
    schema: z
        .string()
        .trim()
        .min(1, "schema must not be blank")
        .optional()
        .describe("Only return layers in this PostgreSQL schema (e.g. 'public')"),
    geometry_type: z
        .string()
        .trim()
        .min(1, "geometry_type must not be blank")
        .transform((v) => v.toLowerCase())
        .optional()
        .describe("Only return layers whose PostGIS geometry type matches (case-insensitive, e.g. 'polygon', 'multilinestring')"),
};

export function registerSemanticSearchTools(server: McpServer) {
    server.registerTool(
        "search_spatial_catalogs",
        {
            description:
                "Semantically search the spatial catalog index and return layers ranked by relevance. " +
                "Finds spatial layers whose schema/table/geometry descriptions best match a natural-language query " +
                "(e.g. 'cari lahan kosong'). Optional filters narrow to one schema or one PostGIS geometry type. " +
                "Returns ranked catalog references with their metadata and a cosine relevance score (0..1) — never raw vectors.",
            inputSchema,
        },
        async (args) => {
            try {
                const service = await getRetrievalService();
                const response = await service.search(args.query, {
                    ...(args.top_k !== undefined ? { topK: args.top_k } : {}),
                    ...(args.schema !== undefined ? { schema: args.schema } : {}),
                    ...(args.geometry_type !== undefined ? { geometryType: args.geometry_type } : {}),
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    query: response.query,
                                    total_results: response.results.length,
                                    // SemanticSearchResult carries ONLY {layer,
                                    // catalogId, geometryType, score,
                                    // descriptions} — never vectors.
                                    results: response.results,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                if (error instanceof SemanticSearchError) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        code: error.code,
                                        message: error.message,
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                    };
                }
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Semantic catalog search failed: ${(error as Error).message}`,
                        },
                    ],
                };
            }
        },
    );
}
