import { query } from "@/libs/db";
import {
  type SingleTileOptions,
  type XYZ,
  type BoundsRow,
  buildGeomExpression,
  appendWhereClause,
  qualifyColumn,
  quoteTable,
} from "@/libs/tile";

export async function findVectorTileBuffer(
  layer: SingleTileOptions,
  xyz: XYZ
): Promise<Buffer> {
  const srid = layer.srid ?? 4326;
  if (!Number.isInteger(srid) || srid <= 0) {
    throw new Error(
      `Invalid SRID ${srid} for layer "${layer.layerName ?? layer.table}". SRID must be a positive integer.`
    );
  }

  const params: unknown[] = [xyz.z, xyz.x, xyz.y];
  const addParam = (value: unknown) => {
    params.push(value);
    return params.length;
  };

  const schema = layer.schema ?? "public";
  const extentParam = addParam(layer.extent ?? 4096);
  const bufferParam = addParam(layer.buffer ?? 64);
  const clipParam = addParam(layer.clip ?? true);
  const layerNameParam = addParam(layer.layerName ?? layer.table);

  const geomExpr = buildGeomExpression("src", layer.geom, srid);

  const attributeColumns: string[] = [];
  const addedProps = new Set<string>();

  if (layer.idColumn) {
    attributeColumns.push(qualifyColumn("src", layer.idColumn));
    addedProps.add(layer.idColumn);
  }
  if (layer.properties?.length) {
    for (const prop of layer.properties) {
      if (!addedProps.has(prop)) {
        attributeColumns.push(qualifyColumn("src", prop));
        addedProps.add(prop);
      }
    }
  }

  const whereClause = appendWhereClause(layer, params);

  const selectColumns = [
    ...attributeColumns,
    `ST_AsMVTGeom(
          ${geomExpr},
          bounds.g,
          $${extentParam},
          $${bufferParam},
          $${clipParam}
        ) AS mvtgeom`
  ].join(",\n        ");

  const sql = `
      WITH tile_bounds AS (
        SELECT ST_TileEnvelope($1::int, $2::int, $3::int) AS g
      )
      SELECT COALESCE(
        (
          SELECT ST_AsMVT(layer_0, $${layerNameParam}, $${extentParam}, 'mvtgeom')
          FROM (
            SELECT
              ${selectColumns}
            FROM ${quoteTable(schema, layer.table)} AS src
            CROSS JOIN tile_bounds AS bounds
            WHERE ${geomExpr} && bounds.g
            ${whereClause}
          ) AS layer_0
        ),
        ''::bytea
      ) AS tile;
    `;

  try {
    const result = await query<{ tile: Buffer | null }>(sql, params);
    return result.rows[0]?.tile ?? Buffer.alloc(0);
  } catch (error) {
    console.error("PostGIS findVectorTileBuffer error:", error);
    throw error;
  }
}

export async function findLayerExtentBounds(
  layer: SingleTileOptions
): Promise<BoundsRow | null> {
  const schema = layer.schema ?? "public";
  const srid = layer.srid ?? 4326;
  const params: unknown[] = [];
  const whereClause = appendWhereClause(layer, params);
  const geomExpr = buildGeomExpression("src", layer.geom, srid);

  const sql = `
      WITH ext AS (
        SELECT ST_Extent(${geomExpr}) AS ext_3857
        FROM ${quoteTable(schema, layer.table)} AS src
        WHERE ${qualifyColumn("src", layer.geom)} IS NOT NULL
        ${whereClause}
      )
      SELECT
        ST_XMin(ext_3857) AS minx3857,
        ST_YMin(ext_3857) AS miny3857,
        ST_XMax(ext_3857) AS maxx3857,
        ST_YMax(ext_3857) AS maxy3857,
        ST_XMin(ST_Transform(ST_SetSRID(ext_3857::geometry, 3857), 4326)) AS minlon,
        ST_YMin(ST_Transform(ST_SetSRID(ext_3857::geometry, 3857), 4326)) AS minlat,
        ST_XMax(ST_Transform(ST_SetSRID(ext_3857::geometry, 3857), 4326)) AS maxlon,
        ST_YMax(ST_Transform(ST_SetSRID(ext_3857::geometry, 3857), 4326)) AS maxlat
      FROM ext;
    `;

  try {
    const result = await query<BoundsRow>(sql, params);
    const row = result.rows[0];
    if (!row || row.minlon == null || row.minlat == null || row.maxlon == null || row.maxlat == null) {
      return null;
    }
    return row;
  } catch (error) {
    console.error("PostGIS findLayerExtentBounds error:", error);
    throw error;
  }
}