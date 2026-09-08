import type { RetrievalService } from './retrieval.js';

/**
 * Lazy wiring of the MCP tool to the production RetrievalService.
 *
 * Importing this module costs nothing: the semantic stack (env singletons,
 * transformers runtime, onnx artifacts, Valkey) is loaded ONLY on the first
 * `getRetrievalService()` call via dynamic imports, and the connection is
 * attempted exactly once per process. A failed connect does NOT throw here —
 * RetrievalService.readIndex() gates on store health and surfaces a typed
 * INDEX_UNAVAILABLE when the store is down, so the tool can map it to an
 * actionable isError instead of dying at boot.
 *
 * MCP unit tests never hit this module: they `vi.mock('@/libs/semantic/runtime')`
 * and substitute a fake RetrievalService.
 */
let servicePromise: Promise<RetrievalService> | null = null;

async function buildRetrievalService(): Promise<RetrievalService> {
    const [{ default: env }, { ValkeyClient }, { IndexStorage }, { RetrievalService }, { modelContractFingerprint }, { isCatalogAllowed }] =
        await Promise.all([
            import('@/libs/env'),
            import('@/libs/cache/valkey-client.js'),
            import('./index-storage.js'),
            import('./retrieval.js'),
            import('./embedding.js'),
            import('@/libs/map-config.js'),
        ]);

    const valkey = new ValkeyClient({
        host: env.VALKEY_HOST || 'localhost',
        port: env.VALKEY_PORT || 6379,
        password: env.VALKEY_PASSWORD || undefined,
        connectTimeoutMs: env.VALKEY_CONNECT_TIMEOUT_MS ?? 1000,
        commandTimeoutMs: env.VALKEY_COMMAND_TIMEOUT_MS ?? 500,
    });
    // Best-effort connect. On failure readIndex() reports INDEX_UNAVAILABLE.
    await valkey.connect();

    const storage = new IndexStorage(valkey);
    // Pin the contract fingerprint at first use; a model re-provisioned between
    // calls is the operator's concern (refresh re-verifies per run).
    const contract = modelContractFingerprint();
    return new RetrievalService({
        storage,
        contractFingerprint: () => contract,
        allowedLayers: (schemaName, tableName) => isCatalogAllowed(schemaName, tableName),
    });
}

/** Process-wide singleton retrieval service (first call builds it). */
export function getRetrievalService(): Promise<RetrievalService> {
    servicePromise ??= buildRetrievalService();
    return servicePromise;
}
