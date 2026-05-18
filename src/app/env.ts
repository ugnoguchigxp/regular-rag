import path from "node:path";
import { z } from "zod";
import { AGENTIC_SEARCH_DEFAULTS } from "../modules/agentic-search/constants";

const EnvSchema = z.object({
	NODE_ENV: z
		.enum(["development", "test", "production"])
		.default("development"),
	PORT: z.coerce.number().int().positive().default(5173),
	DATABASE_URL: z
		.string()
		.min(1)
		.default("postgres://postgres:postgres@localhost:5432/regular_rag"),
	REGULAR_RAG_CONTENT_ROOT: z.string().default("./wiki-knowledge"),
	WEB_SEARCH_PROVIDER: z.enum(["exa", "brave", "auto"]).default("exa"),
	EXA_API_KEY: z.string().optional(),
	EXA_SEARCH_BASE_URL: z.string().url().default("https://api.exa.ai"),
	BRAVE_SEARCH_API_KEY: z.string().optional(),
	OPENAI_API_KEY: z.string().optional(),
	OPENAI_BASE_URL: z.string().url().optional(),
	OPENAI_API_VERSION: z.string().trim().min(1).optional(),
	AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
	AZURE_OPENAI_API_KEY: z.string().optional(),
	AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
	AZURE_OPENAI_API_VERSION: z.string().trim().min(1).optional(),
	JWT_SECRET: z
		.string()
		.min(32)
		.default("regular-rag-dev-jwt-secret-change-this-for-production"),
	JWT_ACCESS_EXPIRES_IN: z.string().trim().min(1).default("15m"),
	JWT_REFRESH_EXPIRES_IN: z.string().trim().min(1).default("7d"),
	COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
	APP_URL: z.string().url().optional(),
	CORS_ORIGIN: z.string().default("http://localhost:5173"),
	TRUST_PROXY: z
		.enum(["true", "false"])
		.default("false")
		.transform((value) => value === "true"),
	REGULAR_RAG_BOOTSTRAP_ADMIN_EMAIL: z.string().trim().email().optional(),
	REGULAR_RAG_BOOTSTRAP_ADMIN_PASSWORD: z.string().trim().min(8).optional(),
	REGULAR_RAG_BOOTSTRAP_ADMIN_NAME: z.string().trim().min(1).optional(),
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
	jwtSecret: string;
	jwtAccessExpiresIn: string;
	jwtRefreshExpiresIn: string;
	appUrl?: string;
	corsOrigins: string[];
	trustProxy: boolean;
	secureCookie: boolean;
	cookieSameSite: "lax" | "strict" | "none";
	bootstrapAdminEmail?: string;
	bootstrapAdminPassword?: string;
	bootstrapAdminName?: string;
};

function optionalTrimmed(input?: string): string | undefined {
	const trimmed = input?.trim();
	return trimmed ? trimmed : undefined;
}

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
	const corsOrigins = parsed.CORS_ORIGIN.split(",")
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);
	if (corsOrigins.length === 0 || corsOrigins.includes("*")) {
		throw new Error(
			"Invalid CORS_ORIGIN: wildcard (*) is not allowed. Use explicit origins.",
		);
	}
	const appUrl = optionalTrimmed(parsed.APP_URL);
	const secureCookie =
		parsed.NODE_ENV === "production" ||
		Boolean(appUrl?.toLowerCase().startsWith("https://"));
	if (parsed.COOKIE_SAME_SITE === "none" && !secureCookie) {
		throw new Error(
			"COOKIE_SAME_SITE=none requires secure cookies. Use HTTPS APP_URL or NODE_ENV=production.",
		);
	}

	const openAiCredentialSource = parsed.OPENAI_API_KEY?.trim()
		? "openai"
		: parsed.AZURE_OPENAI_API_KEY?.trim()
			? "azure"
			: "none";
	const openAiApiKey =
		parsed.OPENAI_API_KEY?.trim() || parsed.AZURE_OPENAI_API_KEY?.trim();
	const openAiBaseUrl =
		normalizeOpenAiBaseUrl(parsed.OPENAI_BASE_URL) ??
		toAzureCompatibleBaseUrl(parsed.AZURE_OPENAI_ENDPOINT);
	const openAiApiVersion = parsed.OPENAI_API_VERSION?.trim() || undefined;
	const openAiAgenticSearchModel =
		parsed.AZURE_OPENAI_DEPLOYMENT?.trim() || AGENTIC_SEARCH_DEFAULTS.model;

	return {
		nodeEnv: parsed.NODE_ENV,
		port: parsed.PORT,
		databaseUrl: parsed.DATABASE_URL,
		contentRoot: path.resolve(process.cwd(), parsed.REGULAR_RAG_CONTENT_ROOT),
		webSearchProviderMode: parsed.WEB_SEARCH_PROVIDER,
		exaApiKey: optionalTrimmed(parsed.EXA_API_KEY),
		exaSearchBaseUrl: parsed.EXA_SEARCH_BASE_URL.replace(/\/+$/, ""),
		braveSearchApiKey: optionalTrimmed(parsed.BRAVE_SEARCH_API_KEY),
		openAiApiKey: openAiApiKey || undefined,
		openAiCredentialSource,
		openAiBaseUrl,
		openAiApiVersion,
		openAiAgenticSearchModel,
		openAiAgenticSearchDebug: AGENTIC_SEARCH_DEFAULTS.debug,
		openAiAgenticSearchMaxToolCalls: AGENTIC_SEARCH_DEFAULTS.maxToolCalls,
		openAiAgenticSearchMaxFetchCalls: AGENTIC_SEARCH_DEFAULTS.maxFetchCalls,
		openAiAgenticSearchMaxContextChars: AGENTIC_SEARCH_DEFAULTS.maxContextChars,
		jwtSecret: parsed.JWT_SECRET,
		jwtAccessExpiresIn: parsed.JWT_ACCESS_EXPIRES_IN,
		jwtRefreshExpiresIn: parsed.JWT_REFRESH_EXPIRES_IN,
		appUrl,
		corsOrigins,
		trustProxy: parsed.TRUST_PROXY,
		secureCookie,
		cookieSameSite: parsed.COOKIE_SAME_SITE,
		bootstrapAdminEmail:
			optionalTrimmed(parsed.REGULAR_RAG_BOOTSTRAP_ADMIN_EMAIL) || undefined,
		bootstrapAdminPassword:
			optionalTrimmed(parsed.REGULAR_RAG_BOOTSTRAP_ADMIN_PASSWORD) || undefined,
		bootstrapAdminName:
			optionalTrimmed(parsed.REGULAR_RAG_BOOTSTRAP_ADMIN_NAME) || undefined,
	};
}
