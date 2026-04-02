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
import type { WebSearchService } from "./WebSearchService";

const CACHE_VERSION = "v3";

export class ChatbotService {
	constructor(
		private ragRepo: RagRepository,
		private cacheRepo: CacheRepository,
		private knowledgeGraphService: KnowledgeGraphService,
		private llmProvider: LlmProvider,
		private embeddingProvider: EmbeddingProvider,
		private webSearchService?: WebSearchService,
	) {}

	private async runWebSearch(query: string, maxResults = 5): Promise<
		Array<{ title: string; url: string; snippet: string; content?: string }>
	> {
		if (!this.webSearchService) {
			return [];
		}

		const searchResults = await this.webSearchService.search({
			query,
			maxResults,
		});

		return await Promise.all(
			searchResults.map(async (res, idx) => {
				if (idx >= 3) {
					return { ...res };
				}
				try {
					const pageContent = await this.webSearchService?.fetchPageContent(
						res.url,
					);
					return { ...res, content: pageContent?.cleanText };
				} catch {
					return { ...res };
				}
			}),
		);
	}

	private buildWebContext(
		webResults: Array<{ title: string; url: string; snippet: string; content?: string }>,
	): string {
		if (webResults.length === 0) {
			return "";
		}

		return webResults
			.map(
				(result) =>
					`[Web] ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}\nContent: ${
						result.content ?? "(content unavailable)"
					}`,
			)
			.join("\n\n");
	}

	private async analyzeRequest(
		userMessage: string,
		context: Record<string, string>,
	): Promise<SearchPlan> {
		const analyzerContext = this.stableStringify({
			screen: context.screen ?? null,
			locale: context.locale ?? null,
			domain: context.domain ?? null,
			raw: context,
		});
		const systemPrompt =
			"You are an intent analyzer for a RAG chatbot. Output ONLY one valid JSON object.\n" +
			"Required keys:\n" +
			"- should_search (boolean)\n" +
			"- search_query (string)\n" +
			"- force_web_search (boolean)\n" +
			"Optional keys:\n" +
			"- top_k (number 1-8)\n" +
			'- knowledge_source ("system" | "dialysis" | "medical")\n' +
			"- identified_entities (string[])\n" +
			"- navigation_intent (object: target_route_key, patient_name)\n" +
			"Hard rules:\n" +
			"1) If user explicitly asks to search web/internet/online (examples: Web検索, Webで検索, Webから探して, ネットで調べて, search the web, look up online), set force_web_search=true.\n" +
			"2) If force_web_search=true, set should_search=true.\n" +
			"3) search_query must be a concise query string without imperative phrases like '教えて' or 'してください'.\n" +
			"4) Build search_query using both the user's message and APP_CONTEXT. Prefer terms that improve search precision in the current screen/domain.\n" +
			"5) Keep search_query in the same language as the user unless APP_CONTEXT strongly suggests otherwise.\n" +
			"6) If explicit web request is not present, set force_web_search=false.\n" +
			"Return JSON only.";

		const response = await this.llmProvider.chatCompletion(
			[
				{ role: "system", content: systemPrompt },
				{
					role: "user",
					content: `USER_MESSAGE:\n${userMessage}\n\nAPP_CONTEXT:\n${analyzerContext}`,
				},
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
		const searchPlan = await this.analyzeRequest(lastUserMessage, context);
		const effectiveSearchPlan: SearchPlan = normalizeSearchPlan(searchPlan);
		const topK = effectiveSearchPlan.top_k ?? 5;
		const forceWebSearch = effectiveSearchPlan.force_web_search ?? false;
		const normalizedSearchQuery =
			effectiveSearchPlan.search_query.trim() || lastUserMessage.trim();

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
		let webResults: Array<{
			title: string;
			url: string;
			snippet: string;
			content?: string;
		}> = [];
		let localSearchMissed = false;
		let webSearchUnavailable = false;

		if (forceWebSearch) {
			if (this.webSearchService) {
				webResults = await this.runWebSearch(normalizedSearchQuery, topK);
				ragContext = this.buildWebContext(webResults);
			} else {
				webSearchUnavailable = true;
			}
		} else if (effectiveSearchPlan.should_search) {
			const embedding = await this.embeddingProvider.createEmbedding(
				normalizedSearchQuery,
			);
			const results = await this.ragRepo.hybridSearch(
				normalizedSearchQuery,
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

			if (results.length === 0) {
				localSearchMissed = true;
				if (this.webSearchService) {
					webResults = await this.runWebSearch(
						normalizedSearchQuery,
						topK,
					);
					const webContext = this.buildWebContext(webResults);
					if (webContext) {
						ragContext = webContext;
					}
				} else {
					webSearchUnavailable = true;
				}
			}
		}

		// Knowledge Graph Enhancement
		if (
			effectiveSearchPlan.identified_entities &&
			effectiveSearchPlan.identified_entities.length > 0
		) {
			const graphContext =
				await this.knowledgeGraphService.getContextForEntities(
					effectiveSearchPlan.identified_entities,
				);
			if (graphContext) {
				ragContext += `\n\n${graphContext}`;
			}
		}

		// 最終回答生成
		const fallbackNotice = localSearchMissed
			? "ローカルデータでは該当情報が見つからなかったため、Web検索結果をもとに回答してください。"
			: "";
		const unavailableNotice = webSearchUnavailable
			? "Web検索が必要ですが、この環境ではWebSearchProviderが未設定です。その旨を先に伝えたうえで、与えられた情報の範囲で回答してください。"
			: "";
		const forceWebNotice = forceWebSearch
			? "ユーザーがWeb検索を明示的に要求しています。ローカルRAGではなくWeb検索結果を優先して回答してください。"
			: "";
		const systemPrompt = `You are a helpful assistant. Use the following context to answer.\n${forceWebNotice}\n${fallbackNotice}\n${unavailableNotice}\n${ragContext}`;
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
			web:
				webResults.length > 0
					? {
							results: webResults,
					  }
					: undefined,
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
