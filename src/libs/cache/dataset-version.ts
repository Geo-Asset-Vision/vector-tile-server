export interface DatasetVersionProvider {
    getVersion(layer: string, context?: Record<string, unknown>): Promise<string | number>;
    setVersion?(layer: string, version: string | number): Promise<void>;
    bumpVersion?(layer: string): Promise<string | number>;
}

/**
 * Bumping a layer's version invalidates its cached tiles (keyed on version).
 */
export class InMemoryDatasetVersionProvider implements DatasetVersionProvider {
    private versions = new Map<string, string | number>();
    private defaultVersion: string | number;

    constructor(defaultVersion: string | number = 1) {
        this.defaultVersion = defaultVersion;
    }

    async getVersion(layer: string): Promise<string | number> {
        const normalized = layer.toLowerCase();
        return this.versions.get(normalized) ?? this.defaultVersion;
    }

    async setVersion(layer: string, version: string | number): Promise<void> {
        const normalized = layer.toLowerCase();
        this.versions.set(normalized, version);
    }

    async bumpVersion(layer: string): Promise<string | number> {
        const normalized = layer.toLowerCase();
        const current = this.versions.get(normalized) ?? this.defaultVersion;
        const currentNum = typeof current === "number" ? current : parseInt(String(current), 10) || 1;
        const next = currentNum + 1;
        this.versions.set(normalized, next);
        return next;
    }

    clear(): void {
        this.versions.clear();
    }
}

/** Default global provider. */
export const defaultDatasetVersionProvider = new InMemoryDatasetVersionProvider(1);
