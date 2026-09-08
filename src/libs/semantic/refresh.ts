/**
 * Catalog-index refresh: traverse every geometry object in PostGIS, build
 * canonical documents, re-embed only what changed, and publish one immutable
 * version. Removed layers disappear from the new version (their namespace is
 * purged by IndexStorage.writeVersion); unchanged layers are skipped by
 * fingerprint and their vectors copied from the current published version.
 *
 * I/O goes through injected seams so unit tests never touch PostGIS, the real
 * model, or Valkey:
 *   - `discover`   — findAllGeomObject (list of schema.table geometry objects)
 *   - `layers`     — findTableGeomLayers (per geometry column)
 *   - `readPublished` / `writeNew` — IndexStorage (versioned Valkey)
 *   - `embedBatch` — ONE batched pipeline call for every changed passage
 *
 * Versioning: newVersion = current published version + 1 (or 1 when none). The
 * manifest stores `embeddingContract` (the model-contract fingerprint) so
 * retrieval can detect model drift. A catalog byte-identical to the current
 * version publishes nothing — no-op refreshes must not churn immutable
 * versions. No network, no SCAN: traversal is the only source of truth.
 */
import { createHash } from 'node:crypto';

import type { ITableGeomLayerResult } from '@/repositories/catalog.repo';

import { SemanticSearchError } from './contracts.js';
import { buildLayerDocument, type ILayerDocument } from './document.js';
import type {
    CatalogLayerDetail,
    IndexReadResult,
    IndexWriteResult,
} from './index-storage.js';

export interface CatalogGeomTable {
    schemaName: string;
    tableName: string;
}

export interface RefreshSeams {
    /** findAllGeomObject(): every table/view holding at least one geometry column. */
    discover(): Promise<CatalogGeomTable[]>;
    /** findTableGeomLayers(): one row per geometry column, in column order. */
    layers(schemaName: string, tableName: string): Promise<ITableGeomLayerResult[]>;
    /** IndexStorage.readPublished() — current version + manifest + vectors. */
    readPublished(): Promise<IndexReadResult>;
    writeNew(
        version: number,
        docs: Map<string, Float32Array>,
        opts: {
            sourceFingerprint: string;
            embeddingContract: string;
            layerDetails: Record<string, CatalogLayerDetail>;
        },
    ): Promise<IndexWriteResult>;
    /** Batch-embed changed passages in ONE pipeline call (never one-by-one). */
    embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export interface RefreshOptions {
    /** Model-contract fingerprint stored in the manifest (`modelContractFingerprint()`). */
    embeddingContract: string;
}

export interface RefreshSummary {
    /** Version currently published after the refresh (unchanged on a no-op). */
    version: number;
    /** True when a new immutable version was published. */
    published: boolean;
    layersCount: number;
    embedded: number;
    reused: number;
    removed: number;
    durationMs: number;
}

interface TraversedDoc {
    doc: ILayerDocument;
    detail: CatalogLayerDetail;
}

function toDetail(layer: ITableGeomLayerResult, doc: ILayerDocument): CatalogLayerDetail {
    return {
        fingerprint: doc.fingerprint,
        geometryType: layer.geometry_type,
        ...(layer.table_description ? { tableDescription: layer.table_description } : {}),
        ...(layer.geometry_description ? { geometryDescription: layer.geometry_description } : {}),
    };
}

/** Aggregate catalog fingerprint: sha256 over the sorted per-layer fingerprints. */
function aggregateFingerprint(docs: ILayerDocument[]): string {
    const hash = createHash('sha256');
    for (const fp of docs.map((d) => d.fingerprint).sort()) {
        hash.update(fp);
    }
    return hash.digest('hex');
}

export async function refreshSemanticIndex(
    seams: RefreshSeams,
    options: RefreshOptions,
): Promise<RefreshSummary> {
    const startedAt = Date.now();

    // 1. Traverse the whole catalog deterministically.
    const traversed: TraversedDoc[] = [];
    const seen = new Set<string>();
    for (const table of await seams.discover()) {
        const layers = await seams.layers(table.schemaName, table.tableName);
        for (const layer of layers) {
            const doc = buildLayerDocument(layer);
            if (seen.has(doc.id)) continue; // safety: no duplicate layer ids
            seen.add(doc.id);
            traversed.push({ doc, detail: toDetail(layer, doc) });
        }
    }

    // 2. Current published state. not-found => first refresh (embed everything,
    //    publish v1). unavailable => fail loudly; never rebuild a degraded store.
    const old = await seams.readPublished();
    const previousVersion = old.status === 'ok' ? old.version : 0;
    const currentDocuments = old.status === 'ok' ? old.documents : null;
    const previousFingerprints = new Set<string>();
    if (old.status === 'ok') {
        for (const detail of Object.values(old.manifest.layerDetails ?? {})) {
            previousFingerprints.add(detail.fingerprint);
        }
    }
    if (old.status !== 'ok' && old.status !== 'not-found') {
        throw new SemanticSearchError('INDEX_UNAVAILABLE', old.message);
    }

    // 3. Diff by FINGERPRINT, never by layer-count arithmetic. A changed layer
    //    (same id, new fingerprint) is both a "removed old fingerprint" and an
    //    "added new one" — counting would double-count or go negative.
    const currentFingerprints = new Set(traversed.map((t) => t.doc.fingerprint));
    const changed = traversed.filter((t) => !previousFingerprints.has(t.doc.fingerprint));
    let removedCount = 0;
    for (const fp of previousFingerprints) {
        if (!currentFingerprints.has(fp)) removedCount += 1;
    }
    const reusedCount = traversed.length - changed.length;

    // A fresh store is always a publish (v1). Otherwise a byte-identical
    // catalog must not churn versions.
    if (old.status === 'ok' && changed.length === 0 && removedCount === 0) {
        return {
            version: old.version,
            published: false,
            layersCount: traversed.length,
            embedded: 0,
            reused: reusedCount,
            removed: 0,
            durationMs: Date.now() - startedAt,
        };
    }

    // 4. Embed ONLY the changed/new passages — one batched pipeline call.
    const changedVectors =
        changed.length > 0 ? await seams.embedBatch(changed.map((t) => t.doc.passage)) : [];

    // 5. Assemble the full new-version docs map. Changed layers get the fresh
    //    vector; unchanged layers are copied from the current published
    //    version (identical fingerprint => identical passage => same vector).
    const newDocs = new Map<string, Float32Array>();
    const layerDetails: Record<string, CatalogLayerDetail> = {};
    for (let i = 0; i < changed.length; i += 1) {
        newDocs.set(changed[i]!.doc.id, changedVectors[i]!);
        layerDetails[changed[i]!.doc.id] = changed[i]!.detail;
    }
    for (const t of traversed) {
        if (newDocs.has(t.doc.id)) continue;
        const reusedVector = currentDocuments?.get(t.doc.id);
        if (!reusedVector) {
            // Same fingerprint yet the store lost the vector — inconsistent.
            // Never publish a partial set silently.
            throw new SemanticSearchError(
                'INDEX_UNAVAILABLE',
                `published index is missing the vector for unchanged layer ${t.doc.id}; re-publish a clean index`,
            );
        }
        newDocs.set(t.doc.id, reusedVector);
        layerDetails[t.doc.id] = t.detail;
    }

    // 6. Publish the new immutable version.
    const write = await seams.writeNew(previousVersion + 1, newDocs, {
        sourceFingerprint: aggregateFingerprint(traversed.map((t) => t.doc)),
        embeddingContract: options.embeddingContract,
        layerDetails,
    });
    if (write.status !== 'ok') {
        throw new SemanticSearchError(write.code, write.message);
    }

    return {
        version: write.version,
        published: true,
        layersCount: newDocs.size,
        embedded: changed.length,
        reused: reusedCount,
        removed: removedCount,
        durationMs: Date.now() - startedAt,
    };
}
