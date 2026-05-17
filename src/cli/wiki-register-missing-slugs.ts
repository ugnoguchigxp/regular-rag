import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { readAppEnv } from "../app/env";
import { connectDb, createDbConnection } from "../db";
import { sources } from "../db/schema";
import { resolveWikiLinkRef } from "../modules/sources/wiki/link-ref";

type CliOptions = {
	dryRun: boolean;
	all: boolean;
	limit: number;
};

type SourceRow = {
	id: string;
	uri: string;
	category: string;
	metadata: unknown;
};

const PROGRESS_PREFIX = "[wiki:register-slugs]";

function logProgress(message: string): void {
	const timestamp = new Date().toISOString();
	console.error(`${timestamp} ${PROGRESS_PREFIX} ${message}`);
}

function toMetadataRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return { ...(value as Record<string, unknown>) };
}

function parseCliOptions(argv: string[]): CliOptions {
	let dryRun = false;
	let all = false;
	let limit = 0;

	for (const arg of argv) {
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--all") {
			all = true;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			const rawValue = arg.slice("--limit=".length).trim();
			const parsed = Number.parseInt(rawValue, 10);
			if (!Number.isFinite(parsed) || parsed < 0) {
				throw new Error("--limit must be a non-negative integer.");
			}
			limit = parsed;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return { dryRun, all, limit };
}

async function main() {
	const options = parseCliOptions(process.argv.slice(2));
	const env = readAppEnv();
	const dbConnection = createDbConnection(env.databaseUrl);

	logProgress(
		`start dryRun=${options.dryRun} mode=${options.all ? "all" : "missing-only"} limit=${options.limit}`,
	);

	try {
		await connectDb(dbConnection.pgClient);

		const conditions: SQL[] = [eq(sources.sourceKind, "wiki")];
		if (!options.all) {
			conditions.push(
				sql`coalesce(nullif(btrim(${sources.metadata} ->> 'wikiSlug'), ''), '') = ''`,
			);
		}

		const query = dbConnection.db
			.select({
				id: sources.id,
				uri: sources.uri,
				category: sources.category,
				metadata: sources.metadata,
			})
			.from(sources)
			.where(and(...conditions))
			.orderBy(asc(sources.createdAt));

		const rows = (
			options.limit > 0 ? await query.limit(options.limit) : await query
		) as SourceRow[];

		logProgress(`loaded candidates=${rows.length}`);

		let updated = 0;
		let unchanged = 0;
		let unresolved = 0;
		const unresolvedRows: Array<{ id: string; uri: string }> = [];

		for (let index = 0; index < rows.length; index += 1) {
			const row = rows[index] as SourceRow;
			const metadata = toMetadataRecord(row.metadata);
			const resolved = resolveWikiLinkRef({
				sourceUri: row.uri,
				sourceMetadata: metadata,
				sourceCategory: row.category,
			});

			if (!resolved) {
				unresolved += 1;
				if (unresolvedRows.length < 20) {
					unresolvedRows.push({ id: row.id, uri: row.uri });
				}
				continue;
			}

			const slugCategory = resolved.wikiSlug.split("/")[0]?.trim() ?? "";
			const nextCategory = slugCategory || row.category;
			const relativePath =
				typeof metadata.relativePath === "string" &&
				metadata.relativePath.trim().length > 0
					? metadata.relativePath
					: `pages/${resolved.pagePath}`;
			const nextMetadata: Record<string, unknown> = {
				...metadata,
				relativePath,
				wikiSlug: resolved.wikiSlug,
				wikiApiPath: resolved.wikiApiPath,
				wikiRawPath: resolved.wikiRawPath,
			};

			const metadataChanged =
				JSON.stringify(metadata) !== JSON.stringify(nextMetadata);
			const categoryChanged = nextCategory !== row.category;
			if (!metadataChanged && !categoryChanged) {
				unchanged += 1;
				continue;
			}

			if (!options.dryRun) {
				await dbConnection.db
					.update(sources)
					.set({
						category: nextCategory,
						metadata: nextMetadata,
						updatedAt: new Date(),
						lastIndexedAt: new Date(),
					})
					.where(eq(sources.id, row.id));
			}
			updated += 1;

			if ((index + 1) % 100 === 0) {
				logProgress(
					`progress scanned=${index + 1}/${rows.length} updated=${updated} unchanged=${unchanged} unresolved=${unresolved}`,
				);
			}
		}

		console.log(
			JSON.stringify(
				{
					ok: true,
					dryRun: options.dryRun,
					mode: options.all ? "all" : "missing-only",
					scanned: rows.length,
					updated,
					unchanged,
					unresolved,
					unresolvedRows,
				},
				null,
				2,
			),
		);
	} finally {
		if ("end" in dbConnection.pgClient) {
			await dbConnection.pgClient.end();
		}
	}
}

await main();
