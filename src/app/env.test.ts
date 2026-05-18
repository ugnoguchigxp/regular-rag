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
		expect(env.host).toBe(APP_CONFIG_DEFAULTS.host);
		expect(env.trustProxy).toBe(APP_CONFIG_DEFAULTS.trustProxy);
		expect(env.cookieSameSite).toBe(APP_CONFIG_DEFAULTS.cookieSameSite);
		expect(env.jwtSecret).toBe("x".repeat(32));
		expect(env.jwtAccessExpiresIn).toBe(APP_CONFIG_DEFAULTS.jwtAccessExpiresIn);
		expect(env.jwtRefreshExpiresIn).toBe(
			APP_CONFIG_DEFAULTS.jwtRefreshExpiresIn,
		);
	});

	it("supports explicit HTTP runtime mode", () => {
		const env = readAppEnv({
			NODE_ENV: "production",
			APP_URL: "http://products.dev.gxp.jp",
			CORS_ORIGINS: "http://products.dev.gxp.jp,http://localhost:5173",
			AUTH_COOKIE_SECURE: "false",
			SECURITY_HEADERS_MODE: "http",
		});
		expect(env.appUrl).toBe("http://products.dev.gxp.jp");
		expect(env.corsOrigins).toEqual([
			"http://products.dev.gxp.jp",
			"http://localhost:5173",
		]);
		expect(env.secureCookie).toBe(false);
		expect(env.securityHeadersMode).toBe("http");
	});

	it("supports explicit HTTPS runtime mode", () => {
		const env = readAppEnv({
			APP_URL: "https://products.dev.gxp.jp",
			AUTH_COOKIE_SECURE: "true",
			AUTH_COOKIE_SAME_SITE: "lax",
			SECURITY_HEADERS_MODE: "https",
		});
		expect(env.appUrl).toBe("https://products.dev.gxp.jp");
		expect(env.corsOrigins).toContain("https://products.dev.gxp.jp");
		expect(env.secureCookie).toBe(true);
		expect(env.cookieSameSite).toBe("lax");
		expect(env.securityHeadersMode).toBe("https");
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

	it("supports Azure Blob wiki storage settings", () => {
		const env = readAppEnv({
			WIKI_STORAGE_BACKEND: "azure-blob",
			AZURE_STORAGE_CONNECTION_STRING:
				"DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test;EndpointSuffix=core.windows.net",
			WIKI_BLOB_CONTAINER: "regular-rag-wiki",
			WIKI_BLOB_PREFIX: "poc/wiki",
		});
		expect(env.wikiStorageBackend).toBe("azure-blob");
		expect(env.azureStorageConnectionString).toContain("AccountName=test");
		expect(env.wikiBlobContainer).toBe("regular-rag-wiki");
		expect(env.wikiBlobPrefix).toBe("poc/wiki");
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
