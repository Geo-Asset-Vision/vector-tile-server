import env from "@/libs/env";
import { TwoLevelTileCache } from "./two-level-cache";
import { defaultDatasetVersionProvider } from "./dataset-version";

export * from "./cache-key";
export * from "./dataset-version";
export * from "./l1-cache";
export * from "./valkey-client";
export * from "./l2-cache";
export * from "./single-flight";
export * from "./two-level-cache";
export * from "./metrics";

// Determine if Valkey is configured and enabled
const isValkeyConfigured = Boolean(env.VALKEY_HOST || env.VALKEY_URL);
const isL2Enabled = env.MVT_CACHE_L2_ENABLED && isValkeyConfigured;

export const tileCache = new TwoLevelTileCache({
    enabled: env.MVT_CACHE_ENABLED,
    l1TtlSeconds: env.MVT_CACHE_L1_TTL_SECONDS,
    l2TtlSeconds: env.MVT_CACHE_L2_TTL_SECONDS,
    emptyTtlSeconds: env.MVT_CACHE_L2_EMPTY_TTL_SECONDS,
    ttlJitterSeconds: env.MVT_CACHE_TTL_JITTER_SECONDS,
    singleFlightEnabled: env.MVT_CACHE_SINGLE_FLIGHT_ENABLED,
    l1Options: {
        enabled: env.MVT_CACHE_L1_ENABLED,
        maxItems: env.MVT_CACHE_L1_MAX_ITEMS,
        maxSizeMb: env.MVT_CACHE_L1_MAX_SIZE_MB,
        ttlMs: env.MVT_CACHE_L1_TTL_SECONDS * 1000,
    },
    l2Options: {
        enabled: isL2Enabled,
        host: env.VALKEY_HOST,
        port: env.VALKEY_PORT,
        password: env.VALKEY_PASSWORD,
        url: env.VALKEY_URL,
        connectTimeoutMs: env.VALKEY_CONNECT_TIMEOUT_MS,
        commandTimeoutMs: env.VALKEY_COMMAND_TIMEOUT_MS,
        failThreshold: env.VALKEY_CIRCUIT_FAIL_THRESHOLD,
        cooldownMs: env.VALKEY_CIRCUIT_COOLDOWN_MS,
        defaultTtlMs: env.MVT_CACHE_L2_TTL_SECONDS * 1000,
    },
});

// Auto-connect L2 if Valkey is configured and enabled
if (isL2Enabled) {
    tileCache.connect().catch(() => {
        // Handled internally by ValkeyClient
    });
}

export const datasetVersionProvider = defaultDatasetVersionProvider;
