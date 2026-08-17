import { Hono } from "hono";
import { getTileController } from "@/controllers/tile.controller";
import { describeRoute, validator } from "hono-openapi";
import { GetTileParamsSchema, GetTileQuerySchema } from "@/schema/tile.schema";
import { withAPIKey } from "@/middleware";
import env from "@/libs/env";

const router = new Hono();

router.use(withAPIKey);

router.get(
    "/:catalog_id/:z/:x/:y",
    describeRoute({
        description: "Get Vector Tile (MVT/PBF) for a specific Spatial Catalog item",
        security: env.API_KEY
            ? [
                  {
                      API_KEY: [],
                  },
              ]
            : [],
        responses: {
            200: {
                description: "Binary Mapbox Vector Tile (MVT/PBF)",
                content: {
                    "application/vnd.mapbox-vector-tile": {
                        schema: {
                            type: "string",
                            format: "binary",
                        },
                    },
                },
            },
            204: {
                description: "No content (empty tile)",
            },
            400: {
                description: "Bad Request (invalid tile coordinates or filter syntax)",
            },
            401: {
                description: "Unauthorized (Invalid or missing API key)",
            },
            404: {
                description: "Spatial Catalog item not found",
            },
            500: {
                description: "Internal server error",
            },
        },
    }),
    validator("param", GetTileParamsSchema),
    validator("query", GetTileQuerySchema),
    getTileController
);

export default router;