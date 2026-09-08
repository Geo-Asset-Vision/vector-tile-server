import { z } from 'zod';
import {
    SEMANTIC_TOP_K_MIN,
    SEMANTIC_TOP_K_MAX,
    SEMANTIC_MODEL_ID,
    SEMANTIC_DIM,
} from './contracts.js';

/**
 * Strict semantic-search env contract.
 *
 * All values arrive as strings (process.env / dotenv) and are coerced +
 * range-checked here. Separate from `src/libs/env.ts` so importing the
 * semantic stack never parses the MVT/Valkey/PostGIS env block, and the MVT
 * cache env is untouched.
 *
 * Must NOT go in src/libs/env.ts: app bootstrap does not start the semantic
 * stack, and parsing it unconditionally would fail servers that never run it.
 */

const fromStringNumber = (name: string, fallback: string) =>
    z
        .string()
        .trim()
        .min(1, `${name} must not be empty`)
        .regex(/^-?\d+$/, `${name} must be an integer`)
        .default(fallback)
        .transform((v) => Number(v))
        .pipe(z.number().int(`${name} must be an integer`));

export const semanticEnvSchema = z
    .object({
        /** Path to the locally packaged ONNX model artifact (host + container). */
        SEMANTIC_MODEL_DIR: z
            .string()
            .min(1)
            .default('models/Xenova/multilingual-e5-small'),

        /** Embedding model id — runtime refuses to run any other model. */
        SEMANTIC_MODEL_ID: z
            .string()
            .default(SEMANTIC_MODEL_ID)
            .refine((v) => v === SEMANTIC_MODEL_ID, `SEMANTIC_MODEL_ID must be ${SEMANTIC_MODEL_ID}`),

        /** Embedding dimension — model emits exactly 384; anything else is a corrupted artifact. */
        SEMANTIC_DIM: fromStringNumber('SEMANTIC_DIM', String(SEMANTIC_DIM)).pipe(
            z.literal(SEMANTIC_DIM, `SEMANTIC_DIM must be ${SEMANTIC_DIM}`),
        ),

        /** Bounded concurrency for embedding inference (a queue bounds the rest). */
        SEMANTIC_MAX_CONCURRENT_EMBEDDINGS: fromStringNumber(
            'SEMANTIC_MAX_CONCURRENT_EMBEDDINGS',
            '1',
        )
            .refine((v) => v >= 1 && v <= 16, 'SEMANTIC_MAX_CONCURRENT_EMBEDDINGS must be between 1 and 16'),

        /** Bounded top-K per query. */
        SEMANTIC_TOP_K_DEFAULT: fromStringNumber('SEMANTIC_TOP_K_DEFAULT', '10')
            .refine(
                (v) => v >= SEMANTIC_TOP_K_MIN && v <= SEMANTIC_TOP_K_MAX,
                `SEMANTIC_TOP_K_DEFAULT must be between ${SEMANTIC_TOP_K_MIN} and ${SEMANTIC_TOP_K_MAX}`,
            ),
        SEMANTIC_TOP_K_MAX: fromStringNumber('SEMANTIC_TOP_K_MAX', String(SEMANTIC_TOP_K_MAX))
            .refine(
                (v) => v >= SEMANTIC_TOP_K_MIN && v <= SEMANTIC_TOP_K_MAX,
                `SEMANTIC_TOP_K_MAX must be between ${SEMANTIC_TOP_K_MIN} and ${SEMANTIC_TOP_K_MAX}`,
            ),

        /** LRU caps for the three bounded caches (documents, queries, ranked results). */
        SEMANTIC_DOCUMENT_CACHE_SIZE: fromStringNumber('SEMANTIC_DOCUMENT_CACHE_SIZE', '4096')
            .refine((v) => v >= 1 && v <= 1_000_000, 'SEMANTIC_DOCUMENT_CACHE_SIZE must be between 1 and 1000000'),
        SEMANTIC_QUERY_CACHE_SIZE: fromStringNumber('SEMANTIC_QUERY_CACHE_SIZE', '1024')
            .refine((v) => v >= 1 && v <= 1_000_000, 'SEMANTIC_QUERY_CACHE_SIZE must be between 1 and 1000000'),
        SEMANTIC_RESULT_CACHE_SIZE: fromStringNumber('SEMANTIC_RESULT_CACHE_SIZE', '1024')
            .refine((v) => v >= 1 && v <= 1_000_000, 'SEMANTIC_RESULT_CACHE_SIZE must be between 1 and 1000000'),
    })
    .superRefine((data, ctx) => {
        if (data.SEMANTIC_TOP_K_MAX < data.SEMANTIC_TOP_K_DEFAULT) {
            ctx.addIssue({
                code: 'custom',
                path: ['SEMANTIC_TOP_K_MAX'],
                message:
                    'SEMANTIC_TOP_K_MAX must be >= SEMANTIC_TOP_K_DEFAULT' +
                    ` (got max=${data.SEMANTIC_TOP_K_MAX}, default=${data.SEMANTIC_TOP_K_DEFAULT})`,
            });
        }
    });

export type SemanticEnv = z.infer<typeof semanticEnvSchema>;

export function parseSemanticEnv(source: Record<string, unknown> = process.env): SemanticEnv {
    return semanticEnvSchema.parse(source);
}

/** Parsed eagerly once, mirroring `src/libs/env.ts`. */
export const semanticEnv: SemanticEnv = parseSemanticEnv();
