import { Hono } from "hono";
import { catalogDiscovery, getTileJSON } from "@/controllers/catalog.controller";
import { describeRoute, resolver, validator } from "hono-openapi";
import {
    ListCatalogItemSchema,
    ListCatalogQuerySchema,
    GetCatalogDetailParamsSchema,
    GetCatalogDetailQuerySchema,
    TileJSONSchema,
} from "@/schema/catalog.schema";
import { withAPIKey } from "@/middleware";
import env from "@/libs/env";

const router = new Hono();

router.use(withAPIKey);

router.get(
    "/",
    describeRoute({
        description: "Get List of Spatial Catalog",
        security: env.API_KEY
            ? [
                  {
                      API_KEY: [],
                  },
              ]
            : [],
        responses: {
            200: {
                description: "Successful response (List of spatial catalog items)",
                content: {
                    "application/json": {
                        schema: resolver(ListCatalogItemSchema),
                    },
                },
            },
            401: {
                description: "Unauthorized (Invalid or missing API key)",
            },
            500: {
                description: "Internal server error",
            },
        },
    }),
    validator("query", ListCatalogQuerySchema),
    catalogDiscovery
);

router.get(
    "/:catalog_id",
    describeRoute({
        description: "Get TileJSON for a specific Spatial Catalog (supports optional 'where' query param)",
        security: env.API_KEY
            ? [
                  {
                      API_KEY: [],
                  },
              ]
            : [],
        responses: {
            200: {
                description: "Successful response (TileJSON metadata)",
                content: {
                    "application/json": {
                        schema: resolver(TileJSONSchema),
                    },
                },
            },
            400: {
                description: "Bad request (invalid filter syntax or missing catalog ID)",
            },
            401: {
                description: "Unauthorized (Invalid or missing API key)",
            },
            404: {
                description: "Spatial catalog item not found",
            },
            500: {
                description: "Internal server error",
            },
        },
    }),
    validator("param", GetCatalogDetailParamsSchema),
    validator("query", GetCatalogDetailQuerySchema),
    getTileJSON
);

export default router;