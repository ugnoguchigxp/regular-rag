import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider, LlmProvider } from "../providers/types";

import { GraphExtractor } from "./GraphExtractor";
import { KnowledgeGraphService } from "./KnowledgeGraphService";

describe("KnowledgeGraphService", () => {
	const llmProvider: LlmProvider = {
		chatCompletion: vi.fn(),
	};

	const embeddingProvider: EmbeddingProvider = {
		createEmbedding: vi.fn(),
	};

	const graphRepo = {
		upsertNode: vi.fn(),
		upsertEdge: vi.fn(),
		findNodesByNames: vi.fn(),
		traverseBatch: vi.fn(),
		findNodeByName: vi.fn(),
		findPaths: vi.fn(),
		getSubgraph: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("buildGraphFromDocument upserts nodes/edges and skips unknown relation endpoints", async () => {
		vi.spyOn(GraphExtractor.prototype, "extract").mockResolvedValue({
			entities: [
				{ name: "Aspirin", type: "drug", properties: { dosage: "100mg" } },
				{ name: "Fever", type: "disease" },
			],
			relations: [
				{
					source: "Aspirin",
					target: "Fever",
					relationType: "treats",
					weight: 0.9,
				},
				{ source: "Unknown", target: "Fever", relationType: "related_to" },
			],
		});
		vi.mocked(embeddingProvider.createEmbedding)
			.mockResolvedValueOnce([0.1, 0.2, 0.3])
			.mockResolvedValueOnce([0.2, 0.3, 0.4]);

		const service = new KnowledgeGraphService(
			graphRepo as never,
			llmProvider,
			embeddingProvider,
			3,
		);

		const result = await service.buildGraphFromDocument("content");

		expect(result).toEqual({ nodesCreated: 2, edgesCreated: 1 });
		expect(graphRepo.upsertNode).toHaveBeenCalledTimes(2);
		expect(graphRepo.upsertEdge).toHaveBeenCalledTimes(1);
	});

	it("buildGraphFromDocument throws on embedding dimension mismatch", async () => {
		vi.spyOn(GraphExtractor.prototype, "extract").mockResolvedValue({
			entities: [{ name: "Aspirin", type: "drug" }],
			relations: [],
		});
		vi.mocked(embeddingProvider.createEmbedding).mockResolvedValue([1, 2]);

		const service = new KnowledgeGraphService(
			graphRepo as never,
			llmProvider,
			embeddingProvider,
			3,
		);

		await expect(service.buildGraphFromDocument("content")).rejects.toThrow(
			"Embedding dimension mismatch",
		);
	});

	it("getContextForEntities returns null for empty/missing nodes and formatted context otherwise", async () => {
		const service = new KnowledgeGraphService(graphRepo as never, llmProvider);

		await expect(service.getContextForEntities([])).resolves.toBeNull();

		vi.mocked(graphRepo.findNodesByNames).mockResolvedValueOnce([]);
		await expect(
			service.getContextForEntities(["Aspirin"]),
		).resolves.toBeNull();

		vi.mocked(graphRepo.findNodesByNames).mockResolvedValueOnce([
			{
				id: "n1",
				name: "Aspirin",
				type: "drug",
				properties: { dosage: "100mg" },
			},
		]);
		vi.mocked(graphRepo.traverseBatch).mockResolvedValueOnce([
			{
				node: { id: "n2", name: "Fever", type: "disease", properties: {} },
				relation: "treats",
				depth: 1,
				direction: "outgoing",
			},
		]);

		const context = await service.getContextForEntities(["Aspirin"]);
		expect(context).toContain("[Knowledge Graph Context for: Aspirin]");
		expect(context).toContain("Aspirin (drug)");
		expect(context).toContain("Depth 1 relations:");
		expect(context).toContain("[treats] Fever (disease)");
	});

	it("getPathContext returns null when nodes or paths are missing and formats when found", async () => {
		const service = new KnowledgeGraphService(graphRepo as never, llmProvider);

		vi.mocked(graphRepo.findNodeByName).mockResolvedValueOnce(null);
		await expect(service.getPathContext("A", "B")).resolves.toBeNull();

		vi.mocked(graphRepo.findNodeByName)
			.mockResolvedValueOnce({
				id: "a",
				name: "A",
				type: "drug",
				properties: {},
			})
			.mockResolvedValueOnce({
				id: "b",
				name: "B",
				type: "disease",
				properties: {},
			});
		vi.mocked(graphRepo.findPaths).mockResolvedValueOnce([]);
		await expect(service.getPathContext("A", "B")).resolves.toBeNull();

		vi.mocked(graphRepo.findNodeByName)
			.mockResolvedValueOnce({
				id: "a",
				name: "A",
				type: "drug",
				properties: {},
			})
			.mockResolvedValueOnce({
				id: "b",
				name: "B",
				type: "disease",
				properties: {},
			});
		vi.mocked(graphRepo.findPaths).mockResolvedValueOnce([
			{
				path: [
					{ id: "a", name: "A", type: "drug", properties: {} },
					{ id: "b", name: "B", type: "disease", properties: {} },
				],
				relations: ["treats"],
				totalWeight: 1.23,
			},
		]);

		const context = await service.getPathContext("A", "B");
		expect(context).toContain('[Relationship Path: "A" → "B"]');
		expect(context).toContain("Path 1 (weight: 1.23):");
		expect(context).toContain("A (drug)");
		expect(context).toContain("--[treats]-->");
		expect(context).toContain("B (disease)");
	});

	it("getSubgraphContext formats nodes and relations", async () => {
		const service = new KnowledgeGraphService(graphRepo as never, llmProvider);

		vi.mocked(graphRepo.findNodeByName)
			.mockResolvedValueOnce({
				id: "a",
				name: "A",
				type: "drug",
				properties: {},
			})
			.mockResolvedValueOnce(null);
		vi.mocked(graphRepo.getSubgraph).mockResolvedValueOnce({
			nodes: [
				{ id: "a", name: "A", type: "drug", properties: {} },
				{ id: "b", name: "B", type: "disease", properties: {} },
			],
			edges: [
				{
					id: "e1",
					sourceId: "a",
					targetId: "b",
					relationType: "treats",
					weight: 1,
					properties: {},
				},
			],
		});

		const context = await service.getSubgraphContext(["A", "Unknown"]);

		expect(context).toContain("[Knowledge Subgraph]");
		expect(context).toContain("Nodes (2):");
		expect(context).toContain("A (drug)");
		expect(context).toContain("A --[treats]--> B");
	});
});
