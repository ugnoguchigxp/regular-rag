import { createHash } from "node:crypto";

import { z } from "zod";

import type { LlmProvider } from "../providers/types";
import type { ChatMessage } from "../types/llm";

const ExtractionResultSchema = z.object({
	entities: z.array(
		z.object({
			name: z.string(),
			type: z.string(),
			properties: z.record(z.string(), z.unknown()).optional(),
		}),
	),
	relations: z.array(
		z.object({
			source: z.string(),
			target: z.string(),
			relationType: z.string(),
			weight: z.number().optional(),
		}),
	),
});

// ─── Types ───────────────────────────────────────────────────────────

export interface ExtractedEntity {
	name: string;
	type: string; // 'concept', 'person', 'drug', 'disease', 'organization', etc.
	properties?: Record<string, unknown>;
}

export interface ExtractedRelation {
	source: string; // entity name
	target: string; // entity name
	relationType: string; // 'is_a', 'causes', 'treats', 'part_of', 'related_to', etc.
	weight?: number;
}

export interface ExtractionResult {
	entities: ExtractedEntity[];
	relations: ExtractedRelation[];
}

// ─── Extractor ───────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a knowledge graph extraction engine.
Given the text below, extract all entities and relationships.

Output ONLY valid JSON in this exact format:
{
  "entities": [
    { "name": "Entity Name", "type": "concept|person|drug|disease|organization|event|location|other", "properties": {} }
  ],
  "relations": [
    { "source": "Entity A", "target": "Entity B", "relationType": "is_a|causes|treats|part_of|related_to|contains|influences|precedes|follows", "weight": 1.0 }
  ]
}

Rules:
- Extract ALL meaningful entities (nouns, concepts, people, organizations, etc.)
- Extract ALL relationships between entities
- Use consistent entity names (normalize casing)
- relationType should describe the relationship FROM source TO target
- weight: 0.0-1.0 indicating confidence/strength of the relationship
- Output ONLY the JSON, no markdown or explanation`;

/**
 * LLM を使ってテキストからエンティティと関係を自動抽出する
 */
export class GraphExtractor {
	constructor(private llmProvider: LlmProvider) {}

	/**
	 * テキストからエンティティ・関係を抽出する
	 */
	async extract(content: string): Promise<ExtractionResult> {
		// 長いテキストはチャンクに分割して処理
		const chunks = this.splitIntoChunks(content, 3000);
		const allEntities: ExtractedEntity[] = [];
		const allRelations: ExtractedRelation[] = [];

		for (const chunk of chunks) {
			const result = await this.extractFromChunk(chunk);
			allEntities.push(...result.entities);
			allRelations.push(...result.relations);
		}

		// エンティティの重複排除（名前+タイプで一意化）
		const entityMap = new Map<string, ExtractedEntity>();
		for (const entity of allEntities) {
			const key = `${entity.name.toLowerCase()}::${entity.type}`;
			if (!entityMap.has(key)) {
				entityMap.set(key, entity);
			} else {
				// properties をマージ
				const existing = entityMap.get(key);
				if (existing) {
					existing.properties = {
						...existing.properties,
						...entity.properties,
					};
				}
			}
		}

		// 関係の重複排除
		const relationSet = new Set<string>();
		const uniqueRelations = allRelations.filter((r) => {
			const key = `${r.source.toLowerCase()}::${r.target.toLowerCase()}::${r.relationType}`;
			if (relationSet.has(key)) return false;
			relationSet.add(key);
			return true;
		});

		return {
			entities: Array.from(entityMap.values()),
			relations: uniqueRelations,
		};
	}

	private async extractFromChunk(chunk: string): Promise<ExtractionResult> {
		const messages: ChatMessage[] = [
			{ role: "system", content: EXTRACTION_PROMPT },
			{ role: "user", content: chunk },
		];

		const response = await this.llmProvider.chatCompletion(messages, {
			temperature: 0,
		});

		try {
			const match = response.content.match(/\{[\s\S]*\}/);
			if (!match) return { entities: [], relations: [] };
			const parsed = JSON.parse(match[0]);
			const validated = ExtractionResultSchema.safeParse(parsed);

			if (validated.success) {
				return validated.data;
			}
			return { entities: [], relations: [] };
		} catch {
			return { entities: [], relations: [] };
		}
	}

	private splitIntoChunks(text: string, chunkSize: number): string[] {
		if (text.length <= chunkSize) return [text];

		const chunks: string[] = [];
		const paragraphs = text.split(/\n\n+/);
		let current = "";

		for (const para of paragraphs) {
			if (para.length > chunkSize) {
				if (current.length > 0) {
					chunks.push(current);
					current = "";
				}
				chunks.push(...this.splitLargeParagraph(para, chunkSize));
				continue;
			}
			if (current.length + para.length + 2 > chunkSize && current.length > 0) {
				chunks.push(current);
				current = para;
			} else {
				current = current ? `${current}\n\n${para}` : para;
			}
		}
		if (current) chunks.push(current);
		return chunks;
	}

	private splitLargeParagraph(paragraph: string, chunkSize: number): string[] {
		const parts: string[] = [];
		let current = "";
		const sentences = paragraph.split(/(?<=[.!?。！？])\s+/);

		for (const sentence of sentences) {
			if (sentence.length > chunkSize) {
				if (current.length > 0) {
					parts.push(current);
					current = "";
				}
				for (let i = 0; i < sentence.length; i += chunkSize) {
					parts.push(sentence.slice(i, i + chunkSize));
				}
				continue;
			}

			if (
				current.length + sentence.length + 1 > chunkSize &&
				current.length > 0
			) {
				parts.push(current);
				current = sentence;
			} else {
				current = current ? `${current} ${sentence}` : sentence;
			}
		}

		if (current.length > 0) {
			parts.push(current);
		}

		return parts;
	}

	/**
	 * エンティティ名から一意のノードIDを生成する
	 */
	static generateNodeId(name: string, type: string): string {
		const hash = createHash("sha256")
			.update(`${name.toLowerCase()}::${type}`)
			.digest("hex")
			.slice(0, 16);
		return `node_${hash}`;
	}

	/**
	 * エッジIDを生成する
	 */
	static generateEdgeId(
		sourceId: string,
		targetId: string,
		relationType: string,
	): string {
		return `edge_${sourceId}_${relationType}_${targetId}`;
	}
}
