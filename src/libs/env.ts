import { config } from 'dotenv';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

config({
    path: [
        `${__dirname}/../../.env`,
        `${__dirname}/../../.env.${process.env.NODE_ENV || 'development'}.local`,
        `${__dirname}/../../.env.${process.env.NODE_ENV || 'development'}`,
    ],
    override: true,
    quiet: true,
})

const envSchema = z.object({
    APP_PORT: z.string().default('3000').transform(Number),
    APP_BASE_URL: z.string().default('http://localhost:3000/').transform((val) => val.endsWith('/') ? val.slice(0, -1) : val),
    POSTGIS_HOST: z.string().default('localhost'),
    POSTGIS_PORT: z.string().default('5432').transform(Number),
    POSTGIS_DB: z.string().default('vtserver'),
    POSTGIS_SCHEMA: z.string().optional(),
    POSTGIS_USER: z.string().default('vtserver'),
    POSTGIS_PASSWORD: z.string().default('vtserver'),
    POSTGIS_MAX_POOL: z.string().default('20').transform(Number),

    API_KEY: z.string().optional(),

    VALKEY_HOST: z.string().optional(),
    VALKEY_PORT: z.string().default('6379').transform(Number),
    VALKEY_PASSWORD: z.string().optional(),
    VALKEY_URL: z.string().optional(),
    VALKEY_CONNECT_TIMEOUT_MS: z.string().default('1000').transform(Number),
    VALKEY_COMMAND_TIMEOUT_MS: z.string().default('500').transform(Number),
    VALKEY_CIRCUIT_FAIL_THRESHOLD: z.string().default('3').transform(Number),
    VALKEY_CIRCUIT_COOLDOWN_MS: z.string().default('10000').transform(Number),

    // MVT 2-Level Cache Config (TTL default: 60s / 1 minute)
    MVT_CACHE_ENABLED: z.string().default('true').transform((v) => v === 'true' || v === '1'),
    MVT_CACHE_L1_ENABLED: z.string().default('true').transform((v) => v === 'true' || v === '1'),
    MVT_CACHE_L1_MAX_ITEMS: z.string().default('10000').transform(Number),
    MVT_CACHE_L1_MAX_SIZE_MB: z.string().default('256').transform(Number),
    MVT_CACHE_L1_TTL_SECONDS: z.string().default('60').transform(Number),

    MVT_CACHE_L2_ENABLED: z.string().default('true').transform((v) => v === 'true' || v === '1'),
    MVT_CACHE_L2_TTL_SECONDS: z.string().default('60').transform(Number),
    MVT_CACHE_L2_EMPTY_TTL_SECONDS: z.string().default('15').transform(Number),
    MVT_CACHE_TTL_JITTER_SECONDS: z.string().default('10').transform(Number),

    MVT_CACHE_SINGLE_FLIGHT_ENABLED: z.string().default('true').transform((v) => v === 'true' || v === '1'),
    MVT_CACHE_DEBUG_HEADERS: z.string().default('false').transform((v) => v === 'true' || v === '1'),

    RATE_LIMIT_MAX_ATTEMPTS: z.string().default('5').transform(Number),
    RATE_LIMIT_BASE_BLOCK_SEC: z.string().default('60').transform(Number),
});

export const env = envSchema.parse(process.env);
export default env;