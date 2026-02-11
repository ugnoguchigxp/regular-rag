import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AzureOpenAiProvider } from "./AzureOpenAiProvider";

describe("AzureOpenAiProvider", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("fromEnv validates required variables", () => {
		expect(() => AzureOpenAiProvider.fromEnv({})).toThrowError(
			"AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT are required",
		);

		const provider = AzureOpenAiProvider.fromEnv({
			AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/",
			AZURE_OPENAI_API_KEY: "key",
			AZURE_OPENAI_DEPLOYMENT: "gpt-4o",
		});

		expect(provider).toBeInstanceOf(AzureOpenAiProvider);
	});

	it("chatCompletion posts mapped payload and parses response", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					id: "chat-1",
					choices: [{ message: { role: "assistant", content: "hello" } }],
					usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const provider = new AzureOpenAiProvider({
			endpoint: "https://example.openai.azure.com/",
			apiKey: "key",
			deployment: "gpt-4o",
			apiVersion: "2024-06-01",
		});

		const response = await provider.chatCompletion(
			[{ role: "user", content: "hi" }],
			{ temperature: 0.2, maxTokens: 300 },
		);

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			"https://example.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-06-01",
		);
		expect(JSON.parse(init.body as string)).toEqual({
			messages: [{ role: "user", content: "hi" }],
			temperature: 0.2,
			max_tokens: 300,
		});
		expect(response).toEqual({
			id: "chat-1",
			content: "hello",
			usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
		});
	});

	it("chatCompletion throws with API error body on non-ok response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })),
		);

		const provider = new AzureOpenAiProvider({
			endpoint: "https://example.openai.azure.com",
			apiKey: "key",
			deployment: "gpt-4o",
		});

		await expect(
			provider.chatCompletion([{ role: "user", content: "hi" }]),
		).rejects.toThrowError("Azure OpenAI error (400): bad request");
	});

	it("createEmbedding returns embedding and throws when response is malformed", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: [] }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const provider = new AzureOpenAiProvider({
			endpoint: "https://example.openai.azure.com",
			apiKey: "key",
			deployment: "gpt-4o",
			embeddingsDeployment: "text-embedding",
		});

		await expect(provider.createEmbedding("hello")).resolves.toEqual([
			0.1, 0.2, 0.3,
		]);
		await expect(provider.createEmbedding("hello")).rejects.toThrowError(
			"Embedding response missing data.",
		);
	});

	it("retries transient errors in fetchWithRetry", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("server error", { status: 500 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						id: "chat-2",
						choices: [{ message: { role: "assistant", content: "ok" } }],
					}),
					{ status: 200 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		const provider = new AzureOpenAiProvider({
			endpoint: "https://example.openai.azure.com",
			apiKey: "key",
			deployment: "gpt-4o",
		});
		vi.spyOn(provider as any, "sleep").mockResolvedValue(undefined);

		const result = await provider.chatCompletion([
			{ role: "user", content: "retry me" },
		]);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.content).toBe("ok");
	});
});
