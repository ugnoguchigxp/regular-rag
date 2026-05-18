import { connectDb, createDbConnection } from "../db";
import { readAppEnv } from "../app/env";
import {
	importMarkdownDirectory,
	type MarkdownImportProgressEvent,
} from "../modules/sources/markdown-importer.service";
import {
	type PendingSourceFragmentEmbedding,
	SourceRepository,
} from "../modules/sources/source.repository";
import {
	ensureContentRoot,
	ensureGitRepo,
} from "../modules/sources/wiki/content-repo";
import { createWikiBlobSyncer } from "../modules/sources/wiki/blob-sync";
import { createAzureOpenAiProviderFromAppEnv } from "../providers/azureOpenAiProviderFactory";
import type { EmbeddingProvider } from "../providers/types";

type IndexPhase = "fts" | "embed" | "all";

type CliOptions = {
	phase: IndexPhase;
	batchSize: number;
	maxFragments: number;
	sleepMs: number;
};

type EmbedPhaseSummary = {
	processed: number;
	embedded: number;
	failed: number;
	remaining: number;
	failures: Array<{
		id: string;
		sourceUri: string;
		locator: string;
		error: string;
	}>;
};

type EmbedProgressEvent =
	| {
			type: "start";
			pendingTotal: number;
	  }
	| {
			type: "batch_fetched";
			batchSize: number;
			processed: number;
	  }
	| {
			type: "fragment_done";
			processed: number;
			embedded: number;
			failed: number;
	  }
	| {
			type: "fragment_failed";
			processed: number;
			fragment: PendingSourceFragmentEmbedding;
			error: string;
	  }
	| {
			type: "completed";
			processed: number;
			embedded: number;
			failed: number;
			remaining: number;
	  };

const DEFAULT_BATCH_SIZE = 25;
const MAX_FAILURES_IN_OUTPUT = 50;
const PROGRESS_PREFIX = "[wiki:index]";

class UnconfiguredEmbeddingProvider implements EmbeddingProvider {
	constructor(private readonly reason: string) {}

	async createEmbedding(): Promise<never> {
		throw new Error(this.reason);
	}
}

function parsePositiveInt(value: string, optionName: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${optionName} must be a positive integer.`);
	}
	return parsed;
}

function parseNonNegativeInt(value: string, optionName: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`${optionName} must be a non-negative integer.`);
	}
	return parsed;
}

function parseCliOptions(argv: string[]): CliOptions {
	let phase: IndexPhase = "all";
	let batchSize = DEFAULT_BATCH_SIZE;
	let maxFragments = 0;
	let sleepMs = 0;

	for (const arg of argv) {
		if (arg.startsWith("--phase=")) {
			const value = arg.slice("--phase=".length).trim();
			if (value !== "fts" && value !== "embed" && value !== "all") {
				throw new Error("--phase must be one of: fts, embed, all.");
			}
			phase = value;
			continue;
		}
		if (arg.startsWith("--batch-size=")) {
			batchSize = parsePositiveInt(
				arg.slice("--batch-size=".length),
				"--batch-size",
			);
			continue;
		}
		if (arg.startsWith("--max-fragments=")) {
			maxFragments = parseNonNegativeInt(
				arg.slice("--max-fragments=".length),
				"--max-fragments",
			);
			continue;
		}
		if (arg.startsWith("--sleep-ms=")) {
			sleepMs = parseNonNegativeInt(
				arg.slice("--sleep-ms=".length),
				"--sleep-ms",
			);
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return {
		phase,
		batchSize,
		maxFragments,
		sleepMs,
	};
}

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function logProgress(message: string): void {
	const timestamp = new Date().toISOString();
	console.error(`${timestamp} ${PROGRESS_PREFIX} ${message}`);
}

function onMarkdownProgress(event: MarkdownImportProgressEvent): void {
	switch (event.type) {
		case "legacy_index":
			if (event.action === "moved_to_category") {
				logProgress(`legacy pages/index.md migrated -> ${event.to ?? "-"}`);
				return;
			}
			if (event.action === "deduplicated") {
				logProgress(
					`legacy pages/index.md removed (same content as ${event.to ?? "-"})`,
				);
				return;
			}
			logProgress(
				`legacy pages/index.md moved to backup -> ${event.to ?? "-"}`,
			);
			return;
		case "scan_completed":
			logProgress(`fts scan completed: files=${event.totalFiles}`);
			return;
		case "file_started":
			logProgress(
				`fts import start (${event.index}/${event.total}) category=${event.category} path=${event.path}`,
			);
			return;
		case "file_imported":
			logProgress(
				`fts imported (${event.index}/${event.total}) sourceId=${event.sourceId}`,
			);
			return;
		case "file_skipped_empty":
			logProgress(
				`fts skipped empty (${event.index}/${event.total}) ${event.path}`,
			);
			return;
		case "cleanup_started":
			logProgress(`fts cleanup start: keepUris=${event.keepUris}`);
			return;
		case "cleanup_completed":
			logProgress(`fts cleanup done: removedSources=${event.removedSources}`);
			return;
	}
}

function onEmbedProgress(event: EmbedProgressEvent): void {
	switch (event.type) {
		case "start":
			logProgress(`embed start: pending=${event.pendingTotal}`);
			return;
		case "batch_fetched":
			logProgress(
				`embed batch fetched: batchSize=${event.batchSize} processed=${event.processed}`,
			);
			return;
		case "fragment_done":
			logProgress(
				`embed progress: processed=${event.processed} embedded=${event.embedded} failed=${event.failed}`,
			);
			return;
		case "fragment_failed":
			logProgress(
				`embed failed: id=${event.fragment.id} locator=${event.fragment.locator} error=${event.error}`,
			);
			return;
		case "completed":
			logProgress(
				`embed completed: processed=${event.processed} embedded=${event.embedded} failed=${event.failed} remaining=${event.remaining}`,
			);
			return;
	}
}

async function runEmbeddingPhase(params: {
	sourceRepository: SourceRepository;
	batchSize: number;
	maxFragments: number;
	sleepMs: number;
	onProgress?: (event: EmbedProgressEvent) => void;
}): Promise<EmbedPhaseSummary> {
	const summary: EmbedPhaseSummary = {
		processed: 0,
		embedded: 0,
		failed: 0,
		remaining: 0,
		failures: [],
	};
	const pendingTotal =
		await params.sourceRepository.countPendingSourceFragmentEmbeddings([
			"wiki",
		]);
	params.onProgress?.({
		type: "start",
		pendingTotal,
	});

	let cursor: { createdAt: Date; id: string } | undefined;

	while (true) {
		const remainingLimit =
			params.maxFragments > 0
				? Math.max(params.maxFragments - summary.processed, 0)
				: params.batchSize;
		if (params.maxFragments > 0 && remainingLimit === 0) {
			break;
		}
		const limit = Math.min(params.batchSize, remainingLimit);
		const pending =
			await params.sourceRepository.listPendingSourceFragmentEmbeddings({
				limit,
				after: cursor,
				sourceKinds: ["wiki"],
			});
		if (pending.length === 0) break;
		params.onProgress?.({
			type: "batch_fetched",
			batchSize: pending.length,
			processed: summary.processed,
		});

		for (const fragment of pending) {
			summary.processed += 1;
			cursor = { createdAt: fragment.createdAt, id: fragment.id };

			await processSingleFragment(
				params.sourceRepository,
				fragment,
				summary,
				params.onProgress,
			);
			params.onProgress?.({
				type: "fragment_done",
				processed: summary.processed,
				embedded: summary.embedded,
				failed: summary.failed,
			});
			await sleep(params.sleepMs);

			if (params.maxFragments > 0 && summary.processed >= params.maxFragments) {
				break;
			}
		}

		if (params.maxFragments > 0 && summary.processed >= params.maxFragments) {
			break;
		}
	}

	summary.remaining =
		await params.sourceRepository.countPendingSourceFragmentEmbeddings([
			"wiki",
		]);
	params.onProgress?.({
		type: "completed",
		processed: summary.processed,
		embedded: summary.embedded,
		failed: summary.failed,
		remaining: summary.remaining,
	});
	return summary;
}

async function processSingleFragment(
	sourceRepository: SourceRepository,
	fragment: PendingSourceFragmentEmbedding,
	summary: EmbedPhaseSummary,
	onProgress?: (event: EmbedProgressEvent) => void,
): Promise<void> {
	try {
		const embedding = await sourceRepository.createEmbeddingForContent(
			fragment.content,
		);
		await sourceRepository.updateSourceFragmentEmbedding(
			fragment.id,
			embedding,
		);
		summary.embedded += 1;
	} catch (error) {
		summary.failed += 1;
		const message =
			error instanceof Error ? error.message : "Embedding generation failed.";
		onProgress?.({
			type: "fragment_failed",
			processed: summary.processed,
			fragment,
			error: message,
		});
		if (summary.failures.length < MAX_FAILURES_IN_OUTPUT) {
			summary.failures.push({
				id: fragment.id,
				sourceUri: fragment.sourceUri,
				locator: fragment.locator,
				error: message,
			});
		}
	}
}

async function main() {
	const options = parseCliOptions(process.argv.slice(2));
	const env = readAppEnv();
	logProgress(
		`start phase=${options.phase} contentRoot=${env.contentRoot} batchSize=${options.batchSize} maxFragments=${options.maxFragments} sleepMs=${options.sleepMs}`,
	);
	const dbConnection = createDbConnection(env.databaseUrl);

	let provider: EmbeddingProvider;
	let providerError: string | null = null;
	try {
		provider = createAzureOpenAiProviderFromAppEnv(env);
	} catch (error) {
		providerError =
			error instanceof Error
				? error.message
				: "Azure OpenAI embedding configuration is missing.";
		provider = new UnconfiguredEmbeddingProvider(providerError);
	}

	const sourceRepository = new SourceRepository(dbConnection.db, provider);

	try {
		logProgress("db connect start");
		await connectDb(dbConnection.pgClient);
		logProgress("db connect done");
		logProgress("wiki blob pull start");
		await createWikiBlobSyncer(env)?.pull({ force: true });
		logProgress("wiki blob pull done");
		logProgress("content root ensure start");
		await ensureContentRoot(env.contentRoot);
		logProgress("content root ensure done");
		logProgress("git repo ensure start");
		await ensureGitRepo(env.contentRoot);
		logProgress("git repo ensure done");

		const ftsResult =
			options.phase === "fts" || options.phase === "all"
				? await importMarkdownDirectory({
						contentRoot: env.contentRoot,
						sourceRepository,
						embedFragments: false,
						onProgress: onMarkdownProgress,
					})
				: null;

		let embedResult: EmbedPhaseSummary | null = null;
		if (options.phase === "embed" || options.phase === "all") {
			if (providerError) {
				throw new Error(
					`Embedding phase requires Azure OpenAI configuration: ${providerError}`,
				);
			}
			embedResult = await runEmbeddingPhase({
				sourceRepository,
				batchSize: options.batchSize,
				maxFragments: options.maxFragments,
				sleepMs: options.sleepMs,
				onProgress: onEmbedProgress,
			});
		}

		console.log(
			JSON.stringify(
				{
					ok: true,
					contentRoot: env.contentRoot,
					phase: options.phase,
					options: {
						batchSize: options.batchSize,
						maxFragments: options.maxFragments,
						sleepMs: options.sleepMs,
					},
					fts: ftsResult,
					embedding: embedResult,
				},
				null,
				2,
			),
		);
	} finally {
		if ("end" in dbConnection.pgClient) {
			await dbConnection.pgClient.end();
		}
	}
}

await main();
