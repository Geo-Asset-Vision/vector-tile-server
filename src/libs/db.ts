import env from "./env";
import { Pool, type QueryResultRow } from "pg";

const pool = new Pool({
    user: env.POSTGIS_USER,
    host: env.POSTGIS_HOST,
    database: env.POSTGIS_DB,
    password: env.POSTGIS_PASSWORD,
    port: env.POSTGIS_PORT,
    max: env.POSTGIS_MAX_POOL,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle PostgreSQL client', err);
});

export const query = <T extends QueryResultRow = any>(text: string, params?: any[]) => pool.query<T>(text, params);
export const getClient = () => pool.connect();
export const checkConnection = async () => {
    console.log('[DATABASE] => Checking Database Connection...')
    try {
        await pool.query('SELECT NOW()');
        console.log('[DATABASE] => Database Connection OK')
        return true;
    } catch (error) {
        console.error('[DATABASE] => Database Connection Failed', error)
        return false;
    }
};
export const disconnect = () => pool.end();
