import { describe, it, expect } from "vitest";
import sanitizeWhereParam from "../src/libs/sanitized-query";

describe("sanitizeWhereParam", () => {
    it("should accept valid simple conditions", () => {
        const allowed = new Set(["status", "age", "name", "geom"]);
        const raw = "status = 'active' AND age >= 18";
        const result = sanitizeWhereParam(raw, { allowedFields: allowed });
        expect(result).toBe('("status" = \'active\' AND "age" >= 18)');
    });

    it("should support OR and NOT operators with parenthesis grouping", () => {
        const allowed = new Set(["status", "age", "name"]);
        const raw = "(status = 'active' OR NOT age < 18)";
        const result = sanitizeWhereParam(raw, { allowedFields: allowed });
        expect(result).toBe('(("status" = \'active\' OR (NOT "age" < 18)))');
    });

    it("should support IS NULL and IS NOT NULL predicates", () => {
        const allowed = new Set(["deleted_at", "email"]);
        const raw = "deleted_at IS NULL AND email IS NOT NULL";
        const result = sanitizeWhereParam(raw, { allowedFields: allowed });
        expect(result).toBe('("deleted_at" IS NULL AND "email" IS NOT NULL)');
    });

    it("should reject SQL injection attempts with semicolons, comments, and DDL/DML keywords", () => {
        const allowed = new Set(["status", "age", "name"]);
        const dangerousQueries = [
            "status = 'active'; DROP TABLE users; --",
            "age > 10 -- comment",
            "status = 'active' /* comment */",
            "INSERT INTO users VALUES (1)",
            "SELECT * FROM users",
            "UPDATE users SET age = 0",
            "DELETE FROM users",
            "ALTER TABLE users ADD COLUMN secret text",
            "status = 'a' $$ sql $$",
            "age::text = '10'",
        ];

        for (const q of dangerousQueries) {
            expect(sanitizeWhereParam(q, { allowedFields: allowed })).toBeNull();
        }
    });

    it("should reject unauthorized column references", () => {
        const allowed = new Set(["status", "age"]);
        const raw = "password = 'secret'";
        const result = sanitizeWhereParam(raw, { allowedFields: allowed });
        expect(result).toBeNull();
    });

    it("should correctly parse IN and BETWEEN expressions", () => {
        const allowed = new Set(["id", "category", "score"]);
        const raw = "id IN (1, 2, 3) AND score BETWEEN 80 AND 100";
        const result = sanitizeWhereParam(raw, { allowedFields: allowed });
        expect(result).toBe('("id" IN (1, 2, 3) AND "score" BETWEEN 80 AND 100)');
    });

    it("should correctly parse LIKE and ILIKE expressions with optional ESCAPE", () => {
        const allowed = new Set(["name", "code"]);
        const raw = "name LIKE 'John%' AND code ILIKE 'A\\_%' ESCAPE '\\'";
        const result = sanitizeWhereParam(raw, { allowedFields: allowed });
        expect(result).toBe('("name" LIKE \'John%\' AND "code" ILIKE \'A\\_%\' ESCAPE \'\\\')');
    });

    it("should coerce numeric literals to quoted string literals for varchar/text columns", () => {
        const allowed = new Set(["code", "name"]);
        const fieldTypes = { code: "character varying(50)", name: "text" };
        const raw = "code = 1234";
        const result = sanitizeWhereParam(raw, { allowedFields: allowed, fieldTypes });
        expect(result).toBe('"code" = \'1234\'');
    });

    it("should reject invalid string literals for numeric columns", () => {
        const allowed = new Set(["age"]);
        const fieldTypes = { age: "integer" };
        const raw = "age = 'abc'";
        const result = sanitizeWhereParam(raw, { allowedFields: allowed, fieldTypes });
        expect(result).toBeNull();
    });

    it("should coerce numeric literals in IN clauses for varchar columns", () => {
        const allowed = new Set(["code"]);
        const fieldTypes = { code: "varchar" };
        const raw = "code IN (100, 200)";
        const result = sanitizeWhereParam(raw, { allowedFields: allowed, fieldTypes });
        expect(result).toBe('"code" IN (\'100\', \'200\')');
    });

    it("should handle boolean field normalization", () => {
        const allowed = new Set(["is_active"]);
        const fieldTypes = { is_active: "boolean" };
        const raw = "is_active = 1";
        const result = sanitizeWhereParam(raw, { allowedFields: allowed, fieldTypes });
        expect(result).toBe('"is_active" = TRUE');
    });

    it("should return null for empty or whitespace-only inputs", () => {
        expect(sanitizeWhereParam("")).toBeNull();
        expect(sanitizeWhereParam("   ")).toBeNull();
    });
});
