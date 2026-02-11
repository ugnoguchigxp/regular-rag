import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { EMBEDDING_DIMENSIONS, ragDocuments } from "../db/schema";

export type RagResult = {
	id: string;
	path: string;
	content: string;
	screen?: string;
	vectorScore?: number;
	textScore?: number;
	combinedScore: number;
	metadata?: Record<string, unknown>;
};

export class RagRepository {
	constructor(
		private db: NodePgDatabase<typeof schema>,
		private expectedEmbeddingDimensions = EMBEDDING_DIMENSIONS,
	) {}

	async upsertDocument(doc: {
		id: string;
		content: string;
		path?: string;
		metadata?: Record<string, unknown>;
		screen?: string;
		domain?: string;
		embedding?: number[];
	}): Promise<void> {
		if (
			doc.embedding &&
			doc.embedding.length !== this.expectedEmbeddingDimensions
		) {
			throw new Error(
				`Embedding dimension mismatch: expected ${this.expectedEmbeddingDimensions}, got ${doc.embedding.length}`,
			);
		}

		await this.db
			.insert(ragDocuments)
			.values({
				id: doc.id,
				content: doc.content,
				path: doc.path,
				metadata: doc.metadata,
				screen: doc.screen,
				domain: doc.domain,
				embedding: doc.embedding,
				tsv: sql`to_tsvector('simple', ${doc.content})`,
			})
			.onConflictDoUpdate({
				target: ragDocuments.id,
				set: {
					content: doc.content,
					path: doc.path,
					metadata: doc.metadata,
					screen: doc.screen,
					domain: doc.domain,
					embedding: doc.embedding,
					tsv: sql`to_tsvector('simple', ${doc.content})`,
					updatedAt: sql`now()`,
				},
			});
	}

	async findByVector(embedding: number[], topK: number, screen?: string) {
		if (!embedding.every((v) => typeof v === "number" && Number.isFinite(v))) {
			throw new Error("Invalid embedding: all elements must be finite numbers");
		}
		if (embedding.length !== this.expectedEmbeddingDimensions) {
			throw new Error(
				`Embedding dimension mismatch: expected ${this.expectedEmbeddingDimensions}, got ${embedding.length}`,
			);
		}
		const vectorLiteral = `[${embedding.join(",")}]`;
		const distanceExpr = sql<number>`${ragDocuments.embedding} <-> ${vectorLiteral}::vector`;

		const result = await this.db
			.select({
				id: ragDocuments.id,
				path: ragDocuments.path,
				content: ragDocuments.content,
				distance: distanceExpr,
				screen: ragDocuments.screen,
				metadata: ragDocuments.metadata,
			})
			.from(ragDocuments)
			.where(
				and(
					isNotNull(ragDocuments.embedding),
					screen ? eq(ragDocuments.screen, screen) : undefined,
				),
			)
			.orderBy(distanceExpr)
			.limit(topK);

		return result.map((r) => ({
			...r,
			path: r.path ?? "",
			screen: r.screen ?? undefined,
			metadata: r.metadata ?? undefined,
			vectorScore: 1 / (1 + (r.distance ?? 0)),
		}));
	}

	async findByText(query: string, topK: number, screen?: string) {
		const queryExpr = sql`plainto_tsquery('simple', ${query})`;
		const rankExpr = sql<number>`ts_rank(${ragDocuments.tsv}, ${queryExpr})`;

		const result = await this.db
			.select({
				id: ragDocuments.id,
				path: ragDocuments.path,
				content: ragDocuments.content,
				rank: rankExpr,
				screen: ragDocuments.screen,
				metadata: ragDocuments.metadata,
			})
			.from(ragDocuments)
			.where(
				and(
					isNotNull(ragDocuments.tsv),
					sql`${ragDocuments.tsv} @@ ${queryExpr}`,
					screen ? eq(ragDocuments.screen, screen) : undefined,
				),
			)
			.orderBy(desc(rankExpr))
			.limit(topK);

		return result.map((r) => ({
			...r,
			path: r.path ?? "",
			screen: r.screen ?? undefined,
			metadata: r.metadata ?? undefined,
			textScore: r.rank,
		}));
	}

	async hybridSearch(
		query: string,
		embedding: number[],
		topK: number,
		screen?: string,
	): Promise<RagResult[]> {
		const [vectorResults, textResults] = await Promise.all([
			this.findByVector(embedding, topK, screen),
			this.findByText(query, topK, screen),
		]);

		const merged = new Map<string, RagResult>();
		const RRF_CONSTANT = 60; // 文献等で推奨される定数

		// ベクトル検索の結果を RRF スコアで初期化
		vectorResults.forEach((res, index) => {
			const rank = index + 1;
			const rrfScore = 1 / (RRF_CONSTANT + rank);
			merged.set(res.id, {
				...res,
				combinedScore: rrfScore,
			} as RagResult);
		});

		// テキスト検索の結果を RRF スコアで統合
		textResults.forEach((res, index) => {
			const rank = index + 1;
			const rrfScore = 1 / (RRF_CONSTANT + rank);
			const existing = merged.get(res.id);
			if (existing) {
				existing.textScore = res.textScore;
				existing.combinedScore += rrfScore;
			} else {
				merged.set(res.id, {
					...res,
					combinedScore: rrfScore,
				} as RagResult);
			}
		});

		return Array.from(merged.values())
			.sort((a, b) => b.combinedScore - a.combinedScore)
			.slice(0, topK);
	}
}
