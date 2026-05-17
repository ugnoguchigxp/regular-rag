import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { readAppEnv } from "../app/env";

type MigrationRecord = {
	filename: string;
	applied_at: Date;
};

const MIGRATIONS_TABLE = "regular_rag_schema_migrations";

async function listSqlMigrations(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));
}

async function ensureMigrationsTable(client: Client): Promise<void> {
	await client.query(`
		CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
			filename text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`);
}

async function appliedMigrations(client: Client): Promise<Set<string>> {
	const result = await client.query<MigrationRecord>(
		`SELECT filename, applied_at FROM ${MIGRATIONS_TABLE}`,
	);
	return new Set(result.rows.map((row) => row.filename));
}

async function applyMigrationFile(
	client: Client,
	migrationsDir: string,
	filename: string,
): Promise<void> {
	const fullPath = path.resolve(migrationsDir, filename);
	const sqlText = await readFile(fullPath, "utf8");
	await client.query("BEGIN");
	try {
		await client.query(sqlText);
		await client.query(
			`INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1)`,
			[filename],
		);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

async function main() {
	const env = readAppEnv();
	const client = new Client({ connectionString: env.databaseUrl });
	const migrationsDir = path.resolve(process.cwd(), "drizzle");

	await client.connect();
	try {
		await ensureMigrationsTable(client);
		const allMigrations = await listSqlMigrations(migrationsDir);
		const applied = await appliedMigrations(client);
		const pending = allMigrations.filter((filename) => !applied.has(filename));

		for (const filename of pending) {
			await applyMigrationFile(client, migrationsDir, filename);
			console.log(`applied: ${filename}`);
		}

		console.log(
			JSON.stringify(
				{
					ok: true,
					total: allMigrations.length,
					applied: pending.length,
					skipped: allMigrations.length - pending.length,
				},
				null,
				2,
			),
		);
	} finally {
		await client.end();
	}
}

await main();
