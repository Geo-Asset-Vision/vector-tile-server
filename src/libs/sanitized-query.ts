// Rich but safe-ish SQL WHERE sanitizer supporting: () AND OR NOT, = != < <= > >=, IN(...), BETWEEN, LIKE/ILIKE, IS [NOT] NULL
// Only whitelisted identifiers are allowed. Literals are validated and coerced against field types.
// Disallows: ; -- /* */ $$ :: functions, keywords like SELECT/UPDATE/DELETE/INSERT, CTEs, etc.

export type AllowedFields = ReadonlySet<string> | Set<string> | string[];

export interface IQueryOptions {
    allowedFields?: AllowedFields;
    fieldTypes?: Record<string, string>;
}

export default function sanitizeWhereParam(raw: string, options?: IQueryOptions): string | null {
    if (!raw) return null;

    // Quick reject of obviously dangerous tokens
    const forbidden = /(;|--|\/\*|\*\/|\$\$|::|\b(SELECT|UPDATE|DELETE|INSERT|MERGE|ALTER|DROP|CREATE|GRANT|REVOKE|CALL|EXECUTE|WITH)\b)/i;
    if (forbidden.test(raw)) return null;

    // Tokenize
    const tokens: string[] = [];
    const src = raw.trim();
    let i = 0;
    const push = (t: string) => {
        if (t.length) tokens.push(t);
    };
    const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
    const isIdentCont = (c: string) => /[A-Za-z0-9_]/.test(c);
    const isDigit = (c: string) => /[0-9]/.test(c);

    while (i < src.length) {
        const c = src[i];
        if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
            i++;
            continue;
        }

        // Strings: single quoted, with escaped '' inside
        if (c === "'") {
            let j = i + 1;
            let val = "'";
            let closed = false;
            while (j < src.length) {
                const cj = src[j];
                val += cj;
                if (cj === "'") {
                    if (j + 1 < src.length && src[j + 1] === "'") { // escaped quote
                        val += "'";
                        j += 2;
                        continue;
                    } else {
                        closed = true;
                        j++;
                        break;
                    }
                }
                j++;
            }
            if (!closed) return null;
            push(val);
            i = j;
            continue;
        }

        // Numbers (simple integer/float)
        if (isDigit(c)) {
            let j = i + 1;
            let seenDot = false;
            while (j < src.length) {
                const cj = src[j];
                if (cj === '.' && !seenDot) {
                    seenDot = true;
                    j++;
                    continue;
                }
                if (!isDigit(cj)) break;
                j++;
            }
            push(src.slice(i, j));
            i = j;
            continue;
        }

        // Identifiers / keywords
        if (isIdentStart(c)) {
            let j = i + 1;
            while (j < src.length && isIdentCont(src[j])) j++;
            push(src.slice(i, j));
            i = j;
            continue;
        }

        // Two-char operators
        const two = src.slice(i, i + 2);
        if ([">=", "<=", "!="].includes(two)) {
            push(two);
            i += 2;
            continue;
        }
        // Single-char operators & punctuation
        if (["=", "<", ">", "(", ")", ","].includes(c)) {
            push(c);
            i++;
            continue;
        }

        // Anything else rejected
        return null;
    }

    // Canonicalize case for logical and operator keywords
    const upper = new Set(["AND", "OR", "NOT", "IN", "LIKE", "ILIKE", "BETWEEN", "IS", "NULL", "ESCAPE"]);
    for (let t = 0; t < tokens.length; t++) {
        const u = tokens[t].toUpperCase();
        if (upper.has(u)) tokens[t] = u;
    }

    const normalizeAllowedFields = (af?: AllowedFields): ReadonlySet<string> | null => {
        if (!af) return null; // allow all
        if (Array.isArray(af)) return new Set(af);
        return af as ReadonlySet<string>;
    };

    const allowed = normalizeAllowedFields(options?.allowedFields);

    const getRawFieldType = (fieldName: string): string | undefined => {
        if (!options?.fieldTypes) return undefined;
        if (options.fieldTypes[fieldName]) return options.fieldTypes[fieldName];
        const lower = fieldName.toLowerCase();
        for (const [k, v] of Object.entries(options.fieldTypes)) {
            if (k.toLowerCase() === lower) return v;
        }
        return undefined;
    };

    const getFieldCategory = (rawType?: string): 'string' | 'numeric' | 'boolean' | 'datetime' | 'unknown' => {
        if (!rawType) return 'unknown';
        const t = rawType.toLowerCase();
        if (
            t.includes('char') ||
            t.includes('text') ||
            t.includes('varchar') ||
            t.includes('string') ||
            t.includes('uuid')
        ) {
            return 'string';
        }
        if (
            t.includes('int') ||
            t.includes('double') ||
            t.includes('numeric') ||
            t.includes('real') ||
            t.includes('float') ||
            t.includes('decimal') ||
            t.includes('serial')
        ) {
            return 'numeric';
        }
        if (t.includes('bool')) {
            return 'boolean';
        }
        if (t.includes('date') || t.includes('time')) {
            return 'datetime';
        }
        return 'unknown';
    };

    let pos = 0;
    const peek = (): string | undefined => tokens[pos];
    const eat = (expected?: string): string | undefined => {
        const t = tokens[pos++];
        if (!t) return undefined;
        if (expected && t.toUpperCase() !== expected.toUpperCase()) return undefined;
        return t;
    };

    const isLiteral = (t: string | undefined | null): t is string => !!t && (
        t.startsWith("'") ||
        /^\d+(?:\.\d+)?$/.test(t) ||
        t === 'TRUE' ||
        t === 'FALSE'
    );

    const isIdent = (t: string | undefined | null): t is string => !!t && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t);

    const canonicalIdent = (id: string): { name: string; rawName: string } | null => {
        if (allowed && !allowed.has(id) && !allowed.has(id.toLowerCase())) return null;
        return { name: `"${id.replace(/"/g, '""')}"`, rawName: id };
    };

    const formatLiteralForField = (fieldRawName: string, lit: string): string | null => {
        const fieldType = getRawFieldType(fieldRawName);
        const category = getFieldCategory(fieldType);

        if (category === 'string') {
            if (lit.startsWith("'")) {
                return lit;
            }
            if (/^\d+(?:\.\d+)?$/.test(lit)) {
                return `'${lit}'`;
            }
            if (lit === 'TRUE' || lit === 'FALSE') {
                return `'${lit.toLowerCase()}'`;
            }
            return `'${lit}'`;
        }

        if (category === 'numeric') {
            if (/^\d+(?:\.\d+)?$/.test(lit)) {
                return lit;
            }
            if (lit.startsWith("'") && lit.endsWith("'")) {
                const unquoted = lit.slice(1, -1);
                if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) {
                    return unquoted;
                }
                return null;
            }
            return null;
        }

        if (category === 'boolean') {
            const u = lit.toUpperCase();
            if (u === 'TRUE' || u === "'TRUE'" || u === "'1'" || u === "1") return 'TRUE';
            if (u === 'FALSE' || u === "'FALSE'" || u === "'0'" || u === "0") return 'FALSE';
            return null;
        }

        return lit;
    };

    function parseExpression(): string | null {
        return parseOr();
    }

    function parseOr(): string | null {
        let left = parseAnd();
        if (left == null) return null;
        while (peek() === 'OR') {
            eat('OR');
            const right = parseAnd();
            if (right == null) return null;
            left = `(${left} OR ${right})`;
        }
        return left;
    }

    function parseAnd(): string | null {
        let left = parseNot();
        if (left == null) return null;
        while (peek() === 'AND') {
            eat('AND');
            const right = parseNot();
            if (right == null) return null;
            left = `(${left} AND ${right})`;
        }
        return left;
    }

    function parseNot(): string | null {
        if (peek() === 'NOT') {
            eat('NOT');
            const inner = parsePrimary();
            if (inner == null) return null;
            return `(NOT ${inner})`;
        }
        return parsePrimary();
    }

    function parsePrimary(): string | null {
        const t = peek();
        if (t === '(') {
            eat('(');
            const expr = parseExpression();
            if (expr == null) return null;
            if (eat(')') == null) return null;
            return `(${expr})`;
        }
        if (isIdent(t)) {
            const fieldRaw = eat();
            if (!fieldRaw) return null;
            const fieldObj = canonicalIdent(fieldRaw);
            if (!fieldObj) return null;
            return parsePredicateTail(fieldObj);
        }
        return null;
    }

    function parsePredicateTail(fieldObj: { name: string; rawName: string }): string | null {
        const field = fieldObj.name;
        const fieldRawName = fieldObj.rawName;
        const t = peek();

        if (t === 'IS') {
            eat('IS');
            let not = '';
            if (peek() === 'NOT') {
                eat('NOT');
                not = ' NOT';
            }
            if (eat('NULL') == null) return null;
            return `${field} IS${not} NULL`;
        }

        if (t === 'BETWEEN') {
            eat('BETWEEN');
            const aRaw = eat();
            if (!isLiteral(aRaw)) return null;
            const a = formatLiteralForField(fieldRawName, aRaw);
            if (a == null) return null;

            if (eat('AND') == null) return null;

            const bRaw = eat();
            if (!isLiteral(bRaw)) return null;
            const b = formatLiteralForField(fieldRawName, bRaw);
            if (b == null) return null;

            return `${field} BETWEEN ${a} AND ${b}`;
        }

        if (t === 'IN') {
            eat('IN');
            if (eat('(') == null) return null;
            const items: string[] = [];
            while (true) {
                const vRaw = eat();
                if (!isLiteral(vRaw)) return null;
                const v = formatLiteralForField(fieldRawName, vRaw);
                if (v == null) return null;
                items.push(v);
                if (peek() === ',') {
                    eat(',');
                    continue;
                }
                break;
            }
            if (eat(')') == null) return null;
            return `${field} IN (${items.join(', ')})`;
        }

        if (t === 'LIKE' || t === 'ILIKE') {
            const op = eat() as string;
            const patRaw = eat();
            if (!isLiteral(patRaw)) return null;
            const pat = formatLiteralForField(fieldRawName, patRaw);
            if (pat == null) return null;

            let suffix = '';
            if (peek() === 'ESCAPE') {
                eat('ESCAPE');
                const esc = eat();
                const escStr = ascertainString(esc);
                if (!isLiteral(escStr)) return null;
                suffix = ` ESCAPE ${escStr}`;
            }
            return `${field} ${op} ${pat}${suffix}`;
        }

        let op: string | undefined;
        const next: string | undefined = peek();
        if (["=", "!=", "<", "<=", ">", ">="].includes(next || '')) {
            op = eat() as string;
        }
        if (!op) return null;
        const vRaw = eat();
        if (!isLiteral(vRaw)) return null;
        const v = formatLiteralForField(fieldRawName, vRaw);
        if (v == null) return null;

        return `${field} ${op} ${v}`;
    }

    function ascertainString(t?: string | null): string | undefined {
        return t && t.startsWith("'") ? t : undefined;
    }

    const expr = parseExpression();
    if (expr == null) return null;
    if (pos !== tokens.length) return null;

    return expr;
}