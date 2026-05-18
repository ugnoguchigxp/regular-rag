import path from "node:path";
import { z } from "zod";
import { APP_CONFIG_DEFAULTS } from "../config/appDefaults";
import { AGENTIC_SEARCH_DEFAULTS } from "../modules/agentic-search/constants";

const optionalTrimmedString = z.preprocess((value) => {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}, z.string().trim().optional());

const optionalUrl = z.preprocess((value) => {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}, z.string().url().optional());

const EnvSchema = z.object({
	NODE_ENV: z
		.enum(["development", "test", "production"])
		.default(APP_CONFIG_DEFAULTS.nodeEnv),
	EXA_API_KEY: optionalTrimmedString,
	BRAVE_SEARCH_API_KEY: optionalTrimmedString,
	OPENAI_API_KEY: optionalTrimmedString,
	OPENAI_BASE_URL: optionalUrl,
	AZURE_OPENAI_ENDPOINT: optionalUrl,
	AZURE_OPENAI_API_KEY: optionalTrimmedString,
	AZURE_OPENAI_DEPLOYMENT: optionalTrimmedString,
	AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT: optionalTrimmedString,
	JWT_SECRET: z.preprocess((value) => {
		if (typeof value !== "string") return value;
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}, z.string().min(32).optional()),
});

export type AppEnv = {
	nodeEnv: "development" | "test" | "production";
	port: number;
	databaseUrl: string;
	contentRoot: string;
	webSearchProviderMode: "exa" | "brave" | "auto";
	exaApiKey?: string;
	exaSearchBaseUrl: string;
	braveSearchApiKey?: string;
	openAiApiKey?: string;
	openAiCredentialSource: "openai" | "azure" | "none";
	openAiBaseUrl?: string;
	openAiApiVersion?: string;
	openAiAgenticSearchModel: string;
	openAiAgenticSearchDebug: boolean;
	openAiAgenticSearchMaxToolCalls: number;
	openAiAgenticSearchMaxFetchCalls: number;
	openAiAgenticSearchMaxContextChars: number;
	azureOpenAiEndpoint?: string;
	azureOpenAiApiKey?: string;
	azureOpenAiDeployment: string;
	azureOpenAiEmbeddingsDeployment: string;
	azureOpenAiApiVersion: string;
	jwtSecret: string;
	jwtAccessExpiresIn: string;
	jwtRefreshExpiresIn: string;
	appUrl: string;
	corsOrigins: string[];
	trustProxy: boolean;
	secureCookie: boolean;
	cookieSameSite: "lax" | "strict" | "none";
};

function normalizeOpenAiBaseUrl(baseUrl?: string): string | undefined {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return undefined;
	const url = new URL(trimmed);
	const host = url.hostname.toLowerCase();
	const pathname = url.pathname.replace(/\/+$/, "");
	const isAzure = /(?:^|\.)azure\.com$/i.test(host);
	const isOpenAiPublic = host === "api.openai.com";

	if (/\/openai\/deployments\/[^/]+/i.test(pathname)) {
		return `${url.origin}/openai/v1`;
	}

	if (isAzure) {
		if (!pathname || pathname === "/" || /^\/openai$/i.test(pathname)) {
			return `${url.origin}/openai/v1`;
		}
		if (/^\/openai\/v1$/i.test(pathname)) {
			return `${url.origin}/openai/v1`;
		}
		return `${url.origin}${pathname}`;
	}

	if (isOpenAiPublic) {
		if (!pathname || pathname === "/") {
			return `${url.origin}/v1`;
		}
		if (/^\/v1$/i.test(pathname)) {
			return `${url.origin}/v1`;
		}
		return `${url.origin}${pathname}`;
	}

	if (!pathname || pathname === "/") {
		return url.origin;
	}

	return `${url.origin}${pathname}`;
}

function toAzureCompatibleBaseUrl(endpoint?: string): string | undefined {
	const normalized = normalizeOpenAiBaseUrl(endpoint);
	if (!normalized) return undefined;
	if (/\/openai\/v1$/i.test(normalized)) {
		return normalized;
	}
	const url = new URL(normalized);
	return `${url.origin}/openai/v1`;
}

export function readAppEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
	const parsed = EnvSchema.parse(env);
	const appUrl = APP_CONFIG_DEFAULTS.appUrl;
	const cookieSameSite =
		APP_CONFIG_DEFAULTS.cookieSameSite as AppEnv["cookieSameSite"];
	const secureCookie =
		parsed.NODE_ENV === "production" ||
		Boolean(appUrl?.toLowerCase().startsWith("https://"));
	if (cookieSameSite === "none" && !secureCookie) {
		throw new Error(
			"cookieSameSite=none requires secure cookies. Use HTTPS appUrl or NODE_ENV=production.",
		);
	}

	const openAiCredentialSource = parsed.OPENAI_API_KEY
		? "openai"
		: parsed.AZURE_OPENAI_API_KEY
			? "azure"
			: "none";
	const openAiApiKey = parsed.OPENAI_API_KEY || parsed.AZURE_OPENAI_API_KEY;
	const configuredOpenAiBaseUrl = normalizeOpenAiBaseUrl(
		parsed.OPENAI_BASE_URL,
	);
	const azureCompatibleBaseUrl = toAzureCompatibleBaseUrl(
		parsed.AZURE_OPENAI_ENDPOINT,
	);
	const openAiBaseUrl = parsed.OPENAI_API_KEY
		? configuredOpenAiBaseUrl
		: (azureCompatibleBaseUrl ?? configuredOpenAiBaseUrl);
	const openAiApiVersion = APP_CONFIG_DEFAULTS.openAiApiVersion;
	const openAiAgenticSearchModel =
		parsed.AZURE_OPENAI_DEPLOYMENT || AGENTIC_SEARCH_DEFAULTS.model;
	const azureOpenAiDeployment = openAiAgenticSearchModel;

	return {
		nodeEnv: parsed.NODE_ENV,
		port: APP_CONFIG_DEFAULTS.port,
		databaseUrl: APP_CONFIG_DEFAULTS.databaseUrl,
		contentRoot: path.resolve(process.cwd(), APP_CONFIG_DEFAULTS.contentRoot),
		webSearchProviderMode: APP_CONFIG_DEFAULTS.webSearchProviderMode,
		exaApiKey: parsed.EXA_API_KEY,
		exaSearchBaseUrl: APP_CONFIG_DEFAULTS.exaSearchBaseUrl.replace(/\/+$/, ""),
		braveSearchApiKey: parsed.BRAVE_SEARCH_API_KEY,
		openAiApiKey,
		openAiCredentialSource,
		openAiBaseUrl,
		openAiApiVersion,
		openAiAgenticSearchModel,
		openAiAgenticSearchDebug: AGENTIC_SEARCH_DEFAULTS.debug,
		openAiAgenticSearchMaxToolCalls: AGENTIC_SEARCH_DEFAULTS.maxToolCalls,
		openAiAgenticSearchMaxFetchCalls: AGENTIC_SEARCH_DEFAULTS.maxFetchCalls,
		openAiAgenticSearchMaxContextChars: AGENTIC_SEARCH_DEFAULTS.maxContextChars,
		azureOpenAiEndpoint: parsed.AZURE_OPENAI_ENDPOINT,
		azureOpenAiApiKey: parsed.AZURE_OPENAI_API_KEY,
		azureOpenAiDeployment,
		azureOpenAiEmbeddingsDeployment:
			parsed.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT ||
			APP_CONFIG_DEFAULTS.azureOpenAiEmbeddingsDeployment,
		azureOpenAiApiVersion: APP_CONFIG_DEFAULTS.azureOpenAiApiVersion,
		jwtSecret: parsed.JWT_SECRET ?? APP_CONFIG_DEFAULTS.jwtSecret,
		jwtAccessExpiresIn: APP_CONFIG_DEFAULTS.jwtAccessExpiresIn,
		jwtRefreshExpiresIn: APP_CONFIG_DEFAULTS.jwtRefreshExpiresIn,
		appUrl,
		corsOrigins: [...APP_CONFIG_DEFAULTS.corsOrigins],
		trustProxy: APP_CONFIG_DEFAULTS.trustProxy,
		secureCookie,
		cookieSameSite,
	};
}
