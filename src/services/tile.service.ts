import {
    findVectorTileBuffer,
    findLayerExtentBounds,
} from "@/repositories/tile.repo";
import { findTableGeomLayers } from "@/repositories/catalog.repo";
import sanitizeWhereParam from "@/libs/sanitized-query";
import env from "@/libs/env";
import type {
    SingleTileOptions,
    XYZ,
    BBox,
    TileResponse,
} from "@/libs/tile";

export interface GetTileRequestOptions {
    catalogId: string;
    z: number;
    x: number;
    y: number;
    where?: string;
    geom?: string;
    properties?: string[];
    extent?: number;
    buffer?: number;
    clip?: boolean;
    layerName?: string;
}

export async function getVectorTile(
    layerOptions: SingleTileOptions,
    xyz: XYZ
): Promise<TileResponse> {
    try {
        const buf = await findVectorTileBuffer(layerOptions, xyz);
        if (!buf || !buf.length) {
            return { ok: false, status: 204, message: "Empty tile" };
        }

        const layerName = layerOptions.layerName ?? layerOptions.table;

        return {
            ok: true,
            data: buf,
            contentType: "application/vnd.mapbox-vector-tile",
            meta: {
                bytes: buf.length,
                source: "postgis",
                layer: layerName,
            },
        };
    } catch (error: unknown) {
        const message = error instanceof Error && error.message ? error.message : "PostGIS tile error";
        return { ok: false, status: 400, message: `Invalid filter condition or database query error: ${message}` };
    }
}

export async function getTile(
    options: GetTileRequestOptions
): Promise<TileResponse> {
    const { catalogId, z, x, y } = options;

    let schemaName = env.POSTGIS_SCHEMA || "public";
    let tableName = catalogId;

    if (catalogId.includes(".")) {
        const parts = catalogId.split(".");
        schemaName = parts[0];
        tableName = parts.slice(1).join(".");
    }

    const geomLayers = await findTableGeomLayers({ schemaName, tableName });
    if (!geomLayers || geomLayers.length === 0) {
        return {
            ok: false,
            status: 404,
            message: `Spatial catalog item '${catalogId}' not found`,
        };
    }

    let targetGeomLayers = geomLayers;
    if (options.geom) {
        const found = geomLayers.filter((g) => g.geometry_column === options.geom);
        if (found.length === 0) {
            return {
                ok: false,
                status: 400,
                message: `Geometry column '${options.geom}' not found in spatial catalog item '${catalogId}'`,
            };
        }
        targetGeomLayers = found;
    }

    const singleLayerOptionsList: SingleTileOptions[] = [];

    for (const geomLayer of targetGeomLayers) {
        const geomColumn = geomLayer.geometry_column;
        const srid = geomLayer.srid || 4326;
        const layerFields = geomLayer.fields || {};

        const allowedFields = new Set<string>();
        for (const key of Object.keys(layerFields)) {
            allowedFields.add(key);
            allowedFields.add(key.toLowerCase());
        }
        if (geomColumn) {
            allowedFields.add(geomColumn);
            allowedFields.add(geomColumn.toLowerCase());
        }

        let sanitizedWhereSql: string | undefined = undefined;
        if (options.where && options.where.trim().length > 0) {
            const sanitized = sanitizeWhereParam(options.where, {
                allowedFields,
                fieldTypes: layerFields,
            });
            if (sanitized === null) {
                return {
                    ok: false,
                    status: 400,
                    message: "Invalid or unauthorized 'where' filter parameter",
                };
            }
            sanitizedWhereSql = sanitized;
        }

        const validFields = new Set(Object.keys(layerFields));
        const properties = options.properties && options.properties.length > 0
            ? options.properties.filter((p) => validFields.has(p))
            : Object.keys(layerFields);

        const layerName = options.layerName
            ? (targetGeomLayers.length > 1 ? `${options.layerName}_${geomColumn}` : options.layerName)
            : (geomLayers.length > 1 ? `${tableName}_${geomColumn}` : tableName);

        singleLayerOptionsList.push({
            schema: schemaName,
            table: tableName,
            geom: geomColumn,
            srid: srid,
            extent: options.extent ?? 4096,
            buffer: options.buffer ?? 64,
            clip: options.clip ?? true,
            properties,
            layerName,
            whereSql: sanitizedWhereSql,
        });
    }

    try {
        const tileBuffers: Buffer[] = [];
        for (const layerOpt of singleLayerOptionsList) {
            const buf = await findVectorTileBuffer(layerOpt, { z, x, y });
            if (buf && buf.length > 0) {
                tileBuffers.push(buf);
            }
        }

        if (tileBuffers.length === 0) {
            return { ok: false, status: 204, message: "Empty tile" };
        }

        const combinedBuffer = Buffer.concat(tileBuffers);
        const combinedLayerNames = singleLayerOptionsList.map((l) => l.layerName).join(",");

        return {
            ok: true,
            data: combinedBuffer,
            contentType: "application/vnd.mapbox-vector-tile",
            meta: {
                bytes: combinedBuffer.length,
                source: "postgis",
                layer: combinedLayerNames,
            },
        };
    } catch (error: unknown) {
        const message = error instanceof Error && error.message ? error.message : "PostGIS tile error";
        return {
            ok: false,
            status: 400,
            message: `Invalid filter condition or database query error: ${message}`,
        };
    }
}

export async function getTileBounds(
    layerOptions: SingleTileOptions
): Promise<BBox> {
    try {
        const aggregate = await findLayerExtentBounds(layerOptions);

        if (!aggregate || aggregate.minlon == null || aggregate.minlat == null || aggregate.maxlon == null || aggregate.maxlat == null) {
            return { wgs84: [-180, -85, 180, 85] };
        }

        return {
            wgs84: [aggregate.minlon, aggregate.minlat, aggregate.maxlon, aggregate.maxlat],
            webmercator:
                aggregate.minx3857 != null && aggregate.miny3857 != null && aggregate.maxx3857 != null && aggregate.maxy3857 != null
                    ? [aggregate.minx3857, aggregate.miny3857, aggregate.maxx3857, aggregate.maxy3857]
                    : undefined,
        };
    } catch (error) {
        console.error("PostGIS findLayerExtentBounds error:", error);
        return { wgs84: [-180, -85, 180, 85] };
    }
}

export async function getTileCenter(
    layerOptions: SingleTileOptions,
    defaultZoom: number = 6
): Promise<[number, number, number]> {
    const bounds = await getTileBounds(layerOptions);
    const [minLon, minLat, maxLon, maxLat] = bounds.wgs84;
    const lon = (minLon + maxLon) / 2;
    const lat = (minLat + maxLat) / 2;

    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        return [0, 0, defaultZoom];
    }
    return [lon, lat, defaultZoom];
}