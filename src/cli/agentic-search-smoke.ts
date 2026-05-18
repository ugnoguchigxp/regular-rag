import { readAppEnv } from "../app/env";
import { connectDb, createDbConnection } from "../db";
import { AgenticSearchService } from "../modules/agentic-search/agentic-search.service";
import { OpenAiResponsesAdapter } from "../modules/agentic-search/llm/openai-responses-adapter";
import { AgenticSearchRunner } from "../modules/agentic-search/runner";
import type { AgenticSearchResult } from "../modules/agentic-search/types";
import { AgenticToolRegistry } from "../modules/agentic-search/tools/registry";
import { SourceRetriever } from "../modules/rag/retriever";
import { SearchEvidenceCollector } from "../modules/rag/search-evidence";
import { SettingsRepository } from "../modules/settings/settings.repository";
import { SourceRepository } from "../modules/sources/source.repository";
import { readPage } from "../modules/sources/wiki/content-repo";
import { AzureOpenAiProvider } from "../providers/AzureOpenAiProvider";
import type { EmbeddingProvider } from "../providers/types";
import { createConfiguredWebSearchProvider } from "../providers/webSearchProviderFactory";

type CliOptions = {
	query: string;
	topK: number;
	category?: string;
	connectOnly: boolean;
	json: boolean;
};

type SmokeCheck = {
	name: string;
	ok: boolean;
	message: string;
	details?: Record<string, unknown>;
};

class UnconfiguredEmbeddingProvider implements EmbeddingProvider {
	constructor(private readonly reason: string) {}

	async createEmbedding(): Promise<never> {
		throw new Error(this.reason);
	}
}

function parseArgs(argv: string[]): CliOptions {
	let query = "regular-rag の検索アーキテクチャを要約してください。";
	let topK = 8;
	let category: string | undefined;
	let connectOnly = false;
	let json = false;

	for (const arg of argv) {
		if (arg.startsWith("--query=")) {
			query = arg.slice("--query=".length).trim() || query;
			continue;
		}
		if (arg.startsWith("--topK=")) {
			const value = Number.parseInt(arg.slice("--topK=".length), 10);
			if (!Number.isFinite(value) || value < 1 || value > 20) {
				throw new Error("--topK must be an integer in [1, 20].");
			}
			topK = value;
			continue;
		}
		if (arg.startsWith("--category=")) {
			const value = arg.slice("--category=".length).trim();
			category = value.length > 0 ? value : undefined;
			continue;
		}
		if (arg === "--connect-only") {
			connectOnly = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return { query, topK, category, connectOnly, json };
}

function summarizeResult(result: AgenticSearchResult): Record<string, unknown> {
	return {
		answerPreview: result.answer.slice(0, 280),
		answerLength: result.answer.length,
		citations: result.citations.length,
		toolTrace: result.toolTrace.length,
		okToolCalls: result.toolTrace.filter((item) => item.status === "ok").length,
		usage: result.usage ?? null,
	};
}

function evaluateResult(result: AgenticSearchResult): SmokeCheck[] {
	const checks: SmokeCheck[] = [];
	checks.push({
		name: "answer-non-empty",
		ok: result.answer.trim().length > 0,
		message:
			result.answer.trim().length > 0 ? "answer present" : "answer empty",
	});

	const isFallbackAnswer =
		result.answer.includes("回答を生成できませんでした") ||
		result.answer.includes("実行上限に達した");
	checks.push({
		name: "answer-not-fallback",
		ok: !isFallbackAnswer,
		message: isFallbackAnswer
			? "fallback answer detected"
			: "no fallback answer",
	});

	checks.push({
		name: "has-citations",
		ok: result.citations.length > 0,
		message:
			result.citations.length > 0
				? "citations found"
				: "citations missing in final answer evidence",
	});

	const localToolUsed = result.toolTrace.some(
		(item) =>
			item.status === "ok" &&
			(item.tool === "full_text_search" ||
				item.tool === "vector_search" ||
				item.tool === "wiki_read"),
	);
	checks.push({
		name: "local-tool-used",
		ok: localToolUsed,
		message: localToolUsed
			? "local wiki tool usage observed"
			: "local wiki tools were not executed successfully",
	});

	return checks;
}

async function runEmbeddingCheck(): Promise<SmokeCheck> {
	if (
		!process.env.AZURE_OPENAI_ENDPOINT ||
		!process.env.AZURE_OPENAI_API_KEY ||
		!process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT
	) {
		return {
			name: "embedding-api",
			ok: true,
			message:
				"skipped (AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT not fully configured)",
		};
	}

	try {
		const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
		const apiKey = process.env.AZURE_OPENAI_API_KEY;
		const embeddingsDeployment = process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT;
		if (!endpoint || !apiKey || !embeddingsDeployment) {
			throw new Error("Embedding smoke prerequisites are not configured.");
		}
		const provider = new AzureOpenAiProvider({
			endpoint,
			apiKey,
			deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? embeddingsDeployment,
			embeddingsDeployment,
			apiVersion: process.env.AZURE_OPENAI_API_VERSION,
		});
		const embedding = await provider.createEmbedding(
			"agentic smoke embedding check",
		);
		return {
			name: "embedding-api",
			ok: true,
			message: "embedding API reachable",
			details: {
				dimension: embedding.length,
			},
		};
	} catch (error) {
		return {
			name: "embedding-api",
			ok: false,
			message:
				error instanceof Error
					? error.message
					: "embedding API check failed unexpectedly",
		};
	}
}

async function runResponsesCheck(env: ReturnType<typeof readAppEnv>): Promise<{
	check: SmokeCheck;
	adapter: OpenAiResponsesAdapter;
	modelProbe?: Record<string, unknown>;
}> {
	if (!env.openAiApiKey) {
		throw new Error(
			"OPENAI_API_KEY or AZURE_OPENAI_API_KEY is required for responses check.",
		);
	}
	const adapter = new OpenAiResponsesAdapter({
		apiKey: env.openAiApiKey,
		baseUrl: env.openAiBaseUrl,
		apiVersion: env.openAiApiVersion,
		model: env.openAiAgenticSearchModel,
		debug: env.openAiAgenticSearchDebug,
	});

	try {
		const turn = await adapter.createTurn({
			instructions: "You are a concise assistant. Reply in Japanese.",
			input: [
				{
					role: "user",
					content: [
						{
							type: "input_text",
							text: "疎通テストです。OK の一言と1文だけ返してください。",
						},
					],
				},
			],
			tools: [],
		});
		return {
			check: {
				name: "responses-api",
				ok: true,
				message: "responses API reachable",
				details: {
					responseId: turn.responseId,
					outputTextLength: turn.text.length,
					usage: turn.usage ?? null,
				},
			},
			adapter,
		};
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "responses API check failed unexpectedly";
		let modelProbe: Record<string, unknown> | undefined;
		if (message.includes("DeploymentNotFound")) {
			const diagnostics = adapter.getDiagnostics();
			const modelUrl = new URL(
				`models/${encodeURIComponent(diagnostics.model)}`,
				`${diagnostics.baseUrl}/`,
			);
			if (diagnostics.apiVersion) {
				modelUrl.searchParams.set("api-version", diagnostics.apiVersion);
			}
			try {
				const response = await fetch(modelUrl.toString(), {
					method: "GET",
					headers: {
						Authorization: `Bearer ${env.openAiApiKey}`,
						"api-key": env.openAiApiKey,
					},
				});
				const body = await response.text();
				modelProbe = {
					url: modelUrl.toString(),
					status: response.status,
					requestId:
						response.headers.get("x-request-id") ||
						response.headers.get("apim-request-id") ||
						response.headers.get("x-ms-request-id") ||
						null,
					bodyPreview: body.slice(0, 400),
				};
			} catch (probeError) {
				modelProbe = {
					url: modelUrl.toString(),
					error:
						probeError instanceof Error
							? probeError.message
							: "model probe failed unexpectedly",
				};
			}
		}
		return {
			check: {
				name: "responses-api",
				ok: false,
				message,
				details: adapter.getDiagnostics(),
			},
			adapter,
			modelProbe,
		};
	}
}

async function runAgenticCheck(
	env: ReturnType<typeof readAppEnv>,
	options: CliOptions,
	adapter: OpenAiResponsesAdapter,
): Promise<{ result?: AgenticSearchResult; checks: SmokeCheck[] }> {
	const dbConnection = createDbConnection(env.databaseUrl);
	await connectDb(dbConnection.pgClient);
	try {
		let embeddingProvider: EmbeddingProvider;
		try {
			embeddingProvider = AzureOpenAiProvider.fromEnv();
		} catch (error) {
			embeddingProvider = new UnconfiguredEmbeddingProvider(
				error instanceof Error
					? error.message
					: "Azure OpenAI provider is unavailable.",
			);
		}

		const sourceRepository = new SourceRepository(
			dbConnection.db,
			embeddingProvider,
		);
		const settingsRepository = new SettingsRepository(dbConnection.db);
		const configuredWebSearch = createConfiguredWebSearchProvider(env);
		const retriever = new SourceRetriever(sourceRepository, embeddingProvider);
		const evidenceCollector = new SearchEvidenceCollector({
			retriever,
			webSearchProvider: configuredWebSearch.provider,
		});

		const toolRegistry = new AgenticToolRegistry({
			sourceRepository,
			createEmbedding: (input) => embeddingProvider.createEmbedding(input),
			readWikiPage: (slug) => readPage(env.contentRoot, slug),
			evidenceCollector,
			webSearchProvider: configuredWebSearch.provider,
			webSearchUnavailableMessage:
				configuredWebSearch.unavailableMessage ?? undefined,
			maxContextChars: env.openAiAgenticSearchMaxContextChars,
		});

		const runner = new AgenticSearchRunner({
			llmAdapter: adapter,
			toolRegistry,
			options: {
				maxToolCalls: env.openAiAgenticSearchMaxToolCalls,
				maxFetchCalls: env.openAiAgenticSearchMaxFetchCalls,
				maxContextChars: env.openAiAgenticSearchMaxContextChars,
			},
			debug: env.openAiAgenticSearchDebug,
		});
		const service = new AgenticSearchService({
			settingsRepository,
			runner,
			debug: env.openAiAgenticSearchDebug,
		});

		const result = await service.run({
			query: options.query,
			userId: "local",
			topK: options.topK,
			category: options.category,
		});

		const checks = evaluateResult(result);
		return { result, checks };
	} finally {
		await dbConnection.pgClient.end();
	}
}

function printHumanOutput(payload: {
	config: Record<string, unknown>;
	checks: SmokeCheck[];
	result?: AgenticSearchResult;
	resultChecks?: SmokeCheck[];
}): void {
	console.log(
		`[agentic:smoke] config ${JSON.stringify(payload.config, null, 2)}`,
	);
	for (const check of payload.checks) {
		console.log(
			`[agentic:smoke] ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`,
		);
		if (check.details) {
			console.log(
				`[agentic:smoke] ${check.name}.details ${JSON.stringify(check.details)}`,
			);
		}
	}
	if (payload.result) {
		console.log(
			`[agentic:smoke] agentic.summary ${JSON.stringify(summarizeResult(payload.result), null, 2)}`,
		);
		if (payload.resultChecks) {
			for (const check of payload.resultChecks) {
				console.log(
					`[agentic:smoke] ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`,
				);
			}
		}
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const env = readAppEnv();
	const config = {
		baseUrl: env.openAiBaseUrl ?? null,
		apiVersion: env.openAiApiVersion ?? null,
		model: env.openAiAgenticSearchModel,
		hasOpenAiApiKey: Boolean(env.openAiApiKey),
		hasAzureApiKey: Boolean(process.env.AZURE_OPENAI_API_KEY),
		azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT ?? null,
		azureDeployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? null,
		embeddingsDeployment:
			process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT ?? null,
		webSearchProviderMode: env.webSearchProviderMode,
		hasExaApiKey: Boolean(env.exaApiKey),
		hasBraveSearchApiKey: Boolean(env.braveSearchApiKey),
		debug: env.openAiAgenticSearchDebug,
	};

	const checks: SmokeCheck[] = [];
	const embeddingCheck = await runEmbeddingCheck();
	checks.push(embeddingCheck);

	const responses = await runResponsesCheck(env);
	checks.push({
		...responses.check,
		details: {
			...(responses.check.details ?? {}),
			adapter: responses.adapter.getDiagnostics(),
			modelProbe: responses.modelProbe ?? null,
		},
	});

	let result: AgenticSearchResult | undefined;
	let resultChecks: SmokeCheck[] | undefined;
	if (!options.connectOnly && responses.check.ok) {
		const agenticRun = await runAgenticCheck(env, options, responses.adapter);
		result = agenticRun.result;
		resultChecks = agenticRun.checks;
	}

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					ok:
						checks.every((item) => item.ok) &&
						(resultChecks ? resultChecks.every((item) => item.ok) : true),
					config,
					checks,
					result: result ? summarizeResult(result) : null,
					resultChecks: resultChecks ?? [],
				},
				null,
				2,
			),
		);
		return;
	}

	printHumanOutput({ config, checks, result, resultChecks });
}

await main();
