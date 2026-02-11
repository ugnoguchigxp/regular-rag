import type { ChatMessage } from "../types/llm";

/**
 * LLM Chat Completion プロバイダーインターフェース
 * Azure OpenAI, OpenAI, Ollama 等の実装を差し替え可能
 */
export interface LlmProvider {
	chatCompletion(
		messages: ChatMessage[],
		options?: LlmCompletionOptions,
	): Promise<LlmResponse>;
}

export interface LlmCompletionOptions {
	temperature?: number;
	maxTokens?: number;
}

export interface LlmResponse {
	id: string;
	content: string;
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
}

/**
 * Embedding プロバイダーインターフェース
 */
export interface EmbeddingProvider {
	createEmbedding(input: string): Promise<number[]>;
}
