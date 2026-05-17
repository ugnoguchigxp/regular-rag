import { describe, expect, it, vi } from "vitest";
import { SourceRetriever } from "./retriever";

const sampleResult = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: "frag-1",
	sourceId: "src-1",
	sourceUri: "/tmp/wiki/pages/tech/rag.md",
	sourceCategory: "tech",
	sourceMetadata: { relativePath: "pages/tech/rag.md" },
	locator: "chunk:0001",
	heading: "RAG",
	content: "retrieval augmented generation",
	score: 0.9,
	...overrides,
});

describe("SourceRetriever", () => {
	it("returns text results even when vector retrieval fails", async () => {
		const sourceRepository = {
			vectorSearchSourceContent: vi.fn(),
			searchSourceContent: vi
				.fn()
				.mockResolvedValue([sampleResult({ id: "text-1", score: 0.7 })]),
		};
		const embeddingProvider = {
			createEmbedding: vi
				.fn()
				.mockRejectedValue(new Error("embedding provider unavailable")),
		};
		const retriever = new SourceRetriever(
			sourceRepository as never,
			embeddingProvider as never,
		);

		const breakdown = await retriever.retrieveBreakdown("hono", {
			topK: 5,
			category: "tech",
		});
		const evaluation = await retriever.evaluate("hono", {
			topK: 5,
			enableTrigramFallback: true,
			category: "tech",
		});

		expect(embeddingProvider.createEmbedding).toHaveBeenCalledTimes(2);
		expect(sourceRepository.vectorSearchSourceContent).not.toHaveBeenCalled();
		expect(sourceRepository.searchSourceContent).toHaveBeenCalledWith(
			"hono",
			25,
			["wiki"],
			["tech"],
		);
		expect(breakdown.vectorResults).toEqual([]);
		expect(breakdown.textResults).toHaveLength(1);
		expect(breakdown.mergedResults).toHaveLength(1);
		expect(evaluation.strategy).toBe("merged");
		expect(evaluation.selectedResults).toHaveLength(1);
	});

	it("short-circuits blank queries", async () => {
		const sourceRepository = {
			vectorSearchSourceContent: vi.fn(),
			searchSourceContent: vi.fn(),
		};
		const embeddingProvider = {
			createEmbedding: vi.fn(),
		};
		const retriever = new SourceRetriever(
			sourceRepository as never,
			embeddingProvider as never,
		);

		const result = await retriever.retrieveBreakdown("   ", {
			topK: 8,
		});

		expect(result).toEqual({
			vectorResults: [],
			textResults: [],
			mergedResults: [],
		});
		expect(embeddingProvider.createEmbedding).not.toHaveBeenCalled();
		expect(sourceRepository.vectorSearchSourceContent).not.toHaveBeenCalled();
		expect(sourceRepository.searchSourceContent).not.toHaveBeenCalled();
	});
});
