import { describe, expect, it } from 'vitest';

import { semanticEnv } from './config.js';
import { SEMANTIC_DIM } from './contracts.js';
import { getEmbeddingRuntime } from './embedding.js';

/**
 * Real-model smoke test — runs the ACTUAL local model end-to-end with remote
 * loading disabled. Requires the model to be prefetched first:
 *
 *     pnpm semantic:prefetch
 *     SEMANTIC_RUN_REAL=1 pnpm vitest run src/libs/semantic/embedding.real.test.ts
 *
 * This file deliberately does NOT mock @huggingface/transformers. It is skipped
 * unless the env gate is set, keeping the default unit suite offline and fast.
 */
describe.skipIf(process.env.SEMANTIC_RUN_REAL !== '1')('real model', () => {
    it('embeds a query against the real local model with remote disabled', async () => {
        const rt = getEmbeddingRuntime();
        rt.reset();
        const v = await rt.embedQuery('jalan banjir');

        expect(v).toHaveLength(SEMANTIC_DIM);
        expect(v).toBeInstanceOf(Float32Array);
        let sum = 0;
        for (let i = 0; i < v.length; i += 1) sum += v[i] * v[i];
        expect(Math.sqrt(sum)).toBeCloseTo(1, 4);
        expect(Array.from(v.slice(0, 3))).not.toEqual([0, 0, 0]);
        expect(semanticEnv.SEMANTIC_MODEL_DIR).toContain('models');
    });
});
