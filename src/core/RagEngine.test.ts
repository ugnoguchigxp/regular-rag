import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types/llm";

const mocks = vi.hoisted(() => {
	const connectionOwned = {
		pgClient: { end: vi.fn() },
		db: {},
		ownsConnection: true,
	};
	const connectionExternal = {
		pgClient: { end: vi.fn() },
		db: {},
		ownsConnection: false,
	};

	return {
		connectionOwned,
		connectionExternal,
		createDbConnection: vi.fn(() => connectionOwned),
		wrapExternalClient: vi.fn(() => connectionExternal),
		connectDb: vi.fn(),
		ragRepoInstance: { upsertDocument: vi.fn() },
		cacheRepoInstance: {},
		graphRepoInstance: {},
		chatbotServiceInstance: { processRagRequest: vi.fn() },
		knowledgeGraphServiceInstance: { buildGraphFromDocument: vi.fn() },
		RagRepository: vi.fn(function RagRepository() {
			return mocks.ragRepoInstance;
		}),
		CacheRepository: vi.fn(function CacheRepository() {
			return mocks.cacheRepoInstance;
		}),
		KnowledgeGraphRepository: vi.fn(function KnowledgeGraphRepository() {
			return mocks.graphRepoInstance;
		}),
		ChatbotService: vi.fn(function ChatbotService() {
			return mocks.chatbotServiceInstance;
		}),
		KnowledgeGraphService: vi.fn(function KnowledgeGraphService() {
			return mocks.knowledgeGraphServiceInstance;
		}),
	};
});

vi.mock("../db", () => ({
	createDbConnection: mocks.createDbConnection,
	wrapExternalClient: mocks.wrapExternalClient,
	connectDb: mocks.connectDb,
}));

vi.mock("../repositories/RagRepository", () => ({
	RagRepository: mocks.RagRepository,
}));

vi.mock("../repositories/CacheRepository", () => ({
	CacheRepository: mocks.CacheRepository,
}));

vi.mock("../repositories/KnowledgeGraphRepository", () => ({
	KnowledgeGraphRepository: mocks.KnowledgeGraphRepository,
}));

vi.mock("../services/ChatbotService", () => ({
	ChatbotService: mocks.ChatbotService,
}));

vi.mock("../services/KnowledgeGraphService", () => ({
	KnowledgeGraphService: mocks.KnowledgeGraphService,
}));

import { RagEngine } from "./RagEngine";

describe("RagEngine", () => {
	const llmProvider = {
		chatCompletion: vi.fn(),
	};
	const embeddingProvider = {
		createEmbedding: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.createDbConnection.mockReturnValue(mocks.connectionOwned);
		mocks.wrapExternalClient.mockReturnValue(mocks.connectionExternal);
		embeddingProvider.createEmbedding.mockResolvedValue(
			new Array(1536).fill(0),
		);
		mocks.chatbotServiceInstance.processRagRequest.mockResolvedValue({
			id: "r1",
			content: "answer",
		});
		mocks.knowledgeGraphServiceInstance.buildGraphFromDocument.mockResolvedValue(
			{
				nodesCreated: 1,
				edgesCreated: 2,
			},
		);
	});

	it("creates engine with databaseUrl and delegates query", async () => {
		const engine = await RagEngine.create({
			databaseUrl: "postgres://example",
			llmProvider: llmProvider as never,
			embeddingProvider: embeddingProvider as never,
		});

		const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
		const result = await engine.query(messages, { screen: "home" });

		expect(mocks.createDbConnection).toHaveBeenCalledWith("postgres://example");
		expect(mocks.connectDb).toHaveBeenCalledTimes(1);
		expect(embeddingProvider.createEmbedding).toHaveBeenCalledWith(
			"regular-rag dimension probe",
		);
		expect(mocks.chatbotServiceInstance.processRagRequest).toHaveBeenCalledWith(
			messages,
			{ screen: "home" },
		);
		expect(result.content).toBe("answer");
	});

	it("creates engine with external pgClient", async () => {
		const externalClient = { end: vi.fn() };
		await RagEngine.create({
			pgClient: externalClient as never,
			llmProvider: llmProvider as never,
			embeddingProvider: embeddingProvider as never,
		});

		expect(mocks.wrapExternalClient).toHaveBeenCalledWith(externalClient);
		expect(mocks.createDbConnection).not.toHaveBeenCalled();
	});

	it("throws when embedding dimension does not match and closes owned connection", async () => {
		embeddingProvider.createEmbedding.mockResolvedValueOnce([1, 2, 3]);

		await expect(
			RagEngine.create({
				databaseUrl: "postgres://example",
				llmProvider: llmProvider as never,
				embeddingProvider: embeddingProvider as never,
			}),
		).rejects.toThrow("Embedding dimension mismatch");

		expect(mocks.connectionOwned.pgClient.end).toHaveBeenCalledTimes(1);
	});

	it("ingests document with truncated embedding input and upserts full content", async () => {
		const engine = await RagEngine.create({
			databaseUrl: "postgres://example",
			llmProvider: llmProvider as never,
			embeddingProvider: embeddingProvider as never,
		});

		const paragraph1 = "A".repeat(5900);
		const paragraph2 = "B".repeat(2000);
		const content = `${paragraph1}\n\n${paragraph2}`;
		embeddingProvider.createEmbedding
			.mockResolvedValueOnce(new Array(1536).fill(0))
			.mockResolvedValueOnce(new Array(1536).fill(1));

		const result = await engine.ingestDocument(content);

		const embeddingInput = embeddingProvider.createEmbedding.mock.calls[1][0];
		expect(typeof embeddingInput).toBe("string");
		expect((embeddingInput as string).length).toBeLessThan(content.length);
		expect(mocks.ragRepoInstance.upsertDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				content,
				embedding: expect.arrayContaining([0]),
			}),
		);
		expect(result).toEqual({ nodesCreated: 1, edgesCreated: 2 });
	});

	it("ingests document using sentence boundary when paragraph boundary is unavailable", async () => {
		const engine = await RagEngine.create({
			databaseUrl: "postgres://example",
			llmProvider: llmProvider as never,
			embeddingProvider: embeddingProvider as never,
		});

		const content = `${"。".repeat(3501)}${"B".repeat(4000)}`;
		await engine.ingestDocument(content);

		const embeddingInput = embeddingProvider.createEmbedding.mock.calls[1][0] as string;
		expect(embeddingInput.endsWith("。")).toBe(true);
		expect(embeddingInput.length).toBeGreaterThan(3000);
		expect(embeddingInput.length).toBeLessThan(content.length);
	});

	it("ingests document using hard 6000-char fallback when no boundary is available", async () => {
		const engine = await RagEngine.create({
			databaseUrl: "postgres://example",
			llmProvider: llmProvider as never,
			embeddingProvider: embeddingProvider as never,
		});

		const content = "X".repeat(8000);
		await engine.ingestDocument(content);

		const embeddingInput = embeddingProvider.createEmbedding.mock.calls[1][0] as string;
		expect(embeddingInput.length).toBe(6000);
	});

	it("does not close external client when create fails with external connection", async () => {
		mocks.connectDb.mockRejectedValueOnce(new Error("connection failed"));
		await expect(
			RagEngine.create({
				pgClient: { end: vi.fn() } as never,
				llmProvider: llmProvider as never,
				embeddingProvider: embeddingProvider as never,
			}),
		).rejects.toThrow("connection failed");
		expect(mocks.connectionExternal.pgClient.end).not.toHaveBeenCalled();
	});

	it("close only ends owned connections", async () => {
		const owned = await RagEngine.create({
			databaseUrl: "postgres://owned",
			llmProvider: llmProvider as never,
			embeddingProvider: embeddingProvider as never,
		});
		await owned.close();
		expect(mocks.connectionOwned.pgClient.end).toHaveBeenCalledTimes(1);

		const external = await RagEngine.create({
			pgClient: { end: vi.fn() } as never,
			llmProvider: llmProvider as never,
			embeddingProvider: embeddingProvider as never,
		});
		await external.close();
		expect(mocks.connectionExternal.pgClient.end).not.toHaveBeenCalled();
	});
});
