import { describe, expect, it, vi } from "vitest";

import type { LlmProvider } from "../providers/types";

import { GraphExtractor } from "./GraphExtractor";

describe("GraphExtractor", () => {
	it("extracts and de-duplicates entities and relations across chunks", async () => {
		const llmProvider: LlmProvider = {
			chatCompletion: vi
				.fn()
				.mockResolvedValueOnce({
					id: "1",
					content: JSON.stringify({
						entities: [
							{
								name: "Aspirin",
								type: "drug",
								properties: { source: "first" },
							},
							{ name: "Fever", type: "disease" },
						],
						relations: [
							{
								source: "Aspirin",
								target: "Fever",
								relationType: "treats",
								weight: 1,
							},
						],
					}),
				})
				.mockResolvedValueOnce({
					id: "2",
					content: JSON.stringify({
						entities: [
							{
								name: "aspirin",
								type: "drug",
								properties: { confidence: 0.9 },
							},
							{ name: "Hospital", type: "organization" },
						],
						relations: [
							{
								source: "aspirin",
								target: "Fever",
								relationType: "treats",
								weight: 0.8,
							},
							{
								source: "Hospital",
								target: "Fever",
								relationType: "related_to",
							},
						],
					}),
				}),
		};

		const extractor = new GraphExtractor(llmProvider);
		const content = `${"a".repeat(3100)}\n\n${"b".repeat(3100)}`;

		const result = await extractor.extract(content);

		expect((llmProvider.chatCompletion as any).mock.calls.length).toBeGreaterThanOrEqual(
			2,
		);
		expect(result.entities).toHaveLength(3);
		expect(result.relations).toHaveLength(2);
		expect(
			result.entities.find((e) => e.name.toLowerCase() === "aspirin")
				?.properties,
		).toEqual({
			source: "first",
			confidence: 0.9,
		});
	});

	it("returns empty extraction when LLM output is invalid", async () => {
		const llmProvider: LlmProvider = {
			chatCompletion: vi.fn().mockResolvedValue({
				id: "1",
				content: "not-json",
			}),
		};

		const extractor = new GraphExtractor(llmProvider);
		const result = await extractor.extract("short text");
		expect(result).toEqual({ entities: [], relations: [] });
	});

	it("returns empty extraction when JSON does not satisfy schema", async () => {
		const llmProvider: LlmProvider = {
			chatCompletion: vi.fn().mockResolvedValue({
				id: "1",
				content: JSON.stringify({
					entities: [{ name: "Aspirin" }],
					relations: [],
				}),
			}),
		};

		const extractor = new GraphExtractor(llmProvider);
		const result = await extractor.extract("schema-mismatch");
		expect(result).toEqual({ entities: [], relations: [] });
	});

	it("splitIntoChunks handles paragraph boundaries and oversized paragraphs", () => {
		const llmProvider: LlmProvider = { chatCompletion: vi.fn() };
		const extractor = new GraphExtractor(llmProvider);
		const splitIntoChunks = (extractor as any).splitIntoChunks.bind(extractor);

		const small = splitIntoChunks("short", 10);
		expect(small).toEqual(["short"]);

		const oversizedParagraph = "A".repeat(25);
		const mixed = splitIntoChunks(`p1\n\n${oversizedParagraph}\n\np2`, 10);
		expect(mixed.length).toBeGreaterThanOrEqual(4);
		expect(mixed.some((c: string) => c.includes("p1"))).toBe(true);
		expect(mixed.some((c: string) => c.includes("p2"))).toBe(true);
	});

	it("splitLargeParagraph splits by sentence and by hard chunk size fallback", () => {
		const llmProvider: LlmProvider = { chatCompletion: vi.fn() };
		const extractor = new GraphExtractor(llmProvider);
		const splitLargeParagraph = (extractor as any).splitLargeParagraph.bind(extractor);

		const bySentence = splitLargeParagraph(
			"Sentence one. Sentence two. Sentence three.",
			20,
		);
		expect(bySentence.length).toBeGreaterThan(1);

		const longSentence = `${"X".repeat(35)}!`;
		const hardSplit = splitLargeParagraph(`short. ${longSentence}`, 10);
		expect(hardSplit.some((part: string) => part.length <= 10)).toBe(true);
		expect(hardSplit.length).toBeGreaterThan(2);
	});

	it("generates deterministic node and edge ids", () => {
		const id1 = GraphExtractor.generateNodeId("Aspirin", "drug");
		const id2 = GraphExtractor.generateNodeId("aspirin", "drug");
		const edge = GraphExtractor.generateEdgeId("source", "target", "treats");

		expect(id1).toBe(id2);
		expect(id1.startsWith("node_")).toBe(true);
		expect(edge).toBe("edge_source_treats_target");
	});
});
