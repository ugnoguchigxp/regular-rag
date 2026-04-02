import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../types/llm";

import { ChatbotService } from "./ChatbotService";

describe("ChatbotService", () => {
	const ragRepo = {
		hybridSearch: vi.fn(),
	};
	const cacheRepo = {
		findByHash: vi.fn(),
		incrementHitCount: vi.fn(),
		save: vi.fn(),
	};
	const knowledgeGraphService = {
		getContextForEntities: vi.fn(),
	};
	const llmProvider = {
		chatCompletion: vi.fn(),
	};
	const embeddingProvider = {
		createEmbedding: vi.fn(),
	};
	const webSearchService = {
		search: vi.fn(),
		fetchPageContent: vi.fn(),
	};

	const messages: ChatMessage[] = [
		{ role: "user", content: "What treats fever?" },
	];

	beforeEach(() => {
		vi.clearAllMocks();
		webSearchService.search.mockResolvedValue([]);
		webSearchService.fetchPageContent.mockRejectedValue(new Error("unreachable"));
	});

	it("returns cached response when cache exists", async () => {
		llmProvider.chatCompletion.mockResolvedValueOnce({
			id: "analysis",
			content: '{"should_search":true,"search_query":"fever","top_k":3}',
		});
		cacheRepo.findByHash.mockResolvedValueOnce({
			response: "cached answer",
		});

		const service = new ChatbotService(
			ragRepo as never,
			cacheRepo as never,
			knowledgeGraphService as never,
			llmProvider as never,
			embeddingProvider as never,
			webSearchService as never,
		);

		const result = await service.processRagRequest(messages);

		expect(result).toEqual({ id: "cached", content: "cached answer" });
		expect(cacheRepo.incrementHitCount).toHaveBeenCalledTimes(1);
		expect(embeddingProvider.createEmbedding).not.toHaveBeenCalled();
		expect(ragRepo.hybridSearch).not.toHaveBeenCalled();
	});

	it("runs search + graph context + final response when should_search is true", async () => {
		llmProvider.chatCompletion
			.mockResolvedValueOnce({
				id: "analysis",
				content:
					'{"should_search":true,"search_query":"fever treatment","top_k":3,"identified_entities":["Aspirin"]}',
			})
			.mockResolvedValueOnce({
				id: "final",
				content: "final answer",
				usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
			});
		cacheRepo.findByHash.mockResolvedValueOnce(null);
		embeddingProvider.createEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
		ragRepo.hybridSearch.mockResolvedValueOnce([
			{ id: "d1", path: "/a", content: "doc-a", combinedScore: 0.5 },
			{ id: "d2", path: "/b", content: "doc-b", combinedScore: 0.4 },
		]);
		knowledgeGraphService.getContextForEntities.mockResolvedValueOnce(
			"graph context",
		);

		const service = new ChatbotService(
			ragRepo as never,
			cacheRepo as never,
			knowledgeGraphService as never,
			llmProvider as never,
			embeddingProvider as never,
			webSearchService as never,
		);

		const result = await service.processRagRequest(messages, {
			screen: "home",
		});

		expect(embeddingProvider.createEmbedding).toHaveBeenCalledWith(
			"fever treatment",
		);
		expect(ragRepo.hybridSearch).toHaveBeenCalledWith(
			"fever treatment",
			[0.1, 0.2, 0.3],
			3,
			"home",
		);
		expect(knowledgeGraphService.getContextForEntities).toHaveBeenCalledWith([
			"Aspirin",
		]);
		expect(cacheRepo.save).toHaveBeenCalledTimes(1);
		expect(result.id).toBe("final");
		expect(result.rag?.results).toHaveLength(2);
		expect((result.rag as any).plan.top_k).toBe(3);
	});

	it("skips search when should_search is false", async () => {
		llmProvider.chatCompletion
			.mockResolvedValueOnce({
				id: "analysis",
				content: '{"should_search":false,"search_query":"unused"}',
			})
			.mockResolvedValueOnce({
				id: "final",
				content: "no search answer",
			});
		cacheRepo.findByHash.mockResolvedValueOnce(null);

		const service = new ChatbotService(
			ragRepo as never,
			cacheRepo as never,
			knowledgeGraphService as never,
			llmProvider as never,
			embeddingProvider as never,
			webSearchService as never,
		);

		const result = await service.processRagRequest(messages);

		expect(embeddingProvider.createEmbedding).not.toHaveBeenCalled();
		expect(ragRepo.hybridSearch).not.toHaveBeenCalled();
		expect(result.content).toBe("no search answer");
		expect(result.rag?.results).toEqual([]);
	});

	it("falls back to user message query when analysis output is invalid JSON", async () => {
		llmProvider.chatCompletion
			.mockResolvedValueOnce({
				id: "analysis",
				content: "invalid-json",
			})
			.mockResolvedValueOnce({
				id: "final",
				content: "answer",
			});
		cacheRepo.findByHash.mockResolvedValueOnce(null);
		embeddingProvider.createEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
		ragRepo.hybridSearch.mockResolvedValueOnce([]);
		knowledgeGraphService.getContextForEntities.mockResolvedValueOnce(null);

		const service = new ChatbotService(
			ragRepo as never,
			cacheRepo as never,
			knowledgeGraphService as never,
			llmProvider as never,
			embeddingProvider as never,
			webSearchService as never,
		);

		await service.processRagRequest(messages);

		expect(embeddingProvider.createEmbedding).toHaveBeenCalledWith(
			"What treats fever?",
		);
	});

	it("forces web search when user explicitly requests web search phrase", async () => {
		const explicitWebMessages: ChatMessage[] = [
			{ role: "user", content: "Webから探して糖尿病の最新情報を教えて" },
		];
		llmProvider.chatCompletion
			.mockResolvedValueOnce({
				id: "analysis",
				content:
					'{"should_search":true,"search_query":"糖尿病","force_web_search":true}',
			})
			.mockResolvedValueOnce({
				id: "final",
				content: "web answer",
			});
		cacheRepo.findByHash.mockResolvedValueOnce(null);
		webSearchService.search.mockResolvedValueOnce([
			{
				title: "title-1",
				url: "https://example.com/1",
				snippet: "snippet-1",
				position: 1,
			},
		]);
		webSearchService.fetchPageContent.mockResolvedValueOnce({
			url: "https://example.com/1",
			title: "title-1",
			cleanText: "content-1",
			extractedAt: new Date(),
		});

		const service = new ChatbotService(
			ragRepo as never,
			cacheRepo as never,
			knowledgeGraphService as never,
			llmProvider as never,
			embeddingProvider as never,
			webSearchService as never,
		);

		const result = await service.processRagRequest(explicitWebMessages);

		expect(ragRepo.hybridSearch).not.toHaveBeenCalled();
		expect(embeddingProvider.createEmbedding).not.toHaveBeenCalled();
		expect(webSearchService.search).toHaveBeenCalledWith({
			query: "糖尿病",
			maxResults: 5,
		});
		expect(webSearchService.search).toHaveBeenCalledTimes(1);
		expect(result.web?.results).toHaveLength(1);
	});

	it("falls back to web search when local hybrid search returns no results", async () => {
		llmProvider.chatCompletion
			.mockResolvedValueOnce({
				id: "analysis",
				content: '{"should_search":true,"search_query":"fever treatment","top_k":3}',
			})
			.mockResolvedValueOnce({
				id: "final",
				content: "fallback answer",
			});
		cacheRepo.findByHash.mockResolvedValueOnce(null);
		embeddingProvider.createEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
		ragRepo.hybridSearch.mockResolvedValueOnce([]);
		webSearchService.search.mockResolvedValueOnce([
			{
				title: "web-1",
				url: "https://example.com/w1",
				snippet: "snippet-web-1",
				position: 1,
			},
		]);
		webSearchService.fetchPageContent.mockResolvedValueOnce({
			url: "https://example.com/w1",
			title: "web-1",
			cleanText: "web-content-1",
			extractedAt: new Date(),
		});
		knowledgeGraphService.getContextForEntities.mockResolvedValueOnce(null);

		const service = new ChatbotService(
			ragRepo as never,
			cacheRepo as never,
			knowledgeGraphService as never,
			llmProvider as never,
			embeddingProvider as never,
			webSearchService as never,
		);

		const result = await service.processRagRequest(messages);

		expect(ragRepo.hybridSearch).toHaveBeenCalledTimes(1);
		expect(webSearchService.search).toHaveBeenCalledTimes(1);
		expect(result.web?.results).toHaveLength(1);
		expect(llmProvider.chatCompletion.mock.calls[1][0][0].content).toContain(
			"ローカルデータでは該当情報が見つからなかったため",
		);
	});
});
