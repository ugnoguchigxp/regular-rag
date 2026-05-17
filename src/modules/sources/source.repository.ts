import { createHash } from "node:crypto";
import {
	and,
	desc,
	eq,
	ilike,
	notInArray,
	or,
	sql,
	type SQL,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { EmbeddingProvider } from "../../providers/types";
import type * as schema from "../../db/schema";
import { sourceFragments, sources } from "../../db/schema";

export type SourceKind = "wiki";

export type UpsertSourceParams = {
	sourceKind: SourceKind;
	uri: string;
	title?: string;
	body: string;
	contentHash?: string;
	metadata?: Record<string, unknown>;
};

export type SourceSearchResult = {
	id: string;
	sourceId: string;
	sourceUri: string;
	locator: string;
	heading: string | null;
	content: string;
	score: number;
};

function defaultHash(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function finiteOrZero(value: unknown): number {
	const num = Number(value);
	return Number.isFinite(num) ? num : 0;
}

function chunkSourceDocument(params: {
	title?: string | null;
	body: string;
	maxChars?: number;
}): Array<{ locator: string; heading: string | null; content: string }> {
	const maxChars = params.maxChars ?? 2500;
	const lines = params.body.split("\n");
	const chunks: Array<{
		locator: string;
		heading: string | null;
		content: string;
	}> = [];
	let heading = params.title ?? null;
	let buffer: string[] = [];
	let index = 1;

	const flush = () => {
		const content = buffer.join("\n").trim();
		if (!content) return;
		chunks.push({
			locator: `chunk:${String(index).padStart(4, "0")}`,
			heading,
			content,
		});
		index += 1;
		buffer = [];
	};

	for (const line of lines) {
		const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
		if (headingMatch && buffer.join("\n").trim().length > 0) {
			flush();
			heading = headingMatch[2]?.trim() || heading;
		}
		buffer.push(line);
		if (buffer.join("\n").length >= maxChars) {
			flush();
		}
	}
	flush();

	if (chunks.length === 0) {
		const content = params.body.trim();
		return content
			? [{ locator: "full", heading: params.title ?? null, content }]
			: [];
	}
	return chunks;
}

export class SourceRepository {
	constructor(
		private readonly db: NodePgDatabase<typeof schema>,
		private readonly embeddingProvider: EmbeddingProvider,
	) {}

	private async tryEmbed(content: string): Promise<number[] | undefined> {
		try {
			return await this.embeddingProvider.createEmbedding(content);
		} catch {
			return undefined;
		}
	}

	private async replaceSourceFragments(params: {
		sourceId: string;
		title?: string | null;
		body: string;
		metadata?: Record<string, unknown>;
	}): Promise<number> {
		await this.db
			.delete(sourceFragments)
			.where(eq(sourceFragments.sourceId, params.sourceId));

		const chunks = chunkSourceDocument({
			title: params.title,
			body: params.body,
		});
		if (chunks.length === 0) return 0;

		await this.db.insert(sourceFragments).values(
			await Promise.all(
				chunks.map(async (chunk) => {
					const metadataJson = params.metadata ?? {};
					return {
						sourceId: params.sourceId,
						locator: chunk.locator,
						heading: chunk.heading,
						content: chunk.content,
						searchVector: sql`to_tsvector('simple', ${chunk.content})`,
						metadata: metadataJson,
						embedding: await this.tryEmbed(chunk.content),
					};
				}),
			),
		);
		return chunks.length;
	}

	async upsertSourceDocument(params: UpsertSourceParams): Promise<string> {
		const contentHash =
			params.contentHash ??
			defaultHash(`${params.sourceKind}\n${params.uri}\n${params.body}`);

		const existing = await this.db.query.sources.findFirst({
			where: eq(sources.uri, params.uri),
			columns: { id: true, contentHash: true },
		});

		if (existing) {
			if (existing.contentHash === contentHash) {
				await this.db
					.update(sources)
					.set({
						title: params.title ?? null,
						metadata: params.metadata ?? {},
						updatedAt: new Date(),
						lastIndexedAt: new Date(),
					})
					.where(eq(sources.id, existing.id));
				return existing.id;
			}

			await this.db
				.update(sources)
				.set({
					sourceKind: params.sourceKind,
					uri: params.uri,
					title: params.title ?? null,
					body: params.body,
					contentHash,
					metadata: params.metadata ?? {},
					updatedAt: new Date(),
					lastIndexedAt: new Date(),
				})
				.where(eq(sources.id, existing.id));
			await this.replaceSourceFragments({
				sourceId: existing.id,
				title: params.title,
				body: params.body,
				metadata: params.metadata,
			});
			return existing.id;
		}

		const [inserted] = await this.db
			.insert(sources)
			.values({
				sourceKind: params.sourceKind,
				uri: params.uri,
				title: params.title ?? null,
				body: params.body,
				contentHash,
				metadata: params.metadata ?? {},
				lastIndexedAt: new Date(),
			})
			.returning({ id: sources.id });

		await this.replaceSourceFragments({
			sourceId: inserted.id,
			title: params.title,
			body: params.body,
			metadata: params.metadata,
		});
		return inserted.id;
	}

	async deleteSourceByUri(uri: string): Promise<void> {
		await this.db.delete(sources).where(eq(sources.uri, uri));
	}

	async deleteStaleSourcesForRoot(params: {
		rootPath: string;
		keepUris: string[];
	}): Promise<number> {
		const normalizedRootPath = params.rootPath;
		const keepSet = [
			...new Set(params.keepUris.map((uri) => uri.trim()).filter(Boolean)),
		];

		const conditions: SQL[] = [
			ilike(sources.uri, `${normalizedRootPath}/pages/%`),
		];
		if (keepSet.length > 0) {
			conditions.push(notInArray(sources.uri, keepSet));
		}

		const deleted = await this.db
			.delete(sources)
			.where(and(...conditions))
			.returning({ id: sources.id });
		return deleted.length;
	}

	async vectorSearchSourceContent(
		embedding: number[],
		limit: number,
		sourceKinds?: SourceKind[],
	): Promise<SourceSearchResult[]> {
		const embeddingStr = JSON.stringify(embedding);
		const similarity = sql<number>`1 - (${sourceFragments.embedding} <=> ${embeddingStr}::vector)`;
		const conditions: SQL[] = [sql`${sourceFragments.embedding} IS NOT NULL`];
		if (sourceKinds && sourceKinds.length > 0) {
			conditions.push(sql`${sources.sourceKind} = ANY(${sourceKinds})`);
		}

		const rows = await this.db
			.select({
				id: sourceFragments.id,
				sourceId: sourceFragments.sourceId,
				sourceUri: sources.uri,
				locator: sourceFragments.locator,
				heading: sourceFragments.heading,
				content: sourceFragments.content,
				score: similarity,
			})
			.from(sourceFragments)
			.innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
			.where(and(...conditions))
			.orderBy(desc(similarity), desc(sourceFragments.createdAt))
			.limit(limit);

		return rows.map((row) => ({ ...row, score: finiteOrZero(row.score) }));
	}

	async searchSourceContent(
		query: string,
		limit: number,
		sourceKinds?: SourceKind[],
	): Promise<SourceSearchResult[]> {
		const trimmedQuery = query.trim();
		if (!trimmedQuery) return [];

		const rankExpr = sql<number>`
      ts_rank_cd(
        to_tsvector('simple', concat_ws(' ', ${sourceFragments.heading}, ${sourceFragments.content}, ${sourceFragments.metadata}::text)),
        plainto_tsquery('simple', ${trimmedQuery})
      )
    `;

		const textMatchExpr = sql<boolean>`
      to_tsvector('simple', concat_ws(' ', ${sourceFragments.heading}, ${sourceFragments.content}, ${sourceFragments.metadata}::text))
      @@ plainto_tsquery('simple', ${trimmedQuery})
    `;

		const conditions = [
			or(
				ilike(sourceFragments.content, `%${trimmedQuery}%`),
				ilike(sourceFragments.heading, `%${trimmedQuery}%`),
				sql`${sourceFragments.metadata}::text ilike ${`%${trimmedQuery}%`}`,
				textMatchExpr,
			),
		];
		if (sourceKinds && sourceKinds.length > 0) {
			conditions.push(sql`${sources.sourceKind} = ANY(${sourceKinds})`);
		}

		const rows = await this.db
			.select({
				id: sourceFragments.id,
				sourceId: sourceFragments.sourceId,
				sourceUri: sources.uri,
				locator: sourceFragments.locator,
				heading: sourceFragments.heading,
				content: sourceFragments.content,
				score: rankExpr,
			})
			.from(sourceFragments)
			.innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
			.where(and(...conditions))
			.orderBy(desc(rankExpr), desc(sourceFragments.createdAt))
			.limit(limit);

		return rows.map((row) => ({ ...row, score: finiteOrZero(row.score) }));
	}

	async getFragmentById(fragmentId: string) {
		const rows = await this.db
			.select({
				id: sourceFragments.id,
				sourceId: sourceFragments.sourceId,
				locator: sourceFragments.locator,
				heading: sourceFragments.heading,
				content: sourceFragments.content,
				metadata: sourceFragments.metadata,
				source: {
					id: sources.id,
					uri: sources.uri,
					title: sources.title,
				},
			})
			.from(sourceFragments)
			.innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
			.where(eq(sourceFragments.id, fragmentId))
			.limit(1);

		return rows[0] ?? null;
	}
}
