import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema";
import {
	artifacts,
	conversations,
	messages as messageTable,
	retrievalLogs,
} from "../../db/schema";
import type { LlmProvider } from "../../providers/types";
import type { ChatMessage } from "../../types/llm";
import { extractArtifactsFromText } from "../artifacts/extract";
import type { Artifact } from "../artifacts/types";
import {
	evaluateRetrieverCompat,
	type SourceRetriever,
} from "../rag/retriever";
import type { Citation, RetrievedFragment } from "../rag/types";

export type ChatResult = {
	id: string;
	conversationId: string;
	text: string;
	citations: Citation[];
	artifacts: Artifact[];
	retrieved: RetrievedFragment[];
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
};

type ChatServiceDeps = {
	db: NodePgDatabase<typeof schema>;
	retriever: SourceRetriever;
	llmProvider: LlmProvider;
};

type ChatRequest = {
	messages: ChatMessage[];
	conversationId?: string;
	topK?: number;
	category?: string;
};

function toCitations(retrieved: RetrievedFragment[]): Citation[] {
	return retrieved.map((item) => ({
		sourceId: item.sourceId,
		fragmentId: item.id,
		uri: item.sourceUri,
		category: item.sourceCategory,
		title: item.heading ?? item.sourceUri.split("/").at(-1) ?? "Untitled",
		heading: item.heading ?? undefined,
		locator: item.locator,
		score: item.combinedScore,
	}));
}

function buildContext(retrieved: RetrievedFragment[]): string {
	if (retrieved.length === 0) {
		return "(no local markdown context found)";
	}
	return retrieved
		.map(
			(item, index) =>
				`[${index + 1}] uri=${item.sourceUri} locator=${item.locator} heading=${item.heading ?? "(none)"}\n${item.content}`,
		)
		.join("\n\n");
}

function buildSystemPrompt(context: string): string {
	return [
		"You are a helpful assistant.",
		"Use the provided context and cite uncertain points conservatively.",
		'If you generate structured output, use <artifact type="..."> blocks.',
		`Context:\n${context}`,
	].join("\n\n");
}

function conversationTitleFromQuery(query: string): string {
	const trimmed = query.trim();
	if (!trimmed) return "Conversation";
	return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

export class ChatService {
	constructor(private readonly deps: ChatServiceDeps) {}

	private async ensureConversation(
		conversationId: string | undefined,
		query: string,
	): Promise<string> {
		if (conversationId) {
			const existing = await this.deps.db.query.conversations.findFirst({
				where: eq(conversations.id, conversationId),
				columns: { id: true },
			});
			if (existing) return existing.id;
		}
		const [inserted] = await this.deps.db
			.insert(conversations)
			.values({
				title: conversationTitleFromQuery(query),
				metadata: {},
			})
			.returning({ id: conversations.id });
		return inserted.id;
	}

	async run(request: ChatRequest): Promise<ChatResult> {
		const lastUserMessage =
			[...request.messages].reverse().find((message) => message.role === "user")
				?.content ?? "";
		const topK = request.topK ?? 8;
		const category = request.category?.trim() || undefined;
		const evaluation = await evaluateRetrieverCompat(
			this.deps.retriever,
			lastUserMessage,
			{
				topK,
				enableTrigramFallback: true,
				category,
			},
		);
		const retrieved = evaluation.selectedResults;
		const citations = toCitations(retrieved);
		const context = buildContext(retrieved);
		const systemPrompt = buildSystemPrompt(context);

		const llmResponse = await this.deps.llmProvider.chatCompletion([
			{ role: "system", content: systemPrompt },
			...request.messages,
		]);
		const extracted = extractArtifactsFromText(llmResponse.content);

		const conversationId = await this.ensureConversation(
			request.conversationId,
			lastUserMessage,
		);

		let userMessageId: string = randomUUID();
		if (lastUserMessage.trim()) {
			const [userMessage] = await this.deps.db
				.insert(messageTable)
				.values({
					conversationId,
					role: "user",
					content: lastUserMessage,
					metadata: {},
				})
				.returning({ id: messageTable.id });
			userMessageId = userMessage.id;
		}

		const [assistantMessage] = await this.deps.db
			.insert(messageTable)
			.values({
				conversationId,
				role: "assistant",
				content: extracted.cleanText,
				metadata: { citations },
			})
			.returning({ id: messageTable.id });

		if (extracted.artifacts.length > 0) {
			await this.deps.db.insert(artifacts).values(
				extracted.artifacts.map((artifact) => ({
					conversationId,
					messageId: assistantMessage.id,
					type: artifact.type,
					title: artifact.title ?? null,
					content: artifact.content as Record<string, unknown>,
					version: artifact.version,
					metadata: artifact.metadata,
				})),
			);
		}

		await this.deps.db.insert(retrievalLogs).values({
			conversationId,
			messageId: assistantMessage.id,
			query: lastUserMessage,
			fragmentIds: retrieved.map((item) => item.id),
			scores: {
				selected: retrieved.map((item) => ({
					id: item.id,
					combinedScore: item.combinedScore,
					vectorScore: item.vectorScore,
					textScore: item.textScore,
					trigramScore: item.trigramScore,
				})),
				vector: evaluation.vectorResults.map((item) => ({
					id: item.id,
					vectorScore: item.vectorScore,
				})),
				text: evaluation.textResults.map((item) => ({
					id: item.id,
					textScore: item.textScore,
				})),
				merged: evaluation.mergedResults.map((item) => ({
					id: item.id,
					combinedScore: item.combinedScore,
					vectorScore: item.vectorScore,
					textScore: item.textScore,
				})),
			},
			context: {
				userMessageId,
				contextLength: context.length,
				category: category ?? "all",
				retrievalStrategy: evaluation.strategy,
				selectedCount: retrieved.length,
				vectorCount: evaluation.vectorResults.length,
				textCount: evaluation.textResults.length,
				mergedCount: evaluation.mergedResults.length,
			},
		});

		await this.deps.db
			.update(conversations)
			.set({ updatedAt: new Date() })
			.where(eq(conversations.id, conversationId));

		return {
			id: llmResponse.id,
			conversationId,
			text: extracted.cleanText,
			citations,
			artifacts: extracted.artifacts,
			retrieved,
			usage: llmResponse.usage,
		};
	}
}
