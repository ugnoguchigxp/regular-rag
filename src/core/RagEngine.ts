import { randomUUID } from "node:crypto";

import type { Client, Pool } from "pg";
import type { DbConnection } from "../db";
import { connectDb, createDbConnection, wrapExternalClient } from "../db";
import { EMBEDDING_DIMENSIONS } from "../db/schema";
import type { EmbeddingProvider, LlmProvider } from "../providers/types";
import { CacheRepository } from "../repositories/CacheRepository";
import { KnowledgeGraphRepository } from "../repositories/KnowledgeGraphRepository";
import { RagRepository } from "../repositories/RagRepository";
import { ChatbotService } from "../services/ChatbotService";
import { KnowledgeGraphService } from "../services/KnowledgeGraphService";
import type { ChatMessage } from "../types/llm";

/**
 * パッケージが独自に接続を管理するケース
 */
export interface RagEngineConfigWithUrl {
	databaseUrl: string;
	llmProvider: LlmProvider;
	embeddingProvider: EmbeddingProvider;
}

/**
 * ホスト側が既存の pg.Client/Pool を渡すケース（Prisma等と共存時）
 */
export interface RagEngineConfigWithClient {
	pgClient: Client | Pool;
	llmProvider: LlmProvider;
	embeddingProvider: EmbeddingProvider;
}

export type RagEngineConfig =
	| RagEngineConfigWithUrl
	| RagEngineConfigWithClient;

export interface RagResponse {
	id: string;
	content: string;
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
	rag?: {
		results: Array<{
			path: string;
			content: string;
			combinedScore: number;
		}>;
		plan: unknown;
	};
}

/**
 * Regular-RAG のメインファサード
 *
 * @example
 * ```typescript
 * const engine = await RagEngine.create({
 *   databaseUrl: 'postgres://...',
 *   llmProvider: AzureOpenAiProvider.fromEnv(),
 *   embeddingProvider: AzureOpenAiProvider.fromEnv(),
 * });
 *
 * // ドキュメント取り込み（Knowledge Graph 自動構築付き）
 * await engine.ingestDocument('ドキュメントの内容...');
 *
 * // RAGクエリ
 * const result = await engine.query([{ role: 'user', content: '質問' }]);
 * ```
 */
export class RagEngine {
	private connection: DbConnection;
	private ragRepository: RagRepository;
	private chatbotService: ChatbotService;
	private knowledgeGraphService: KnowledgeGraphService;
	private embeddingProvider: EmbeddingProvider;

	private constructor(
		connection: DbConnection,
		ragRepository: RagRepository,
		chatbotService: ChatbotService,
		knowledgeGraphService: KnowledgeGraphService,
		embeddingProvider: EmbeddingProvider,
	) {
		this.connection = connection;
		this.ragRepository = ragRepository;
		this.chatbotService = chatbotService;
		this.knowledgeGraphService = knowledgeGraphService;
		this.embeddingProvider = embeddingProvider;
	}

	/**
	 * RagEngine を初期化する
	 */
	static async create(config: RagEngineConfig): Promise<RagEngine> {
		const expectedEmbeddingDimensions = EMBEDDING_DIMENSIONS;
		let connection: DbConnection | undefined;

		try {
			if ("databaseUrl" in config) {
				connection = createDbConnection(config.databaseUrl);
				await connectDb(connection.pgClient);
			} else {
				connection = wrapExternalClient(config.pgClient);
				await connectDb(connection.pgClient);
			}

			await RagEngine.verifyEmbeddingDimensions(
				config.embeddingProvider,
				expectedEmbeddingDimensions,
			);

			const ragRepository = new RagRepository(
				connection.db,
				expectedEmbeddingDimensions,
			);
			const cacheRepository = new CacheRepository(connection.db);
			const graphRepository = new KnowledgeGraphRepository(connection.db);
			const knowledgeGraphService = new KnowledgeGraphService(
				graphRepository,
				config.llmProvider,
				config.embeddingProvider,
				expectedEmbeddingDimensions,
			);

			const chatbotService = new ChatbotService(
				ragRepository,
				cacheRepository,
				knowledgeGraphService,
				config.llmProvider,
				config.embeddingProvider,
			);

			return new RagEngine(
				connection,
				ragRepository,
				chatbotService,
				knowledgeGraphService,
				config.embeddingProvider,
			);
		} catch (error) {
			if (
				connection?.ownsConnection &&
				"end" in connection.pgClient &&
				typeof connection.pgClient.end === "function"
			) {
				await connection.pgClient.end();
			}
			throw error;
		}
	}

	private static async verifyEmbeddingDimensions(
		embeddingProvider: EmbeddingProvider,
		expectedDimensions: number,
	): Promise<void> {
		const probeEmbedding = await embeddingProvider.createEmbedding(
			"regular-rag dimension probe",
		);
		if (probeEmbedding.length !== expectedDimensions) {
			throw new Error(
				`Embedding dimension mismatch. database expects ${expectedDimensions}, provider returned ${probeEmbedding.length}. ` +
					"Align your Azure embedding deployment with database vector dimensions.",
			);
		}
	}

	/**
	 * RAGクエリを実行する
	 */
	async query(
		messages: ChatMessage[],
		context?: Record<string, string>,
	): Promise<RagResponse> {
		return await this.chatbotService.processRagRequest(messages, context);
	}

	/**
	 * ドキュメントを取り込み、Knowledge Graph を自動構築する
	 */
	async ingestDocument(content: string): Promise<{
		nodesCreated: number;
		edgesCreated: number;
	}> {
		const MAX_EMBEDDING_CHARS = 6000;
		let embeddingInput = content;

		if (content.length > MAX_EMBEDDING_CHARS) {
			// 段落境界（\n\n）で切断を試みる
			const lastParagraph = content.lastIndexOf("\n\n", MAX_EMBEDDING_CHARS);
			if (lastParagraph > MAX_EMBEDDING_CHARS * 0.5) {
				embeddingInput = content.slice(0, lastParagraph);
			} else {
				// 段落境界が見つからない場合は文境界（。や \n）で試みる
				const lastSentence =
					content.match(/[。\n]/g)?.lastIndexOf("。", MAX_EMBEDDING_CHARS) ??
					-1;
				if (lastSentence > MAX_EMBEDDING_CHARS * 0.5) {
					embeddingInput = content.slice(0, lastSentence + 1);
				} else {
					embeddingInput = content.slice(0, MAX_EMBEDDING_CHARS);
				}
			}
		}

		const embedding =
			await this.embeddingProvider.createEmbedding(embeddingInput);

		await this.ragRepository.upsertDocument({
			id: randomUUID(),
			content,
			embedding,
		});

		return await this.knowledgeGraphService.buildGraphFromDocument(content);
	}

	/**
	 * リソースを解放する
	 * 外部 pgClient の場合は接続を閉じない（ホスト側の責任）
	 */
	async close(): Promise<void> {
		if (this.connection.ownsConnection) {
			const client = this.connection.pgClient;
			if ("end" in client && typeof client.end === "function") {
				await client.end();
			}
		}
	}
}
