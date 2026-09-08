#!/usr/bin/env node
/**
 * Explicit host-dev model provisioning for the semantic catalog search stack.
 *
 * Downloads the ONNX artifacts that the local embedding runtime needs into
 * `SEMANTIC_MODEL_DIR` (default `models/Xenova/multilingual-e5-small`), then
 * re-loads the model with REMOTE LOADING DISABLED and embeds a sample passage
 * to prove the artifact is complete and offline-capable.
 *
 * Production images bake this directory in at build time (todo #7); the runtime
 * itself NEVER downloads. Run this once per checkout / before Docker builds:
 *
 *     pnpm semantic:prefetch
 *
 * Exit code is non-zero when any download or the offline verification fails.
 */
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { semanticEnv } from '../src/libs/semantic/config.js';
import { SEMANTIC_MODEL_ID } from '../src/libs/semantic/contracts.js';
import {
    getEmbeddingRuntime,
    modelContractFingerprint,
} from '../src/libs/semantic/embedding.js';

/** Exactly the files the fp32 runtime resolves offline (see embedding.ts). */
const ARTIFACTS = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model.onnx',
] as const;

const HF_RESOLVE = 'https://huggingface.co';

function bytesLabel(n: number): string {
    if (n > 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GiB`;
    if (n > 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MiB`;
    return `${(n / (1 << 10)).toFixed(0)} KiB`;
}

async function downloadFile(url: string, dest: string, force: boolean): Promise<void> {
    try {
        const st = await stat(dest);
        if (st.size > 0 && !force) {
            console.log(`  exists (${bytesLabel(st.size)}), skipping`);
            return;
        }
    } catch {
        // not present — download below
    }

    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) {
        throw new Error(`GET ${url} -> HTTP ${res.status}`);
    }
    const total = Number(res.headers.get('content-length') ?? 0);
    console.log(`  downloading ${bytesLabel(total)}${force ? ' (force)' : ''}`);

    const part = `${dest}.part`;
    await rm(part, { force: true });
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    await streamPipeline(body, createWriteStream(part));
    await rename(part, dest);
    const done = await stat(dest);
    console.log(`  wrote ${bytesLabel(done.size)}`);
}

async function main(): Promise<void> {
    const modelDir = path.resolve(semanticEnv.SEMANTIC_MODEL_DIR);
    console.log(`Prefetching ${SEMANTIC_MODEL_ID} -> ${modelDir}`);

    const force = process.argv.includes('--force');
    await mkdir(modelDir, { recursive: true });

    for (const rel of ARTIFACTS) {
        const dest = path.join(modelDir, rel);
        await mkdir(path.dirname(dest), { recursive: true });
        const url = `${HF_RESOLVE}/${SEMANTIC_MODEL_ID}/resolve/main/${rel}`;
        console.log(`\n[${rel}]`);
        await downloadFile(url, dest, force);
    }

    // Offline proof: the runtime hard-disables remote loading; a missing or
    // truncated artifact surfaces here as a typed MODEL_UNAVAILABLE error.
    console.log('\nVerifying offline load (remote downloads disabled)...');
    const rt = getEmbeddingRuntime();
    rt.reset();
    const v = await rt.embedQuery('jalan banjir di jakarta');

    if (v.length !== 384) {
        throw new Error(`expected 384 dims, got ${v.length}`);
    }
    let sum = 0;
    for (let i = 0; i < v.length; i += 1) sum += v[i] * v[i];
    const norm = Math.sqrt(sum);
    if (Math.abs(norm - 1) > 1e-3) {
        throw new Error(`expected unit L2 norm, got ${norm}`);
    }

    const fp = modelContractFingerprint(modelDir);
    const marker = { ok: true, model: SEMANTIC_MODEL_ID, dim: 384, norm, fingerprint: fp };
    await writeFile(
        path.join(modelDir, '.prefetch-verified.json'),
        `${JSON.stringify(marker, null, 2)}\n`,
    );
    console.log(`\nOK — offline embed dim=${v.length} norm=${norm.toFixed(6)}`);
    console.log(`contract fingerprint=${fp.slice(0, 16)}...`);
    console.log('marker written:', path.join(modelDir, '.prefetch-verified.json'));
}

main().catch((err: unknown) => {
    console.error('\nPrefetch FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
