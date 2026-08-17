import type { Context } from "hono";
import { discoverCatalog, getTileJSONDetail } from "@/services/catalog.service";

export async function catalogDiscovery(c: Context) {
    try {
        const schemaName = c.req.query("schema") || c.req.query("schemaName");
        const result = await discoverCatalog(schemaName);
        return c.json(result);
    } catch (e) {
        console.error(e);
        throw new Error("Internal Server Error");
    }
}

export async function getTileJSON(c: Context) {
    const catalogId = c.req.param("catalog_id") || c.req.param("id");

    if (!catalogId) {
        return c.json({ error: "Catalog ID is required" }, 400);
    }

    const where = c.req.query("where");

    try {
        const result = await getTileJSONDetail(catalogId, { where });
        return c.json(result);
    } catch (e) {
        if (e instanceof Error) {
            if (e.message === "INVALID_WHERE_PARAM") {
                return c.json({ error: "Invalid or unauthorized 'where' filter parameter" }, 400);
            }
            if (e.message === "CATALOG_NOT_FOUND") {
                return c.json({ error: "Spatial catalog item not found" }, 404);
            }
        }
        console.error(e);
        return c.json({ error: "Internal Server Error" }, 500);
    }
}
