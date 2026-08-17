import { query } from "@/libs/db";
import type { TCatalogItemSchema, TVectorLayer } from "@/schema";


interface IFindAllGeomObject {
    schemaName?: string
}

type TQueryResult = Omit<TCatalogItemSchema, 'id'> & {
    schema_name: string
    name: string
}

export async function findAllGeomObject(params: IFindAllGeomObject) {
    const sql = `
    SELECT
        n.nspname AS schema_name,
        c.relname AS name,

        CASE c.relkind
            WHEN 'r' THEN 'table'
            WHEN 'v' THEN 'view'
            WHEN 'm' THEN 'materialized_view'
        END AS type,

        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'name', a.attname,

                    'type',
                    postgis_typmod_type(a.atttypmod),

                    'srid',
                    postgis_typmod_srid(a.atttypmod),

                    'dimensions',
                    postgis_typmod_dims(a.atttypmod)
                )
                ORDER BY a.attnum
            )
            FROM pg_catalog.pg_attribute a
            WHERE a.attrelid = c.oid
                AND a.attnum > 0
                AND NOT a.attisdropped
                AND a.atttypid = 'geometry'::regtype
        ) AS geometry_columns

    FROM pg_catalog.pg_class c

    JOIN pg_catalog.pg_namespace n
        ON n.oid = c.relnamespace

    WHERE
        c.relkind IN ('r', 'v', 'm')

        AND n.nspname NOT IN (
            'pg_catalog',
            'information_schema',
            'pg_toast'
        )

        AND EXISTS (
            SELECT 1
            FROM pg_catalog.pg_attribute a
            WHERE a.attrelid = c.oid
                AND a.attnum > 0
                AND NOT a.attisdropped
                AND a.atttypid = 'geometry'::regtype
        )

        AND (
            $1::text IS NULL
            OR n.nspname = $1
        )

    ORDER BY
        n.nspname,
        c.relname;
    `;

    try {
        const result = await query<TQueryResult>(sql, [params.schemaName ?? null]);
        return result.rows;
    } catch (e) {
        console.error(e)
        throw new Error('DB_ERROR')
    }
}

export interface IFindVectorLayerParams {
    schemaName: string;
    tableName: string;
}

export interface ITableGeomLayerResult {
    schema_name: string;
    table_name: string;
    geometry_column: string;
    geometry_type: string;
    srid: number;
    table_description?: string;
    geometry_description?: string;
    fields: Record<string, string>;
}

export async function findTableGeomLayers(params: IFindVectorLayerParams): Promise<ITableGeomLayerResult[]> {
    const sql = `
    SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        g.attname AS geometry_column,
        postgis_typmod_type(g.atttypmod) AS geometry_type,
        postgis_typmod_srid(g.atttypmod) AS srid,
        obj_description(c.oid, 'pg_class') AS table_description,
        col_description(c.oid, g.attnum) AS geometry_description,
        COALESCE(
            jsonb_object_agg(
                a.attname,
                format_type(a.atttypid, NULL)
            ) FILTER (WHERE a.attname IS NOT NULL),
            '{}'::jsonb
        ) AS fields
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n
        ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute g
        ON g.attrelid = c.oid
        AND g.attnum > 0
        AND NOT g.attisdropped
        AND g.atttypid = 'geometry'::regtype
    LEFT JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.oid
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND a.atttypid != 'geometry'::regtype
    WHERE
        n.nspname = $1
        AND c.relname = $2
        AND c.relkind IN ('r', 'v', 'm')
    GROUP BY
        n.nspname,
        c.relname,
        c.oid,
        g.attname,
        g.atttypmod,
        g.attnum
    ORDER BY
        g.attnum;
    `;

    try {
        const result = await query<ITableGeomLayerResult>(sql, [params.schemaName, params.tableName]);
        return result.rows;
    } catch (e) {
        console.error(e);
        throw new Error('DB_ERROR');
    }
}

export async function findVectorLayerByTable(params: IFindVectorLayerParams): Promise<TVectorLayer | null> {
    const layers = await findTableGeomLayers(params);
    if (layers.length === 0) return null;
    const first = layers[0];
    return {
        id: layers.length > 1 ? `${first.table_name}_${first.geometry_column}` : first.table_name,
        fields: first.fields,
    };
}

export interface IFindVectorLayersParams {
    schemaName?: string;
    tableNames?: string[];
}

export async function findVectorLayers(params: IFindVectorLayersParams = {}): Promise<TVectorLayer[]> {
    const sql = `
    SELECT
        c.relname AS id,
        COALESCE(
            jsonb_object_agg(
                a.attname,
                format_type(a.atttypid, NULL)
            ) FILTER (WHERE a.attname IS NOT NULL),
            '{}'::jsonb
        ) AS fields
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n
        ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.oid
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND a.atttypid != 'geometry'::regtype
    WHERE
        c.relkind IN ('r', 'v', 'm')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND (
            $1::text IS NULL
            OR n.nspname = $1
        )
        AND (
            $2::text[] IS NULL
            OR c.relname = ANY($2)
        )
        AND EXISTS (
            SELECT 1
            FROM pg_catalog.pg_attribute ga
            WHERE ga.attrelid = c.oid
                AND ga.attnum > 0
                AND NOT ga.attisdropped
                AND ga.atttypid = 'geometry'::regtype
        )
    GROUP BY
        n.nspname,
        c.relname
    ORDER BY
        n.nspname,
        c.relname;
    `;

    try {
        const result = await query<TVectorLayer>(sql, [
            params.schemaName ?? null,
            params.tableNames ?? null,
        ]);
        return result.rows;
    } catch (e) {
        console.error(e);
        throw new Error('DB_ERROR');
    }
}