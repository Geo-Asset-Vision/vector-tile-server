import env from "@/libs/env";
import { toTileJsonFieldType } from "@/libs/tile";
import { findAllGeomObject, findTableGeomLayers } from "@/repositories/catalog.repo";
import type { TListCatalogItemSchema, TTileJSONSchema, TVectorLayer } from "@/schema";
import { getTileBounds } from "@/services/tile.service";
import sanitizeWhereParam from "@/libs/sanitized-query";
import { assertWhereLength, explicitStableId, isCatalogAllowed, parseCatalogId } from "@/libs/map-config";

export interface GetTileJSONOptions {
    where?: string;
}

export async function discoverCatalog(schemaName?: string): Promise<TListCatalogItemSchema> {
    try {
        const requestedSchema = schemaName || env.POSTGIS_SCHEMA;
        if (requestedSchema && !isCatalogAllowed(requestedSchema)) return [];
        const rows = await findAllGeomObject({ schemaName: requestedSchema });

        return rows.filter((row) => isCatalogAllowed(row.schema_name, row.name)).map(row => ({
            id: `${row.schema_name}.${row.name}`,
            type: row.type,
            geometry_columns: row.geometry_columns,
        }));
    } catch (e) {
        console.error(e);
        throw new Error("CATALOG_DISCOVERY_ERROR");
    }
}

export async function getTileJSONDetail(
    catalogId: string,
    options?: GetTileJSONOptions
): Promise<TTileJSONSchema> {
    try {
        const { schemaName, tableName } = parseCatalogId(catalogId, env.POSTGIS_SCHEMA || "public");
        if (!isCatalogAllowed(schemaName, tableName)) throw new Error("CATALOG_NOT_FOUND");
        assertWhereLength(options?.where);

        const geomLayers = await findTableGeomLayers({ schemaName, tableName });
        if (!geomLayers || geomLayers.length === 0) {
            throw new Error("CATALOG_NOT_FOUND");
        }

        const allowedFields = new Set<string>();
        const combinedFieldTypes: Record<string, string> = {};

        for (const layer of geomLayers) {
            if (layer.geometry_column) {
                allowedFields.add(layer.geometry_column);
                allowedFields.add(layer.geometry_column.toLowerCase());
            }
            if (layer.fields) {
                for (const [colName, rawType] of Object.entries(layer.fields)) {
                    allowedFields.add(colName);
                    allowedFields.add(colName.toLowerCase());
                    combinedFieldTypes[colName] = rawType;
                }
            }
        }

        let sanitizedWhere: string | undefined = undefined;
        let rawWhereParam: string | undefined = undefined;

        if (options?.where && options.where.trim().length > 0) {
            rawWhereParam = options.where.trim();
            const sanitized = sanitizeWhereParam(rawWhereParam, {
                allowedFields,
                fieldTypes: combinedFieldTypes,
            });
            if (sanitized === null) {
                throw new Error("INVALID_WHERE_PARAM");
            }
            sanitizedWhere = sanitized;
        }

        const tileBaseUrl = (env.PUBLIC_TILE_BASE_URL || env.APP_BASE_URL).replace(/\/$/, "");
        let tilesUrl = `${tileBaseUrl}/tiles/${catalogId}/{z}/{x}/{y}`;
        if (rawWhereParam) {
            tilesUrl += `?where=${encodeURIComponent(rawWhereParam)}`;
        }

        const explicitId = explicitStableId(schemaName, tableName);
        const pkCols = geomLayers[0]?.primary_key_columns ?? [];
        const featureIdProperty = explicitId || (pkCols.length === 1 ? pkCols[0] : undefined);

        const vectorLayers: TVectorLayer[] = geomLayers.map((layer, _, arr) => {
            const layerId = arr.length > 1
                ? `${layer.table_name}_${layer.geometry_column}`
                : layer.table_name;

            const layerDescription = layer.geometry_description
                || layer.table_description
                || `Vector layer ${layerId} (${layer.geometry_type})`;

            const fields: Record<string, string> = {};
            if (layer.fields) {
                for (const [colName, rawType] of Object.entries(layer.fields)) {
                    fields[colName] = toTileJsonFieldType(rawType);
                }
            }

            return {
                id: layerId,
                description: layerDescription,
                minzoom: 0,
                maxzoom: 22,
                fields: featureIdProperty && !fields[featureIdProperty] ? { ...fields, [featureIdProperty]: "String" } : fields,
                featureIdProperty,
                highlightSupported: Boolean(featureIdProperty),
            };
        });

        // Compute combined bounds across all geometry layers of this catalog item
        let minLon = Infinity;
        let minLat = Infinity;
        let maxLon = -Infinity;
        let maxLat = -Infinity;

        for (const layer of geomLayers) {
            const lOptions = {
                schema: schemaName,
                table: tableName,
                geom: layer.geometry_column,
                srid: layer.srid || 4326,
                whereSql: sanitizedWhere,
            };
            const b = await getTileBounds(lOptions);
            if (b?.wgs84) {
                minLon = Math.min(minLon, b.wgs84[0]);
                minLat = Math.min(minLat, b.wgs84[1]);
                maxLon = Math.max(maxLon, b.wgs84[2]);
                maxLat = Math.max(maxLat, b.wgs84[3]);
            }
        }

        let bounds: [number, number, number, number] = [-180, -85, 180, 85];
        if (Number.isFinite(minLon) && Number.isFinite(minLat) && Number.isFinite(maxLon) && Number.isFinite(maxLat)) {
            bounds = [minLon, minLat, maxLon, maxLat];
        }

        const centerLon = (bounds[0] + bounds[2]) / 2;
        const centerLat = (bounds[1] + bounds[3]) / 2;
        const center: [number, number, number] = [
            Number.isFinite(centerLon) ? centerLon : 0,
            Number.isFinite(centerLat) ? centerLat : 0,
            6,
        ];

        const tableDesc = geomLayers[0]?.table_description || `Spatial catalog layer for ${schemaName}.${tableName}`;

        return {
            tilejson: "3.0.0",
            name: `${schemaName}.${tableName}`,
            description: tableDesc,
            version: "1.0.0",
            scheme: "xyz",
            minzoom: 0,
            maxzoom: 22,
            bounds,
            center,
            tiles: [tilesUrl],
            vector_layers: vectorLayers,
            featureIdProperty,
            highlightSupported: Boolean(featureIdProperty),
        };
    } catch (e) {
        if (e instanceof Error && (e.message === "INVALID_WHERE_PARAM" || e.message === "WHERE_TOO_LONG" || e.message === "CATALOG_NOT_FOUND")) {
            throw e;
        }
        console.error(e);
        throw new Error("TILEJSON_GENERATION_ERROR");
    }
}