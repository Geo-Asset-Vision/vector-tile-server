import fs from "node:fs";
import path from "node:path";
import { checkConnection, disconnect, getClient, query } from "../src/libs/db";
import env from "../src/libs/env";

const SAMPLE_TABLES = [
    "sample_points",
    "sample_lines",
    "sample_polygons",
    "sample_multi_points",
    "sample_multi_lines",
    "sample_multi_polygons",
] as const;

async function seedSampleData() {
    const sqlFilePath = path.join(import.meta.dirname, "seed-sample-data.sql");

    console.log("🌱 Seeding sample data...");
    console.log(`📡 Target database: ${env.POSTGIS_USER}@${env.POSTGIS_HOST}:${env.POSTGIS_PORT}/${env.POSTGIS_DB}`);

    if (!fs.existsSync(sqlFilePath)) {
        throw new Error(`SQL file not found at ${sqlFilePath}`);
    }

    const isConnected = await checkConnection();
    if (!isConnected) {
        throw new Error("Unable to establish connection to PostgreSQL / PostGIS database.");
    }

    const sqlContent = fs.readFileSync(sqlFilePath, "utf-8");

    console.log("🚀 Executing SQL seed script...");
    const client = await getClient();
    try {
        await client.query(sqlContent);
        console.log("✅ SQL seed script executed successfully.\n");

        console.log("📊 Sample Data Summary:");
        for (const tableName of SAMPLE_TABLES) {
            const res = await query<{ count: string }>(`SELECT count(*) FROM ${tableName}`);
            console.log(`   - ${tableName}: ${res.rows[0]?.count ?? "0"} rows`);
        }
        console.log("\n🎉 Seed completed successfully!");
    } finally {
        client.release();
    }
}

async function main() {
    try {
        await seedSampleData();
    } catch (error) {
        console.error("❌ Seed failed with error:", error);
        process.exitCode = 1;
    } finally {
        await disconnect();
    }
}

main();
