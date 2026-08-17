import 'dotenv/config';
import { z } from 'zod';

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

    RATE_LIMIT_MAX_ATTEMPTS: z.string().default('5').transform(Number),
    RATE_LIMIT_BASE_BLOCK_SEC: z.string().default('60').transform(Number),
});

export const env = envSchema.parse(process.env);
export default env;