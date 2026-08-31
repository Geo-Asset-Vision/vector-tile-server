import { cacheMetrics } from "./metrics";

export interface SingleFlightResult<T> {
    value: T;
    shared: boolean;
}

/**
 * SingleFlight prevents cache stampedes by coalescing concurrent in-flight
 * executions for the exact same key within a single Node.js process.
 */
export class SingleFlight<T = unknown> {
    private inFlight = new Map<string, Promise<T>>();

    /**
     * Executes `fn` or joins an already in-flight promise for the same `key`.
     */
    async execute(key: string, fn: () => Promise<T>): Promise<SingleFlightResult<T>> {
        const existing = this.inFlight.get(key);
        if (existing) {
            cacheMetrics.recordSingleFlightWaiter();
            const value = await existing;
            return { value, shared: true };
        }

        cacheMetrics.recordSingleFlightExecution();

        const promise = (async () => {
            try {
                return await fn();
            } finally {
                // Ensure promise is ALWAYS removed on completion or failure
                this.inFlight.delete(key);
            }
        })();

        this.inFlight.set(key, promise);

        const value = await promise;
        return { value, shared: false };
    }

    /**
     * Number of currently in-flight operations.
     */
    get inFlightCount(): number {
        return this.inFlight.size;
    }

    /**
     * Clear all in-flight entries (e.g. for teardown/testing).
     */
    clear(): void {
        this.inFlight.clear();
    }
}
