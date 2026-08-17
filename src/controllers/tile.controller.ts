import type { Context } from "hono";
import { getTile } from "@/services/tile.service";

export async function getTileController(c: Context) {
    const catalogId = c.req.param("catalog_id") || c.req.param("id");
    const rawZ = c.req.param("z");
    const rawX = c.req.param("x");
    const rawY = c.req.param("y");

    if (!catalogId || !rawZ || !rawX || !rawY) {
        return c.json({ error: "Missing required path parameters catalog_id, z, x, y" }, 400);
    }

    const z = parseInt(rawZ, 10);
    const x = parseInt(rawX, 10);
    const yStr = rawY.replace(/\.(mvt|pbf)$/i, "");
    const y = parseInt(yStr, 10);

    if (isNaN(z) || isNaN(x) || isNaN(y) || z < 0 || z > 30 || x < 0 || y < 0) {
        return c.json({ error: "Invalid tile coordinates (z, x, y)" }, 400);
    }

    const maxTile = Math.pow(2, z);
    if (x >= maxTile || y >= maxTile) {
        return c.json({ error: "Tile coordinates out of bounds for zoom level" }, 400);
    }

    const where = c.req.query("where");
    const geom = c.req.query("geom");
    const propertiesRaw = c.req.query("properties") || c.req.query("cols");
    const properties = propertiesRaw
        ? propertiesRaw.split(",").map((p) => p.trim()).filter(Boolean)
        : undefined;

    const extentRaw = c.req.query("extent");
    const extent = extentRaw ? parseInt(extentRaw, 10) : undefined;

    const bufferRaw = c.req.query("buffer");
    const buffer = bufferRaw ? parseInt(bufferRaw, 10) : undefined;

    const clipRaw = c.req.query("clip");
    const clip = clipRaw !== undefined ? clipRaw === "true" || clipRaw === "1" : undefined;

    const layerName = c.req.query("layer") || c.req.query("layerName");

    try {
        const result = await getTile({
            catalogId,
            z,
            x,
            y,
            where,
            geom,
            properties,
            extent,
            buffer,
            clip,
            layerName,
        });

        if (!result.ok) {
            if (result.status === 204) {
                return c.body(null, 204, {
                    "Content-Type": "application/vnd.mapbox-vector-tile",
                });
            }
            return c.json(
                { error: result.message || "Tile error" },
                result.status as 400 | 404 | 500
            );
        }

        return c.body(new Uint8Array(result.data), 200, {
            "Content-Type": result.contentType,
            "Cache-Control": "public, max-age=3600",
            ...result.headers,
        });
    } catch (e) {
        console.error(e);
        return c.json({ error: "Internal Server Error" }, 500);
    }
}
