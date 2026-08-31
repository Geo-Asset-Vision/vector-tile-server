-- Idempotent sample seed for vector-tile-server demo catalogs.
-- Safe to re-run: deterministic stable IDs and ON CONFLICT guards.

BEGIN;

CREATE TABLE IF NOT EXISTS sample_points (
  id integer PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'default',
  geom geometry(Point,4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS sample_lines (
  id integer PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'default',
  geom geometry(LineString,4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS sample_polygons (
  id integer PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'default',
  geom geometry(Polygon,4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS sample_multi_points (
  id integer PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'default',
  geom geometry(MultiPoint,4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS sample_multi_lines (
  id integer PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'default',
  geom geometry(MultiLineString,4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS sample_multi_polygons (
  id integer PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'default',
  geom geometry(MultiPolygon,4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS sample_points_geom ON sample_points USING gist (geom);
CREATE INDEX IF NOT EXISTS sample_lines_geom ON sample_lines USING gist (geom);
CREATE INDEX IF NOT EXISTS sample_polygons_geom ON sample_polygons USING gist (geom);
CREATE INDEX IF NOT EXISTS sample_multi_points_geom ON sample_multi_points USING gist (geom);
CREATE INDEX IF NOT EXISTS sample_multi_lines_geom ON sample_multi_lines USING gist (geom);
CREATE INDEX IF NOT EXISTS sample_multi_polygons_geom ON sample_multi_polygons USING gist (geom);

INSERT INTO sample_points (id, name, kind, geom)
VALUES
  (1, 'Jakarta Point', 'city', ST_SetSRID(ST_MakePoint(106.84513, -6.20876), 4326)),
  (2, 'Bandung Point', 'city', ST_SetSRID(ST_MakePoint(107.61913, -6.91746), 4326)),
  (3, 'Surabaya Point', 'city', ST_SetSRID(ST_MakePoint(112.75209, -7.25747), 4326)),
  (4, 'Yogyakarta Point', 'city', ST_SetSRID(ST_MakePoint(110.36502, -7.79558), 4326)),
  (5, 'Semarang Point', 'city', ST_SetSRID(ST_MakePoint(110.42033, -6.96661), 4326))
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    kind = EXCLUDED.kind,
    geom = EXCLUDED.geom;

INSERT INTO sample_lines (id, name, kind, geom)
VALUES
  (1, 'Jakarta Line', 'route', ST_SetSRID(ST_GeomFromText('LINESTRING(106.84513 -6.20876, 106.91723 -6.17511, 106.97251 -6.15837)'), 4326)),
  (2, 'Bandung Line', 'route', ST_SetSRID(ST_GeomFromText('LINESTRING(107.61913 -6.91746, 107.65000 -6.93000, 107.68500 -6.93900)'), 4326)),
  (3, 'Surabaya Line', 'route', ST_SetSRID(ST_GeomFromText('LINESTRING(112.75209 -7.25747, 112.77491 -7.26272, 112.79551 -7.28732)'), 4326)),
  (4, 'Yogyakarta Line', 'route', ST_SetSRID(ST_GeomFromText('LINESTRING(110.36502 -7.79558, 110.39012 -7.81021, 110.41575 -7.82010)'), 4326)),
  (5, 'Semarang Line', 'route', ST_SetSRID(ST_GeomFromText('LINESTRING(110.42033 -6.96661, 110.44599 -6.98320, 110.47104 -7.00002)'), 4326))
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    kind = EXCLUDED.kind,
    geom = EXCLUDED.geom;

INSERT INTO sample_polygons (id, name, kind, geom)
VALUES
  (1, 'Jakarta Area', 'district', ST_SetSRID(ST_GeomFromText('POLYGON((106.70000 -6.30000, 106.90000 -6.30000, 106.90000 -6.10000, 106.70000 -6.10000, 106.70000 -6.30000))'), 4326)),
  (2, 'Bandung Area', 'district', ST_SetSRID(ST_GeomFromText('POLYGON((107.50000 -7.00000, 107.70000 -7.00000, 107.70000 -6.85000, 107.50000 -6.85000, 107.50000 -7.00000))'), 4326)),
  (3, 'Surabaya Area', 'district', ST_SetSRID(ST_GeomFromText('POLYGON((112.65000 -7.35000, 112.85000 -7.35000, 112.85000 -7.20000, 112.65000 -7.20000, 112.65000 -7.35000))'), 4326)),
  (4, 'Yogyakarta Area', 'district', ST_SetSRID(ST_GeomFromText('POLYGON((110.30000 -7.85000, 110.48000 -7.85000, 110.48000 -7.76000, 110.30000 -7.76000, 110.30000 -7.85000))'), 4326)),
  (5, 'Semarang Area', 'district', ST_SetSRID(ST_GeomFromText('POLYGON((110.35000 -7.05000, 110.52000 -7.05000, 110.52000 -6.92000, 110.35000 -6.92000, 110.35000 -7.05000))'), 4326))
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    kind = EXCLUDED.kind,
    geom = EXCLUDED.geom;

INSERT INTO sample_multi_points (id, name, kind, geom)
VALUES
  (1, 'Jakarta Multi Point', 'cluster', ST_SetSRID(ST_GeomFromText('MULTIPOINT(106.84513 -6.20876, 106.86010 -6.21590)'), 4326)),
  (2, 'Bandung Multi Point', 'cluster', ST_SetSRID(ST_GeomFromText('MULTIPOINT(107.61913 -6.91746, 107.63350 -6.92680)'), 4326)),
  (3, 'Surabaya Multi Point', 'cluster', ST_SetSRID(ST_GeomFromText('MULTIPOINT(112.75209 -7.25747, 112.76890 -7.26410)'), 4326)),
  (4, 'Yogyakarta Multi Point', 'cluster', ST_SetSRID(ST_GeomFromText('MULTIPOINT(110.36502 -7.79558, 110.37990 -7.80210)'), 4326)),
  (5, 'Semarang Multi Point', 'cluster', ST_SetSRID(ST_GeomFromText('MULTIPOINT(110.42033 -6.96661, 110.43380 -6.97390)'), 4326))
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    kind = EXCLUDED.kind,
    geom = EXCLUDED.geom;

INSERT INTO sample_multi_lines (id, name, kind, geom)
VALUES
  (1, 'Jakarta Multi Route', 'network', ST_SetSRID(ST_GeomFromText('MULTILINESTRING((106.84513 -6.20876, 106.86010 -6.21590, 106.87490 -6.22280), (106.90020 -6.19050, 106.91500 -6.18520, 106.93010 -6.17990))'), 4326)),
  (2, 'Bandung Multi Route', 'network', ST_SetSRID(ST_GeomFromText('MULTILINESTRING((107.61913 -6.91746, 107.63350 -6.92680, 107.64890 -6.93500), (107.58010 -6.90230, 107.60050 -6.90920, 107.61913 -6.91746))'), 4326)),
  (3, 'Surabaya Multi Route', 'network', ST_SetSRID(ST_GeomFromText('MULTILINESTRING((112.75209 -7.25747, 112.76890 -7.26410, 112.78530 -7.27200), (112.73050 -7.24590, 112.74010 -7.25100, 112.75209 -7.25747))'), 4326)),
  (4, 'Yogyakarta Multi Route', 'network', ST_SetSRID(ST_GeomFromText('MULTILINESTRING((110.36502 -7.79558, 110.37990 -7.80210, 110.39500 -7.80870), (110.34010 -7.78420, 110.35320 -7.78980, 110.36502 -7.79558))'), 4326)),
  (5, 'Semarang Multi Route', 'network', ST_SetSRID(ST_GeomFromText('MULTILINESTRING((110.42033 -6.96661, 110.43380 -6.97390, 110.44790 -6.98120), (110.40020 -6.95520, 110.41100 -6.96080, 110.42033 -6.96661))'), 4326))
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    kind = EXCLUDED.kind,
    geom = EXCLUDED.geom;

INSERT INTO sample_multi_polygons (id, name, kind, geom)
VALUES
  (1, 'Jakarta Multi Area', 'districts', ST_SetSRID(ST_GeomFromText('MULTIPOLYGON(((106.70000 -6.30000, 106.80000 -6.30000, 106.80000 -6.20000, 106.70000 -6.20000, 106.70000 -6.30000)), ((106.82000 -6.18000, 106.90000 -6.18000, 106.90000 -6.10000, 106.82000 -6.10000, 106.82000 -6.18000)))'), 4326)),
  (2, 'Bandung Multi Area', 'districts', ST_SetSRID(ST_GeomFromText('MULTIPOLYGON(((107.50000 -7.00000, 107.60000 -7.00000, 107.60000 -6.92000, 107.50000 -6.92000, 107.50000 -7.00000)), ((107.62000 -6.90000, 107.70000 -6.90000, 107.70000 -6.85000, 107.62000 -6.85000, 107.62000 -6.90000)))'), 4326)),
  (3, 'Surabaya Multi Area', 'districts', ST_SetSRID(ST_GeomFromText('MULTIPOLYGON(((112.65000 -7.35000, 112.75000 -7.35000, 112.75000 -7.28000, 112.65000 -7.28000, 112.65000 -7.35000)), ((112.77000 -7.26000, 112.85000 -7.26000, 112.85000 -7.20000, 112.77000 -7.20000, 112.77000 -7.26000)))'), 4326)),
  (4, 'Yogyakarta Multi Area', 'districts', ST_SetSRID(ST_GeomFromText('MULTIPOLYGON(((110.30000 -7.85000, 110.38000 -7.85000, 110.38000 -7.80000, 110.30000 -7.80000, 110.30000 -7.85000)), ((110.40000 -7.78000, 110.48000 -7.78000, 110.48000 -7.76000, 110.40000 -7.76000, 110.40000 -7.78000)))'), 4326)),
  (5, 'Semarang Multi Area', 'districts', ST_SetSRID(ST_GeomFromText('MULTIPOLYGON(((110.35000 -7.05000, 110.42000 -7.05000, 110.42000 -6.99000, 110.35000 -6.99000, 110.35000 -7.05000)), ((110.44000 -6.97000, 110.52000 -6.97000, 110.52000 -6.92000, 110.44000 -6.92000, 110.44000 -6.97000)))'), 4326))
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    kind = EXCLUDED.kind,
    geom = EXCLUDED.geom;

COMMIT;
