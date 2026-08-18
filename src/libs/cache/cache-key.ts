import crypto from "node:crypto";

export interface CacheKeyParams {
    catalogId: string;
    datasetVersion?: string | number;
    z: number;
    x: number;
    y: number;
    where?: string;
    geom?: string;
    properties?: string[] | string;
    extent?: number;
    buffer?: number;
    clip?: boolean;
    layerName?: string;
    tenantId?: string;
}

export interface CanonicalFilterObject {
    buffer?: number;
    clip?: boolean;
    extent?: number;
    geom?: string;
    layerName?: string;
    properties?: string[];
    tenantId?: string;
    where?: string;
}

/**
 * Validate tile coordinates according to Web Mercator XYZ tiling standards.
 */
export function validateTileCoordinates(z: number, x: number, y: number): void {
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
        throw new Error("Tile coordinates z, x, y must be integers");
    }
    if (z < 0 || z > 30) {
        throw new Error(`Tile zoom level z must be between 0 and 30 (received ${z})`);
    }
    if (x < 0 || y < 0) {
        throw new Error(`Tile coordinates x and y must be non-negative (received x: ${x}, y: ${y})`);
    }
    const maxTile = Math.pow(2, z);
    if (x >= maxTile || y >= maxTile) {
        throw new Error(
            `Tile coordinates out of bounds for zoom level ${z} (max: ${maxTile - 1}, received x: ${x}, y: ${y})`
        );
    }
}

/**
 * Produces a canonically sorted filter object containing only parameters that affect tile output.
 * Transport-only, tracing, and debugging flags are discarded.
 */
export function canonicalizeQueryParams(params: Partial<CacheKeyParams>): CanonicalFilterObject {
    const canonical: CanonicalFilterObject = {};

    // 1. Where clause (trimmed)
    if (params.where && typeof params.where === "string") {
        const trimmed = params.where.trim();
        if (trimmed.length > 0) {
            canonical.where = trimmed;
        }
    }

    // 2. Geometry column
    if (params.geom && typeof params.geom === "string") {
        const trimmed = params.geom.trim();
        if (trimmed.length > 0) {
            canonical.geom = trimmed;
        }
    }

    // 3. Properties list (sorted and deduplicated)
    if (params.properties) {
        let propList: string[] = [];
        if (Array.isArray(params.properties)) {
            propList = params.properties.map((p) => String(p).trim()).filter(Boolean);
        } else if (typeof params.properties === "string") {
            propList = params.properties
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean);
        }

        if (propList.length > 0) {
            // Deduplicate and sort deterministically
            canonical.properties = Array.from(new Set(propList)).sort();
        }
    }

    // 4. Extent (standardized number)
    if (params.extent !== undefined && params.extent !== null) {
        const extentNum = Number(params.extent);
        if (Number.isFinite(extentNum)) {
            canonical.extent = extentNum;
        }
    }

    // 5. Buffer (standardized number)
    if (params.buffer !== undefined && params.buffer !== null) {
        const bufferNum = Number(params.buffer);
        if (Number.isFinite(bufferNum)) {
            canonical.buffer = bufferNum;
        }
    }

    // 6. Clip (boolean)
    if (params.clip !== undefined && params.clip !== null) {
        canonical.clip = Boolean(params.clip);
    }

    // 7. Custom layer name
    if (params.layerName && typeof params.layerName === "string") {
        const trimmed = params.layerName.trim();
        if (trimmed.length > 0) {
            canonical.layerName = trimmed;
        }
    }

    // 8. Multi-tenant / security scope
    if (params.tenantId && typeof params.tenantId === "string") {
        const trimmed = params.tenantId.trim();
        if (trimmed.length > 0) {
            canonical.tenantId = trimmed;
        }
    }

    return canonical;
}

/**
 * Generates a stable SHA-256 hash for canonical query parameters.
 */
export function generateQueryHash(canonical: CanonicalFilterObject): string {
    const keys = Object.keys(canonical).sort() as Array<keyof CanonicalFilterObject>;

    // Deterministic JSON representation with sorted keys
    const sortedObj: Record<string, unknown> = {};
    for (const key of keys) {
        sortedObj[key] = canonical[key];
    }

    const jsonString = JSON.stringify(sortedObj);
    return crypto.createHash("sha256").update(jsonString).digest("hex").slice(0, 16);
}

/**
 * Builds a deterministic, versioned cache key:
 * Format: mvt:v1:{layer}:d{datasetVersion}:z{z}:x{x}:y{y}:q{queryHash}[:t{tenantId}]
 */
export function buildTileCacheKey(params: CacheKeyParams): string {
    if (!params.catalogId || typeof params.catalogId !== "string") {
        throw new Error("catalogId is required to generate cache key");
    }

    // Validate coordinates to prevent cache penetration with invalid keys
    validateTileCoordinates(params.z, params.x, params.y);

    const layer = params.catalogId.trim().toLowerCase();
    const datasetVersion = params.datasetVersion !== undefined && params.datasetVersion !== null
        ? String(params.datasetVersion)
        : "1";

    const canonical = canonicalizeQueryParams(params);
    const queryHash = generateQueryHash(canonical);

    let key = `mvt:v1:${layer}:d${datasetVersion}:z${params.z}:x${params.x}:y${params.y}:q${queryHash}`;

    if (canonical.tenantId) {
        key += `:t${canonical.tenantId}`;
    }

    return key;
}
