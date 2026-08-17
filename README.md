# Vector Tile Server

High-performance PostGIS-backed Vector Tile Server built with Hono, PostGIS, TypeScript, and OpenAPI.

## Features

- **Dynamic Vector Tile Generation (MVT / PBF)** using PostGIS `ST_AsMVT` & `ST_TileEnvelope`.
- **Multi-Layer Support**: Renders multiple geometry columns per table as distinct layers in single vector tiles.
- **TileJSON 3.0.0 Metadata**: Auto-discovery of spatial tables/views and fields with bounding box calculation.
- **SQL WHERE Filtering**: Safe Pratt-parsed query sanitizer with column whitelisting and type coercion.
- **OpenAPI & Scalar API Docs**: Auto-generated interactive API documentation at `/docs` and `/openapi`.
- **API Key Security**: Optional API Key authentication via `X-API-Key` header.
- **Full Test Suite**: Comprehensive unit & integration testing via Vitest.

## Quick Start

```bash
# Install dependencies
pnpm install

# Start database container
docker compose up db -d

# Run dev server
pnpm dev
```

Visit the interactive API documentation at [http://localhost:3000/docs](http://localhost:3000/docs).

## Scripts

```bash
# Typecheck, lint, and run tests
pnpm check

# Run Vitest unit tests
pnpm test

# Build production bundle
pnpm build

# Generate random API key
pnpm generate:api-key
```

## Docker Deployment

To deploy the entire stack (Vector Tile Server + PostGIS) using Docker Compose:

```bash
# Build and start all services
docker compose up --build -d

# View logs
docker compose logs -f app
```
