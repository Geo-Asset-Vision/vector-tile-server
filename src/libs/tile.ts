export type XYZ = { z: number; x: number; y: number };

export type BBox = {
    wgs84: [number, number, number, number];
    webmercator?: [number, number, number, number];
};

export type MimeVectorTile =
    | "application/vnd.mapbox-vector-tile"
    | "application/x-protobuf"
    | "image/jpeg"
    | "image/png"
    | "image/webp";

export type TileResponse =
    | {
        ok: true;
        data: Buffer;
        contentType: MimeVectorTile;
        headers?: Record<string, string>;
        meta?: { bytes?: number; source?: string; layer?: string; eTag?: string };
    }
    | { ok: false; status: number; message?: string; headers?: Record<string, string> };

export interface SingleTileOptions {
    schema?: string;
    table: string;
    geom: string;
    idColumn?: string;
    srid?: number;
    extent?: number;
    buffer?: number;
    clip?: boolean;
    properties?: string[];
    layerName?: string;
    whereSql?: string;
    whereParams?: unknown[];
}

export type BoundsRow = {
    minx3857: number | null;
    miny3857: number | null;
    maxx3857: number | null;
    maxy3857: number | null;
    minlon: number | null;
    minlat: number | null;
    maxlon: number | null;
    maxlat: number | null;
};

export type ColumnInfoRow = {
    column_name: string;
    data_type: string;
    udt_name: string;
};

export function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

export function qualifyColumn(alias: string, column: string): string {
    return `${alias}.${quoteIdentifier(column)}`;
}

export function quoteTable(schema: string, table: string): string {
    return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function remapWhereClause(sql: string, startIndex: number): string {
    return sql.replace(/\$(\d+)/g, (placeholder) => {
        const offset = Number(placeholder.slice(1));
        return `$${startIndex + offset - 1}`;
    });
}

/**
 * Always produces a PostGIS expression in EPSG:3857 (Web Mercator).
 *
 * Strategy:
 * 1. If the geometry has SRID=0 (undefined), force-set it to the configured source SRID.
 * 2. If the geometry already has SRID=3857, use ST_SetSRID(geom, 3857) (no-op transform, faster).
 * 3. Otherwise, transform from the geometry's actual stored SRID to 3857 using ST_Transform.
 */
export function buildGeomExpression(alias: string, column: string, sourceSrid: number): string {
    const qualified = qualifyColumn(alias, column);
    if (sourceSrid === 3857) {
        return `ST_SetSRID(${qualified}, 3857)`;
    }
    return `ST_Transform(
    ST_SetSRID(
      ${qualified},
      CASE WHEN ST_SRID(${qualified}) = 0 THEN ${sourceSrid} ELSE ST_SRID(${qualified}) END
    ),
    3857
  )`;
}

export function appendWhereClause(layer: SingleTileOptions, params: unknown[]): string {
    if (!layer.whereSql) {
        return "";
    }
    const startIndex = params.length + 1;
    const clause = ` AND (${remapWhereClause(layer.whereSql, startIndex)})`;
    if (layer.whereParams?.length) {
        for (const value of layer.whereParams) {
            params.push(value);
        }
    }
    return clause;
}

export function toTileJsonFieldType(columnOrType: ColumnInfoRow | string | undefined): string {
    if (!columnOrType) {
        return "String";
    }

    const dataType = typeof columnOrType === "string" ? columnOrType.toLowerCase() : columnOrType.data_type.toLowerCase();
    const udtName = typeof columnOrType === "string" ? columnOrType.toLowerCase() : columnOrType.udt_name.toLowerCase();

    if (
        dataType.includes("int") ||
        ["int2", "int4", "int8", "serial", "bigserial"].includes(udtName)
    ) {
        return "Number";
    }

    if (
        dataType.includes("double") ||
        dataType.includes("numeric") ||
        dataType.includes("real") ||
        dataType.includes("float") ||
        ["float4", "float8", "numeric"].includes(udtName)
    ) {
        return "Number";
    }

    if (dataType === "boolean" || udtName === "bool") {
        return "Boolean";
    }

    if (dataType.includes("date") || dataType.includes("time")) {
        return "String";
    }

    return "String";
}