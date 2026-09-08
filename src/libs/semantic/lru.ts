/**
 * Minimal self-contained Map-based LRU for the semantic search caches.
 *
 * Keys embed the published index version (`sem:doc:<v>:<layerId>`, ...) so a
 * version bump naturally misses every stale entry without explicit purging; the
 * LRU only bounds memory for a given working set. Map preserves insertion
 * order, `get` re-inserts for LRU ordering, `set` deletes-then-inserts.
 * Deliberately no external dependency and no MVT l1-cache reuse (its keys and
 * byte-size accounting do not fit semantic vectors).
 */
export class LruCache<V> {
    private readonly entries = new Map<string, V>();

    constructor(private readonly maxSize: number) {
        if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
            throw new RangeError(`LruCache maxSize must be a positive integer, got ${String(maxSize)}`);
        }
    }

    get(key: string): V | undefined {
        const value = this.entries.get(key);
        if (value === undefined) return undefined;
        // Refresh recency (Map iteration order = insertion order = LRU order).
        this.entries.delete(key);
        this.entries.set(key, value);
        return value;
    }

    has(key: string): boolean {
        return this.entries.has(key);
    }

    set(key: string, value: V): void {
        if (this.entries.has(key)) {
            this.entries.delete(key);
        }
        this.entries.set(key, value);
        if (this.entries.size > this.maxSize) {
            // Evict the least-recently-used (first inserted) entry.
            const oldest = this.entries.keys().next();
            if (!oldest.done) this.entries.delete(oldest.value);
        }
    }

    get size(): number {
        return this.entries.size;
    }

    clear(): void {
        this.entries.clear();
    }
}
