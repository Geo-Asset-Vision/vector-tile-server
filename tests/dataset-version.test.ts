import { describe, it, expect } from "vitest";
import { InMemoryDatasetVersionProvider } from "../src/libs/cache/dataset-version";
import { buildTileCacheKey } from "../src/libs/cache/cache-key";

describe("Dataset Version Provider Tests", () => {
    it("should return default version 1 when no version is explicitly set", async () => {
        const provider = new InMemoryDatasetVersionProvider(1);
        const version = await provider.getVersion("buildings");
        expect(version).toBe(1);
    });

    it("should allow setting and retrieving custom version per layer", async () => {
        const provider = new InMemoryDatasetVersionProvider(1);
        await provider.setVersion("buildings", 42);
        await provider.setVersion("roads", "v2.5");

        expect(await provider.getVersion("buildings")).toBe(42);
        expect(await provider.getVersion("roads")).toBe("v2.5");
        expect(await provider.getVersion("parcels")).toBe(1); // Default
    });

    it("should support bumping version incrementally for logical invalidation", async () => {
        const provider = new InMemoryDatasetVersionProvider(100);
        const v1 = await provider.getVersion("cadastre");
        expect(v1).toBe(100);

        const v2 = await provider.bumpVersion("cadastre");
        expect(v2).toBe(101);

        const v3 = await provider.bumpVersion("cadastre");
        expect(v3).toBe(102);

        expect(await provider.getVersion("cadastre")).toBe(102);
    });

    it("should generate distinct cache keys when layer version increments", async () => {
        const provider = new InMemoryDatasetVersionProvider(1);

        const keyBefore = buildTileCacheKey({
            catalogId: "public.parcels",
            datasetVersion: await provider.getVersion("public.parcels"),
            z: 14,
            x: 100,
            y: 200,
        });

        // Data updated in PostGIS -> bump version
        await provider.bumpVersion("public.parcels");

        const keyAfter = buildTileCacheKey({
            catalogId: "public.parcels",
            datasetVersion: await provider.getVersion("public.parcels"),
            z: 14,
            x: 100,
            y: 200,
        });

        expect(keyBefore).toContain(":d1:");
        expect(keyAfter).toContain(":d2:");
        expect(keyBefore).not.toBe(keyAfter);
    });
});
