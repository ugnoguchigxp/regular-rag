import { describe, expect, it } from "vitest";
import { APP_CONFIG_DEFAULTS } from "../config/appDefaults";
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
			OPENAI_BASE_URL: "https://api.openai.com/v1",
		});
		expect(env.openAiCredentialSource).toBe("azure");
		expect(env.openAiBaseUrl).toBe("https://example.openai.azure.com/openai/v1");
		expect(env.openAiAgenticSearchModel).toBe("my-deploy");
		expect(env.azureOpenAiDeployment).toBe("my-deploy");
	});

	it("ignores removed agentic-search env overrides and uses constants", () => {
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

	it("parses API secrets and keeps non-secret settings in shared defaults", () => {
		const env = readAppEnv({
			EXA_API_KEY: " test-exa-key ",
			BRAVE_SEARCH_API_KEY: " test-brave-key ",
			JWT_SECRET: "x".repeat(32),
			DATABASE_URL: "postgres://ignored",
			REGULAR_RAG_CONTENT_ROOT: "../ignored",
			WEB_SEARCH_PROVIDER: "brave",
			EXA_SEARCH_BASE_URL: "https://ignored.example.com",
			CORS_ORIGIN: "https://ignored.example.com",
			TRUST_PROXY: "true",
			COOKIE_SAME_SITE: "none",
			JWT_ACCESS_EXPIRES_IN: "1m",
			JWT_REFRESH_EXPIRES_IN: "1d",
		});
		expect(env.databaseUrl).toBe(APP_CONFIG_DEFAULTS.databaseUrl);
		expect(env.contentRoot.endsWith("wiki-knowledge")).toBe(true);
		expect(env.webSearchProviderMode).toBe(
			APP_CONFIG_DEFAULTS.webSearchProviderMode,
		);
		expect(env.exaApiKey).toBe("test-exa-key");
		expect(env.exaSearchBaseUrl).toBe(APP_CONFIG_DEFAULTS.exaSearchBaseUrl);
		expect(env.braveSearchApiKey).toBe("test-brave-key");
		expect(env.corsOrigins).toEqual(APP_CONFIG_DEFAULTS.corsOrigins);
		expect(env.trustProxy).toBe(false);
		expect(env.cookieSameSite).toBe(APP_CONFIG_DEFAULTS.cookieSameSite);
		expect(env.jwtSecret).toBe("x".repeat(32));
		expect(env.jwtAccessExpiresIn).toBe(APP_CONFIG_DEFAULTS.jwtAccessExpiresIn);
		expect(env.jwtRefreshExpiresIn).toBe(
			APP_CONFIG_DEFAULTS.jwtRefreshExpiresIn,
		);
	});

	it("uses common Azure defaults when optional model settings are omitted", () => {
		const env = readAppEnv({
			AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
			AZURE_OPENAI_API_KEY: "test-key",
		});
		expect(env.azureOpenAiDeployment).toBe("gpt-5-4-mini");
		expect(env.azureOpenAiEmbeddingsDeployment).toBe(
			APP_CONFIG_DEFAULTS.azureOpenAiEmbeddingsDeployment,
		);
		expect(env.azureOpenAiApiVersion).toBe(
			APP_CONFIG_DEFAULTS.azureOpenAiApiVersion,
		);
	});

	it("ignores empty optional secret placeholders", () => {
		const env = readAppEnv({
			EXA_API_KEY: "",
			BRAVE_SEARCH_API_KEY: " ",
			OPENAI_BASE_URL: "",
		});
		expect(env.exaApiKey).toBeUndefined();
		expect(env.braveSearchApiKey).toBeUndefined();
		expect(env.openAiBaseUrl).toBeUndefined();
	});
});
