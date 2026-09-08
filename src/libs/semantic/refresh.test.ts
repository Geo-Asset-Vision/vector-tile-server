import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ITableGeomLayerResult } from '@/repositories/catalog.repo';

import { SEMANTIC_DIM } from './contracts.js';
import { buildLayerDocument } from './document.js';
import type { CatalogLayerDetail, IndexReadResult, IndexWriteResult } from './index-storage.js';
import { refreshSemanticIndex, type RefreshSeams } from './refresh.js';

// ---------------------------------------------------------------------------
// A realistic ITableGeomLayerResult factory.
// ---------------------------------------------------------------------------
function makeLayerRow(over: {
    schema: string;
    table: string;
    geometry?: string;
    type?: string;
    desc?: string;
}): ITableGeomLayerResult {
    const layer = {
        schema_name: over.schema,
        table_name: over.table,
        geometry_column: over.geometry ?? 'geom',
        geometry_type: over.type ?? 'Polygon',
        srid: 4326,
        fields: {},
    };
    if (over.desc !== undefined) (layer as { table_description?: string }).table_description = over.desc;
    return layer;
}

function unitVec(axis: number): Float32Array {
    const v = new Float32Array(SEMANTIC_DIM);
    for (let i = 0; i < v.length; i++) v[i] = i % 3 === axis ? 1 : 0;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
}

/** Mock seams harness with an in-memory "current" state, like a real store. */
function makeHarness(initialLayers: ITableGeomLayerResult[] = []) {
    let currentLayers = initialLayers;
    let published: { version: number; docs: Map<string, Float32Array>; details: Record<string, CatalogLayerDetail> } | null = null;
    let embedCalls: string[][] = [];

    const seams: RefreshSeams = {
        async discover() {
            const tables = new Map<string, string[]>();
            for (const l of currentLayers) {
                const list = tables.get(l.schema_name) ?? [];
                if (!list.includes(l.table_name)) list.push(l.table_name);
                tables.set(l.schema_name, list);
            }
            return [...tables.entries()].map(([schemaName, names]) => names.map((tableName) => ({ schemaName, tableName }))).flat();
        },
        async layers(schemaName: string, tableName: string) {
            return currentLayers.filter(
                (l) => l.schema_name === schemaName && l.table_name === tableName,
            );
        },
        readPublished: vi.fn(async (): Promise<IndexReadResult> => {
            if (!published) return { status: 'not-found', code: 'INDEX_NOT_FOUND', message: 'none' };
            return {
                status: 'ok',
                version: published.version,
                manifest: {
                    version: published.version,
                    layers: [...published.docs.keys()],
                    documentCount: published.docs.size,
                    publishedAt: new Date().toISOString(),
                    embeddingContract: 'contract',
                    layerDetails: published.details,
                },
                documents: published.docs,
            };
        }),
        writeNew: vi.fn(async (version, docs, opts): Promise<IndexWriteResult> => {
            const details: Record<string, CatalogLayerDetail> = opts.layerDetails;
            published = { version, docs: new Map(docs), details };
            return { status: 'ok', version, documents: docs.size, previousVersion: version - 1, purgedKeys: 0 };
        }),
        embedBatch: vi.fn(async (texts: string[]): Promise<Float32Array[]> => {
            embedCalls.push(texts);
            return texts.map((_, i) => unitVec(i % 3));
        }),
    };

    return {
        seams,
        get embedCalls() {
            return embedCalls;
        },
        setLayers(layers: ITableGeomLayerResult[]) {
            currentLayers = layers;
        },
        async publish(v: number, layers: ITableGeomLayerResult[]) {
            const docs = new Map<string, Float32Array>();
            const details: Record<string, CatalogLayerDetail> = {};
            for (const l of layers) {
                const doc = buildLayerDocument(l);
                docs.set(doc.id, unitVec(0));
                details[doc.id] = {
                    fingerprint: doc.fingerprint,
                    geometryType: l.geometry_type,
                    ...(l.table_description ? { tableDescription: l.table_description } : {}),
                };
            }
            published = { version: v, docs, details };
        },
    };
}

describe('refreshSemanticIndex — unit', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('publishes version 1 on a fresh store (nothing to reuse)', async () => {
        const h = makeHarness([
            makeLayerRow({ schema: 'public', table: 'roads', desc: 'Jalan raya' }),
            makeLayerRow({ schema: 'gis', table: 'parcels', type: 'MultiPolygon' }),
        ]);
        const summary = await refreshSemanticIndex(h.seams, { embeddingContract: 'contract' });
        expect(summary.published).toBe(true);
        expect(summary.version).toBe(1);
        expect(summary.embedded).toBe(2);
        expect(summary.reused).toBe(0);
        expect(summary.layersCount).toBe(2);
        expect(h.embedCalls).toHaveLength(1); // ONE batch for both docs
        expect(h.embedCalls[0]).toHaveLength(2);
        expect(h.seams.writeNew).toHaveBeenCalledTimes(1);
    });

    it('publishes nothing when the catalog is byte-identical (no churn)', async () => {
        const layers = [
            makeLayerRow({ schema: 'public', table: 'roads', desc: 'Jalan raya' }),
            makeLayerRow({ schema: 'gis', table: 'parcels' }),
        ];
        const h = makeHarness(layers);
        // Seed a published v1 with the same layers.
        await h.publish(1, layers);
        const summary = await refreshSemanticIndex(h.seams, { embeddingContract: 'contract' });
        expect(summary.published).toBe(false);
        expect(summary.version).toBe(1);
        expect(summary.reused).toBe(2);
        expect(h.embedCalls).toHaveLength(0);
        expect(h.seams.writeNew).not.toHaveBeenCalled();
    });

    it('skips re-embedding unchanged layers and publishes v2 with only the delta embedded', async () => {
        const unchanged = makeLayerRow({ schema: 'public', table: 'roads', desc: 'Jalan raya' });
        const changed = makeLayerRow({ schema: 'gis', table: 'parcels', type: 'MultiPolygon', desc: 'old desc' });
        const h = makeHarness([unchanged, changed]);
        await h.publish(1, [unchanged, changed]);

        // Update one description and re-traverse: only 'parcels' changed.
        h.setLayers([
            makeLayerRow({ schema: 'public', table: 'roads', desc: 'Jalan raya' }),
            makeLayerRow({ schema: 'gis', table: 'parcels', type: 'MultiPolygon', desc: 'NEW desc' }),
        ]);

        const summary = await refreshSemanticIndex(h.seams, { embeddingContract: 'contract' });
        expect(summary.published).toBe(true);
        expect(summary.version).toBe(2);
        expect(summary.embedded).toBe(1); // only the changed layer
        expect(summary.reused).toBe(1); // unchanged layer copied forward
        expect(h.embedCalls).toHaveLength(1);
        expect(h.embedCalls[0]).toHaveLength(1);
        // Reused layer's vector is copied from the old store (no re-embed).
        expect(h.seams.writeNew).toHaveBeenCalledTimes(1);
        const writeArgs = (h.seams.writeNew as ReturnType<typeof vi.fn>).mock.calls[0] as [
            number,
            Map<string, Float32Array>,
            { layerDetails: Record<string, CatalogLayerDetail> },
        ];
        expect(writeArgs[0]).toBe(2);
        expect(writeArgs[1].size).toBe(2); // full new layer set
        expect(writeArgs[2].layerDetails['public.roads.geom']!.geometryType).toBe('Polygon');
    });

    it('removes layers absent from the traversal in the new version', async () => {
        const keep = makeLayerRow({ schema: 'public', table: 'roads', desc: 'Jalan raya' });
        const drop = makeLayerRow({ schema: 'gis', table: 'ghost', desc: 'gone soon' });
        const h = makeHarness([keep, drop]);
        await h.publish(1, [keep, drop]);

        // The gis.ghost table disappears from PostGIS.
        h.setLayers([keep]);

        const summary = await refreshSemanticIndex(h.seams, { embeddingContract: 'contract' });
        expect(summary.published).toBe(true);
        expect(summary.removed).toBe(1);
        expect(summary.version).toBe(2);
        expect(summary.layersCount).toBe(1);
        const writeArgs = (h.seams.writeNew as ReturnType<typeof vi.fn>).mock.calls[0] as [
            number,
            Map<string, Float32Array>,
        ];
        expect(writeArgs[1].has('gis.ghost.geom')).toBe(false);
    });

    it('throws typed INDEX_NOT_FOUND when no manifest exists and there is nothing to reuse', async () => {
        const h = makeHarness();
        // h.publish was never called => readPublished returns not-found.
        // First refresh must still publish v1 (spec: embed everything).
        const summary = await refreshSemanticIndex(h.seams, { embeddingContract: 'contract' });
        expect(summary.published).toBe(true);
        expect(summary.version).toBe(1);
        expect(h.seams.writeNew).toHaveBeenCalledTimes(1);
    });

    it('throws typed INDEX_UNAVAILABLE on a degraded store', async () => {
        const layers = [makeLayerRow({ schema: 'public', table: 'roads', desc: 'x' })];
        const h = makeHarness(layers);
        await h.publish(1, layers);
        // Simulate degradation: readPublished returns unavailable.
        (h.seams.readPublished as ReturnType<typeof vi.fn>).mockResolvedValue({
            status: 'unavailable',
            code: 'INDEX_UNAVAILABLE',
            message: 'store degraded',
        });
        const err = await refreshSemanticIndex(h.seams, { embeddingContract: 'contract' }).then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).toMatchObject({ code: 'INDEX_UNAVAILABLE' });
        expect(h.seams.writeNew).not.toHaveBeenCalled();
    });

    it('never reports a NEGATIVE removed count when the catalog only grew', async () => {
        // Old: 1 layer. New: 3 layers (the old one kept + 2 added). Layer-count
        // arithmetic would print removed = 1 - 3 = -2; the fingerprint diff
        // correctly reports 0 removed.
        const keep = makeLayerRow({ schema: 'public', table: 'roads', desc: 'kept' });
        const h = makeHarness([keep]);
        await h.publish(1, [keep]);

        h.setLayers([
            keep,
            makeLayerRow({ schema: 'gis', table: 'rivers', desc: 'added' }),
            makeLayerRow({ schema: 'gis', table: 'lakes', desc: 'added' }),
        ]);

        const summary = await refreshSemanticIndex(h.seams, { embeddingContract: 'contract' });
        expect(summary.published).toBe(true);
        expect(summary.removed).toBe(0); // never -2
        expect(summary.embedded).toBe(2); // the two added layers
        expect(summary.layersCount).toBe(3);
    });

    it('counts removed by FINGERPRINT, never layer-count arithmetic (equal counts, all changed)', async () => {
        // Old catalog: 2 layers. New catalog: ALSO 2 layers but completely
        // different tables/fingerprints. Layer-count subtraction would report
        // removed = -2; the fingerprint diff must report removed = 2.
        const oldLayers = [
            makeLayerRow({ schema: 'public', table: 'roads', desc: 'old roads' }),
            makeLayerRow({ schema: 'gis', table: 'ghost', desc: 'gone soon' }),
        ];
        const h = makeHarness(oldLayers);
        await h.publish(1, oldLayers);

        h.setLayers([
            makeLayerRow({ schema: 'public', table: 'rivers', desc: 'new rivers' }),
            makeLayerRow({ schema: 'gis', table: 'lakes', desc: 'new lakes' }),
        ]);

        const summary = await refreshSemanticIndex(h.seams, { embeddingContract: 'contract' });
        expect(summary.published).toBe(true);
        expect(summary.removed).toBe(2); // not -2
        expect(summary.version).toBe(2);
        expect(summary.embedded).toBe(2); // both new fingerprints embedded
        expect(summary.layersCount).toBe(2);
    });

    it('reports an exact removed value for a pure-removal case', async () => {
        const keep = makeLayerRow({ schema: 'public', table: 'roads', desc: 'kept' });
        const drop1 = makeLayerRow({ schema: 'gis', table: 'a', desc: 'drop a' });
        const drop2 = makeLayerRow({ schema: 'gis', table: 'b', desc: 'drop b' });
        const h = makeHarness([keep, drop1, drop2]);
        await h.publish(1, [keep, drop1, drop2]);

        h.setLayers([keep]);

        const summary = await refreshSemanticIndex(h.seams, { embeddingContract: 'contract' });
        expect(summary.published).toBe(true);
        expect(summary.removed).toBe(2); // exact count of gone fingerprints
        expect(summary.embedded).toBe(0); // nothing new, kept layer reused
        expect(summary.layersCount).toBe(1);
    });
});
