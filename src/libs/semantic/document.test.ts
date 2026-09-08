import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ITableGeomLayerResult } from '@/repositories/catalog.repo';
import { buildLayerDocument, EMBEDDING_CONTRACT } from './document';

function sampleLayer(overrides: Partial<ITableGeomLayerResult> = {}): ITableGeomLayerResult {
    return {
        schema_name: 'public',
        table_name: 'indonesia_provinces',
        geometry_column: 'geom',
        geometry_type: 'MULTIPOLYGON',
        srid: 4326,
        table_description: 'Province boundaries of Indonesia',
        geometry_description: 'Province polygon geometry',
        fields: { name: 'character varying(100)', population: 'integer', gid: 'integer' },
        ...overrides,
    };
}

function fingerprintOf(text: string): string {
    // Mirror the sha256 layout from buildLayerDocument.
    return createHash('sha256').update(`${text}\n${EMBEDDING_CONTRACT}`).digest('hex');
}

describe('deterministic catalog document construction', () => {
    it('prefixes canonical text with `passage: ` and carries identity + attributes', () => {
        const doc = buildLayerDocument(sampleLayer());
        expect(doc.passage.startsWith('passage: ')).toBe(true);
        expect(doc.passage).toContain(
            'layer: public.indonesia_provinces.geom',
        );
        expect(doc.passage).toContain('geometry type: MULTIPOLYGON');
        expect(doc.passage).toContain('srid: 4326');
        expect(doc.passage).toContain('table description: Province boundaries of Indonesia');
        expect(doc.passage).toContain('geometry description: Province polygon geometry');
        expect(doc.passage).toContain('name: character varying(100)');
    });

    it('sorts fields deterministically regardless of insertion order', () => {
        const a = buildLayerDocument(sampleLayer());
        const b = buildLayerDocument(
            sampleLayer({
                fields: { gid: 'integer', population: 'integer', name: 'character varying(100)' },
            }),
        );
        expect(a.passage).toBe(b.passage);
        const gidIndex = a.passage.indexOf('gid: integer');
        const nameIndex = a.passage.indexOf('name: character varying');
        expect(gidIndex).toBeLessThan(nameIndex);
    });

    it('produces byte-identical text and fingerprint for identical layers', () => {
        const a = buildLayerDocument(sampleLayer());
        const b = buildLayerDocument(sampleLayer());
        expect(a.passage).toBe(b.passage);
        expect(a.fingerprint).toBe(b.fingerprint);
        expect(a.fingerprint).toBe(fingerprintOf(a.passage));
        expect(a.id).toBe('public.indonesia_provinces.geom');
    });

    it('changes the fingerprint when a description, field, or geometry type changes', () => {
        const base = buildLayerDocument(sampleLayer());
        const changedDescription = buildLayerDocument(
            sampleLayer({ table_description: 'Changed description' }),
        );
        const changedField = buildLayerDocument(
            sampleLayer({ fields: { name: 'text', population: 'integer', gid: 'integer' } }),
        );
        const changedType = buildLayerDocument(sampleLayer({ geometry_type: 'POLYGON' }));
        expect(changedDescription.fingerprint).not.toBe(base.fingerprint);
        expect(changedField.fingerprint).not.toBe(base.fingerprint);
        expect(changedType.fingerprint).not.toBe(base.fingerprint);
    });

    it('keeps distinct document ids for equal table names in different schemas', () => {
        const a = buildLayerDocument(sampleLayer({ schema_name: 'public' }));
        const b = buildLayerDocument(sampleLayer({ schema_name: 'analysis' }));
        expect(a.id).toBe('public.indonesia_provinces.geom');
        expect(b.id).toBe('analysis.indonesia_provinces.geom');
        expect(a.id).not.toBe(b.id);
        expect(a.fingerprint).not.toBe(b.fingerprint);
    });

    it('stays deterministic with missing optional descriptions and no unstable separators', () => {
        const withoutDescriptions: ITableGeomLayerResult = sampleLayer({
            table_description: undefined,
            geometry_description: undefined,
            fields: {},
        });
        const a = buildLayerDocument(withoutDescriptions);
        const b = buildLayerDocument(withoutDescriptions);
        expect(a.passage).toBe(b.passage);
        expect(a.fingerprint).toBe(b.fingerprint);
        // Fixed markers, no separator-only trailing content (no "description: " dangling).
        expect(a.passage).toContain('table description: ');
        expect(a.passage).toContain('geometry description: ');
        // Absence of the optional description lines is itself part of the text,
        // so adding them later still changes the fingerprint deterministically.
        const withDescriptions = buildLayerDocument(sampleLayer());
        expect(withDescriptions.fingerprint).not.toBe(a.fingerprint);
    });

    it('caps long metadata to a bounded text budget without losing identity', () => {
        const layer = sampleLayer({
            table_description: 'x'.repeat(10_000),
            geometry_description: 'y'.repeat(10_000),
            fields: Object.fromEntries(
                Array.from({ length: 500 }, (_, i) => [`column_${i}`, `type_${i}_${'z'.repeat(60)}`]),
            ),
        });
        const doc = buildLayerDocument(layer, { maxChars: 500 });
        expect(doc.charCount).toBe(doc.passage.length);
        expect(doc.charCount).toBeLessThanOrEqual(500);
        expect(doc.passage).toContain('layer: public.indonesia_provinces.geom');
        expect(doc.passage).toContain('geometry type: MULTIPOLYGON');
        expect(doc.passage).toContain('srid: 4326');
        // Same input again → same truncated text and fingerprint.
        const again = buildLayerDocument(layer, { maxChars: 500 });
        expect(again.passage).toBe(doc.passage);
        expect(again.fingerprint).toBe(doc.fingerprint);
    });

    it('truncates deterministically on code-point boundaries (no lone surrogates)', () => {
        const layer = sampleLayer({
            table_description: 'emoji: ' + '🙂'.repeat(300),
            fields: {},
        });
        const doc = buildLayerDocument(layer, { maxChars: 200 });
        expect(doc.charCount).toBeLessThanOrEqual(200);
        // Re-encoding must not produce U+FFFD replacement chars from split surrogates.
        const asBuffer = Buffer.from(doc.passage, 'utf8');
        expect(asBuffer.toString('utf8').includes('\uFFFD')).toBe(false);
    });

    it('rejects a budget too small to hold the identity', () => {
        const layer = sampleLayer();
        expect(() => buildLayerDocument(layer, { maxChars: 10 })).toThrow(RangeError);
    });

    it('hashes exactly the canonical passage plus the embedding contract', () => {
        const doc = buildLayerDocument(sampleLayer());
        const expected = fingerprintOf(doc.passage);
        expect(doc.fingerprint).toBe(expected);
        expect(doc.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        // Changing the contract string changes the fingerprint (model change ⇒ reindex).
        const other = createHash('sha256')
            .update(`${doc.passage}\ndifferent-contract`)
            .digest('hex');
        expect(other).not.toBe(doc.fingerprint);
    });
});
