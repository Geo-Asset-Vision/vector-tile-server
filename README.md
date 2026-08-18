# Vector Tile Server

High-performance PostGIS-backed Vector Tile Server built with Hono, PostGIS, TypeScript, and OpenAPI.

## Features

- **Dynamic Vector Tile Generation (MVT / PBF)** using PostGIS `ST_AsMVT` & `ST_TileEnvelope`.
- **Multi-Layer Support**: Renders multiple geometry columns per table as distinct layers in single vector tiles.
- **TileJSON 3.0.0 Metadata**: Auto-discovery of spatial tables/views and fields with bounding box calculation.
- **SQL WHERE Filtering**: Safe Pratt-parsed query sanitizer with column whitelisting and type coercion.
- **OpenAPI, Scalar & LLM Docs**: Auto-generated interactive API documentation at `/docs`, OpenAPI JSON schema at `/openapi`, and Markdown specification for LLMs at `/llms.txt` (via `@scalar/openapi-to-markdown`).
- **API Key Security**: Optional API Key authentication via `X-API-Key` header.
- **Full Test Suite**: Comprehensive unit & integration testing via Vitest.

## Quick Start

```bash
# Install dependencies
pnpm install

# Start database and cache containers
docker compose up db valkey -d

# Run dev server
pnpm dev
```

Visit the interactive API documentation at [http://localhost:3000/docs](http://localhost:3000/docs) or LLM Markdown at [http://localhost:3000/llms.txt](http://localhost:3000/llms.txt).

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

To deploy the entire stack (Vector Tile Server + PostGIS + Valkey) using Docker Compose:

```bash
# Copy production environment template
cp .env.production.example .env

# Build and start all services
docker compose up --build -d

# View logs
docker compose logs -f app
```

---

## 2-Level Vector Tile Cache Architecture

The server features a production-grade **2-level caching architecture** designed for high concurrency, low latency, and zero tile corruption:

```mermaid
flowchart TD
    Client(["Client (MapLibre / Leaflet / Web)"]) --> Req["GET /tiles/:catalog_id/:z/:x/:y"]
    Req --> Val{"1. Coordinate & Query<br/>Validation"}
    Val -->|Invalid| Err["400 Bad Request"]
    Val -->|Valid| Key["2. Deterministic Cache Key<br/>Canonical Hash + Dataset Version"]
    
    Key --> L1{"3. Check L1 Cache<br/>(In-Memory LRU)"}
    L1 -->|L1 HIT| ResL1["Return Binary Buffer<br/>(Sub-millisecond)"]
    
    L1 -->|L1 MISS| L2Check{"4. Check L2 Cache<br/>(Valkey / Redis)"}
    L2Check -->|L2 HIT| PromoteL1["Promote Tile to L1"] --> ResL2["Return Binary Buffer"]
    
    L2Check -->|L2 MISS / Degraded| SF{"5. Single-Flight<br/>Coalescing"}
    SF -->|Concurrent Duplicate| Waiter["Wait on In-Flight Promise"]
    SF -->|Leader Request| DB[("6. PostGIS Database<br/>ST_AsMVT & ST_TileEnvelope")]
    
    DB --> PBF["7. Binary MVT / PBF Buffer"]
    PBF --> SetL1["L1 SET (Synchronous)"]
    PBF --> SetL2["L2 SET (Async / Non-blocking)"]
    
    SetL1 --> Return["8. Send Response to Client<br/>(HTTP 200/204 + ETag)"]
    SetL2 -.-> Return
    Waiter --> Return
```

### Cache Features

- **Raw Binary Buffer Storage**: Tiles are stored as raw `Buffer` payloads directly in memory (L1) and Valkey (L2) with zero JSON or base64 overhead.
- **Deterministic & Versioned Cache Keys**:
  - Format: `mvt:v1:{layer}:d{datasetVersion}:z{z}:x{x}:y{y}:q{queryHash}[:t{tenantId}]`
  - Canonical query sorting ensures `?status=active&year=2026` and `?year=2026&status=active` generate identical cache keys.
  - Coordinate validation prevents cache penetration from malformed coordinates.
- **Single-Flight Request Coalescing**:
  - Prevents cache stampedes by coalescing simultaneous cold misses for the same tile into **1 PostGIS query per process**.
- **Valkey Resiliency & Circuit Breaker**:
  - Configurable connect and command timeouts.
  - Circuit breaker (`HEALTHY` $\rightarrow$ `DEGRADED` $\rightarrow$ `PROBING`) protects latency during remote cache outages.
  - If Valkey is down or unconfigured, the server seamlessly degrades to L1 LRU + PostGIS without failing requests.
- **HTTP Conditional Requests & Observability**:
  - Deterministic `ETag` generation and `If-None-Match` support (`304 Not Modified`).
  - Prometheus-compatible metrics endpoint at `GET /metrics` (`Accept: text/plain` or `application/json`).
  - Cache bypass support via `?cache=false` or `Cache-Control: no-cache`.

### Cache Configuration (`.env`)

```env
# Master Cache Toggle
MVT_CACHE_ENABLED=true

# L1 In-Process LRU Cache
MVT_CACHE_L1_ENABLED=true
MVT_CACHE_L1_MAX_ITEMS=10000
MVT_CACHE_L1_MAX_SIZE_MB=256
MVT_CACHE_L1_TTL_SECONDS=60          # Default: 1 minute (60s)

# L2 Valkey / KeyDB Remote Cache
# (If VALKEY_HOST or VALKEY_URL is omitted, L2 is disabled automatically)
VALKEY_HOST=localhost
VALKEY_PORT=6379
# VALKEY_PASSWORD=vtserver
# VALKEY_URL=redis://localhost:6379
VALKEY_CONNECT_TIMEOUT_MS=1000
VALKEY_COMMAND_TIMEOUT_MS=500

MVT_CACHE_L2_ENABLED=true
MVT_CACHE_L2_TTL_SECONDS=60          # Default: 1 minute (60s)
MVT_CACHE_L2_EMPTY_TTL_SECONDS=15    # Negative/empty tile caching TTL
MVT_CACHE_TTL_JITTER_SECONDS=10      # Anti-avalanche jitter window

# Stampede Prevention & Debugging
MVT_CACHE_SINGLE_FLIGHT_ENABLED=true # Process-local request coalescing
MVT_CACHE_DEBUG_HEADERS=false        # Injects X-MVT-Cache header
```

### Benchmark Suite

Run the built-in benchmark script to measure throughput, latency, and DB query reductions across all cache modes:

```bash
pnpm tsx scripts/benchmark-cache.ts
```

---

## Production Reverse Proxy (Nginx)

The server supports deployment under a **dedicated subdomain** or a **subpath** by setting the `APP_BASE_URL` environment variable.

### 1. Subdomain Deployment (`tiles.yourdomain.com`)

Set your environment variable:
```env
APP_BASE_URL="https://tiles.yourdomain.com"
```

Nginx configuration (`/etc/nginx/sites-available/tiles.yourdomain.com`):
```nginx
server {
    listen 80;
    server_name tiles.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name tiles.yourdomain.com;

    # SSL certificates (e.g. Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/tiles.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tiles.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable buffering for low-latency tile streaming
        proxy_buffering off;
    }
}
```

---

### 2. Subpath Deployment (`yourdomain.com/gis/` or `yourdomain.com/tiles/`)

Set your environment variable to include the subpath:
```env
APP_BASE_URL="https://yourdomain.com/gis"
```

Nginx configuration (`/etc/nginx/sites-available/yourdomain.com`):
```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    # SSL certificates
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # Note the trailing slashes on both location and proxy_pass:
    # This strips the `/gis/` prefix when forwarding to the vector tile server.
    location /gis/ {
        proxy_pass http://127.0.0.1:3000/;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
    }
}
```

> [!TIP]
> Setting `APP_BASE_URL` ensures that TileJSON metadata (`"tiles": ["https://yourdomain.com/gis/tiles/..."]`), OpenAPI schemas, and Scalar API docs at `/gis/docs` resolve all paths accurately across subpaths and subdomains.
