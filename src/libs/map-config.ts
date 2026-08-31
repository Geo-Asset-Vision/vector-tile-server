import env from '@/libs/env';

export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const MAX_WHERE_LENGTH = 1000;

const splitList = (value?: string) => new Set((value ?? '').split(',').map((s) => s.trim()).filter(Boolean));

export const allowedSchemas = splitList(env.ALLOWED_SCHEMAS);
export const allowedCatalogs = splitList(env.ALLOWED_CATALOGS);
export const stableIdColumns = new Map(
  (env.STABLE_ID_COLUMNS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(':').map((part) => part.trim()) as [string, string])
    .filter(([catalog, column]) => SAFE_ID_RE.test(catalog) && SAFE_ID_RE.test(column)),
);

export function parseCatalogId(catalogId: string, defaultSchema = 'public') {
  const parts = catalogId.split('.');
  const schemaName = parts.length > 1 ? parts[0] : defaultSchema;
  const tableName = parts.length > 1 ? parts.slice(1).join('.') : catalogId;
  return { schemaName, tableName, fullCatalogId: `${schemaName}.${tableName}` };
}

export function isCatalogAllowed(schemaName: string, tableName?: string) {
  const full = tableName ? `${schemaName}.${tableName}` : schemaName;
  if (allowedSchemas.size && !allowedSchemas.has(schemaName)) return false;
  if (tableName && allowedCatalogs.size && !allowedCatalogs.has(full) && !allowedCatalogs.has(tableName)) return false;
  return true;
}

export function explicitStableId(schemaName: string, tableName: string) {
  return stableIdColumns.get(`${schemaName}.${tableName}`) ?? stableIdColumns.get(tableName);
}

export function assertWhereLength(where?: string) {
  if (where && where.length > MAX_WHERE_LENGTH) throw new Error('WHERE_TOO_LONG');
}
