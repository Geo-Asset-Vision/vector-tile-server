import { createHash } from 'node:crypto';
import type { ITableGeomLayerResult } from '@/repositories/catalog.repo';

/**
 * Embedding contract: model id + dimension + pooling + normalization.
 * Fingerprinting over EXACTLY the canonical passage plus this contract means
 * any model/contract change invalidates every stored fingerprint and forces a
 * reindex (todo #5 relies on this to skip unchanged layers only within a
 * stable contract).
 */
export const EMBEDDING_CONTRACT =
    'Xenova/multilingual-e5-small|dim=384|pool=mean|normalize=l2';

export const DOCUMENT_MAX_CHARS = 1500;

/** Marker substituted for absent optional descriptions. Fixed, never conditional. */
const EMPTY_MARKER = '';

/**
 * A canonical, deterministic catalog-layer document ready for embedding.
 * Never contains spatial features or vectors.
 */
export interface ILayerDocument {
    /** Fully schema-qualified id: `schema.table.geometry_column`. */
    id: string;
    /** Canonical `passage:` text fed to the embedding model. */
    passage: string;
    /** SHA-256 over the canonical passage + EMBEDDING_CONTRACT. */
    fingerprint: string;
    /** Length in UTF-16 code units of `passage` (bounded by maxChars). */
    charCount: number;
}

export interface ILayerDocumentOptions {
    /** Hard cap on `passage` length. Must fit id + geometry type + srid. */
    maxChars?: number;
}

/** Lines that MUST survive truncation (identity + key attributes). */
function coreLines(layer: ITableGeomLayerResult): string[] {
    return [
        `layer: ${layer.schema_name}.${layer.table_name}.${layer.geometry_column}`,
        `geometry type: ${layer.geometry_type}`,
        `srid: ${String(layer.srid)}`,
    ];
}

/** Remaining lines; dropped from the tail first when over budget. */
function tailLines(layer: ITableGeomLayerResult): string[] {
    const lines = [
        `table description: ${layer.table_description ?? EMPTY_MARKER}`,
        `geometry description: ${layer.geometry_description ?? EMPTY_MARKER}`,
    ];
    const fieldKeys = Object.keys(layer.fields).sort();
    if (fieldKeys.length > 0) {
        lines.push('fields:');
        for (const key of fieldKeys) {
            lines.push(`  ${key}: ${layer.fields[key]}`);
        }
    }
    return lines;
}

function fits(text: string, maxChars: number): boolean {
    return text.length <= maxChars;
}

/**
 * Clip `line` to `remaining` chars on a code-point boundary so we never emit a
 * lone UTF-16 surrogate into the fingerprint hash.
 */
function clip(line: string, remaining: number): string {
    if (line.length <= remaining) return line;
    let end = remaining;
    while (end > 0) {
        const code = line.charCodeAt(end - 1);
        if (code < 0xd800 || code > 0xdfff) break;
        end -= 1;
    }
    return line.slice(0, end);
}

const PASSAGE_PREFIX = 'passage: ';

export function documentId(layer: ITableGeomLayerResult): string {
    return `${layer.schema_name}.${layer.table_name}.${layer.geometry_column}`;
}

export function buildLayerDocument(
    layer: ITableGeomLayerResult,
    options: ILayerDocumentOptions = {},
): ILayerDocument {
    const maxChars = options.maxChars ?? DOCUMENT_MAX_CHARS;
    const core = coreLines(layer);
    const prefix = PASSAGE_PREFIX + core.join('\n');
    if (prefix.length > maxChars) {
        throw new RangeError(
            `maxChars ${maxChars} too small to hold layer identity for ${documentId(layer)}`,
        );
    }

    const tail = tailLines(layer);
    let head = prefix;
    let cursor = 0;
    // Greedily keep whole lines while they fit, then clip the first line that
    // would overflow so the remainder still carries meaningful content.
    while (cursor < tail.length) {
        const candidate = tail[cursor];
        const next = `${head}\n${candidate}`;
        if (fits(next, maxChars)) {
            head = next;
            cursor += 1;
            continue;
        }
        const remaining = maxChars - head.length - 1;
        if (remaining > 0) {
            head += `\n${clip(candidate, remaining)}`;
        }
        break;
    }

    const passage = head;
    const fingerprint = createHash('sha256')
        .update(`${passage}\n${EMBEDDING_CONTRACT}`)
        .digest('hex');
    return { id: documentId(layer), passage, fingerprint, charCount: passage.length };
}
