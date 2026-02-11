import { createHash } from "node:crypto";

import type { RagResponse } from "../core/RagEngine";
import type { EmbeddingProvider, LlmProvider } from "../providers/types";
import type { CacheRepository } from "../repositories/CacheRepository";
import type { RagRepository } from "../repositories/RagRepository";
import {
	type ChatMessage,
	normalizeSearchPlan,
	type SearchPlan,
	SearchPlanSchema,
} from "../types/llm";

import type { KnowledgeGraphService } from "./KnowledgeGraphService";

const CACHE_VERSION = "v2";

export class ChatbotService {
	constructor(
		private ragRepo: RagRepository,
		private cacheRepo: CacheRepository,
		private knowledgeGraphService: KnowledgeGraphService,
		private llmProvider: LlmProvider,
		private embeddingProvider: EmbeddingProvider,
	) {}

	private async analyzeRequest(userMessage: string): Promise<SearchPlan> {
		const systemPrompt =
			"You are an intent analyzer for a RAG chatbot. Analyze the request and output JSON:\n" +
			"- should_search (boolean)\n" +
			"- search_query (string)\n" +
			"- top_k (number 1-8)\n" +
			'- knowledge_source ("system" | "dialysis" | "medical")\n' +
			"- identified_entities (string[], optional): Names of drugs, diseases, or patients mentioned.\n" +
			"- navigation_intent (object, optional): target_route_key, patient_name.\n";

		const response = await this.llmProvider.chatCompletion(
			[
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userMessage },
			],
			{ temperature: 0 },
		);

		try {
			const match = response.content.match(/\{[\s\S]*\}/);
			if (!match) return { should_search: true, search_query: userMessage };
			const parsed = JSON.parse(match[0]);
			const validated = SearchPlanSchema.safeParse(parsed);

			if (validated.success) {
				return validated.data as SearchPlan;
			}
			return { should_search: true, search_query: userMessage };
		} catch {
			return { should_search: true, search_query: userMessage };
		}
	}

	async processRagRequest(
		messages: ChatMessage[],
		context: Record<string, string> = {},
	): Promise<RagResponse> {
		const lastUserMessage =
			[...messages].reverse().find((m) => m.role === "user")?.content ?? "";
		const searchPlan = await this.analyzeRequest(lastUserMessage);
		const effectiveSearchPlan: SearchPlan = normalizeSearchPlan(searchPlan);
		const topK = effectiveSearchPlan.top_k ?? 5;

		// キャッシュチェック
		const cacheKey = createHash("sha256")
			.update(
				this.stableStringify({
					cacheVersion: CACHE_VERSION,
					messages,
					context,
					plan: effectiveSearchPlan,
				}),
			)
			.digest("hex");
		const cached = await this.cacheRepo.findByHash(cacheKey);
		if (cached) {
			await this.cacheRepo.incrementHitCount(cacheKey);
			return {
				id: "cached",
				content: cached.response,
			};
		}

		// RAG 検索
		let ragContext = "";
		let ragResults: Array<{
			path: string;
			content: string;
			combinedScore: number;
		}> = [];

		if (searchPlan.should_search) {
			const embedding = await this.embeddingProvider.createEmbedding(
				searchPlan.search_query,
			);
			const results = await this.ragRepo.hybridSearch(
				searchPlan.search_query,
				embedding,
				topK,
				context.screen,
			);
			ragResults = results.map((r) => ({
				path: r.path,
				content: r.content,
				combinedScore: r.combinedScore,
			}));
			ragContext = results.map((r) => r.content).join("\n\n");
		}

		// Knowledge Graph Enhancement
		if (
			searchPlan.identified_entities &&
			searchPlan.identified_entities.length > 0
		) {
			const graphContext =
				await this.knowledgeGraphService.getContextForEntities(
					searchPlan.identified_entities,
				);
			if (graphContext) {
				ragContext += `\n\n${graphContext}`;
			}
		}

		// 最終回答生成
		const systemPrompt = `You are a helpful assistant. Use the following context to answer:\n${ragContext}`;
		const finalResponse = await this.llmProvider.chatCompletion([
			{ role: "system", content: systemPrompt },
			...messages,
		]);

		// キャッシュ保存
		await this.cacheRepo.save(
			cacheKey,
			lastUserMessage,
			context,
			finalResponse.content,
		);

		return {
			...finalResponse,
			rag: { results: ragResults, plan: effectiveSearchPlan },
		};
	}

	private stableStringify(obj: unknown): string {
		return JSON.stringify(obj, (_, v) =>
			v instanceof Object && !Array.isArray(v)
				? Object.keys(v)
						.sort()
						.reduce((r, k) => {
							(r as Record<string, unknown>)[k] = v[k as keyof typeof v];
							return r;
						}, {})
				: v,
		);
	}
}
