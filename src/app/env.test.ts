import { describe, expect, it } from "vitest";
import { readAppEnv } from "./env";

describe("readAppEnv", () => {
	it("normalizes OpenAI public base URL", () => {
		const env = readAppEnv({
			OPENAI_API_KEY: "test-key",
			OPENAI_BASE_URL: "https://api.openai.com",
		});
		expect(env.openAiCredentialSource).toBe("openai");
		expect(env.openAiBaseUrl).toBe("https://api.openai.com/v1");
	});

	it("normalizes Azure deployment-style endpoint to /openai/v1", () => {
		const env = readAppEnv({
			AZURE_OPENAI_API_KEY: "test-key",
			AZURE_OPENAI_ENDPOINT:
				"https://example.openai.azure.com/openai/deployments/my-deploy",
			AZURE_OPENAI_DEPLOYMENT: "my-deploy",
		});
		expect(env.openAiCredentialSource).toBe("azure");
		expect(env.openAiBaseUrl).toBe("https://example.openai.azure.com/openai/v1");
		expect(env.openAiAgenticSearchModel).toBe("my-deploy");
	});

	it("parses API version and uses agentic search constants", () => {
		const env = readAppEnv({
			OPENAI_API_KEY: "test-key",
			OPENAI_BASE_URL: "https://api.openai.com/v1",
			AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
			OPENAI_AGENTIC_SEARCH_DEBUG: "true",
			OPENAI_AGENTIC_SEARCH_MAX_TOOL_CALLS: "99",
		});
		expect(env.openAiApiVersion).toBeUndefined();
		expect(env.openAiAgenticSearchModel).toBe("gpt-5-4-mini");
		expect(env.openAiAgenticSearchDebug).toBe(false);
		expect(env.openAiAgenticSearchMaxToolCalls).toBe(10);
		expect(env.openAiAgenticSearchMaxFetchCalls).toBe(3);
		expect(env.openAiAgenticSearchMaxContextChars).toBe(50000);
	});

	it("parses Exa web search configuration", () => {
		const env = readAppEnv({
			WEB_SEARCH_PROVIDER: "exa",
			EXA_API_KEY: " test-exa-key ",
			EXA_SEARCH_BASE_URL: "https://api.exa.ai/",
			BRAVE_SEARCH_API_KEY: " ",
		});
		expect(env.webSearchProviderMode).toBe("exa");
		expect(env.exaApiKey).toBe("test-exa-key");
		expect(env.exaSearchBaseUrl).toBe("https://api.exa.ai");
		expect(env.braveSearchApiKey).toBeUndefined();
	});

	it("parses CORS origin allow-list and trust proxy", () => {
		const env = readAppEnv({
			CORS_ORIGIN: "http://localhost:5173, https://app.example.com ",
			TRUST_PROXY: "true",
		});
		expect(env.corsOrigins).toEqual([
			"http://localhost:5173",
			"https://app.example.com",
		]);
		expect(env.trustProxy).toBe(true);
	});

	it("rejects wildcard CORS origin", () => {
		expect(() => readAppEnv({ CORS_ORIGIN: "*" })).toThrow(
			"Invalid CORS_ORIGIN",
		);
	});

	it("rejects SameSite none without secure cookie condition", () => {
		expect(() =>
			readAppEnv({
				COOKIE_SAME_SITE: "none",
				NODE_ENV: "development",
				APP_URL: "http://localhost:5173",
			}),
		).toThrow("COOKIE_SAME_SITE=none requires secure cookies");
	});

	it("allows SameSite none with HTTPS APP_URL", () => {
		const env = readAppEnv({
			COOKIE_SAME_SITE: "none",
			APP_URL: "https://app.example.com",
		});
		expect(env.secureCookie).toBe(true);
		expect(env.cookieSameSite).toBe("none");
	});
});
