import fs from "node:fs/promises";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { DbConnection } from "../db";
import { createDbConnection } from "../db";
import { SourceRetriever } from "../modules/rag/retriever";
import { SourceRepository } from "../modules/sources/source.repository";
import { AzureOpenAiProvider } from "../providers/AzureOpenAiProvider";
import type { EmbeddingProvider, LlmProvider } from "../providers/types";
import { createArtifactsRoute } from "../routes/artifacts.route";
import { createChatRoute } from "../routes/chat.route";
import { createHealthRoute } from "../routes/health.route";
import { createSearchRoute } from "../routes/search.route";
import { createSourcesRoute } from "../routes/sources.route";
import { readAppEnv, type AppEnv } from "./env";

type AppRuntime = {
	env: AppEnv;
	dbConnection: DbConnection;
	llmProvider: LlmProvider;
	embeddingProvider: EmbeddingProvider;
	sourceRepository: SourceRepository;
	retriever: SourceRetriever;
};

class UnconfiguredProvider implements LlmProvider, EmbeddingProvider {
	constructor(private readonly reason: string) {}

	async chatCompletion(): Promise<never> {
		throw new Error(this.reason);
	}

	async createEmbedding(): Promise<never> {
		throw new Error(this.reason);
	}
}

declare global {
	var __regularRagRuntime__: Promise<AppRuntime> | undefined;
}

async function createRuntime(): Promise<AppRuntime> {
	const env = readAppEnv();
	const dbConnection = createDbConnection(env.databaseUrl);

	let provider: LlmProvider & EmbeddingProvider;
	try {
		provider = AzureOpenAiProvider.fromEnv();
	} catch (error) {
		provider = new UnconfiguredProvider(
			error instanceof Error
				? error.message
				: "Azure OpenAI is not configured in environment variables.",
		);
	}

	const sourceRepository = new SourceRepository(dbConnection.db, provider);
	const retriever = new SourceRetriever(sourceRepository, provider);

	return {
		env,
		dbConnection,
		llmProvider: provider,
		embeddingProvider: provider,
		sourceRepository,
		retriever,
	};
}

export async function getAppRuntime(): Promise<AppRuntime> {
	if (!globalThis.__regularRagRuntime__) {
		globalThis.__regularRagRuntime__ = createRuntime().catch((error) => {
			globalThis.__regularRagRuntime__ = undefined;
			throw error;
		});
	}
	return globalThis.__regularRagRuntime__;
}

const runtime = await getAppRuntime();
const app = new Hono();
const distWebRoot = path.resolve(process.cwd(), "dist-web");
const distWebIndex = path.resolve(distWebRoot, "index.html");

app.use("*", logger());
app.use("/api/*", cors());
app.onError((error, c) => {
	console.error(error);
	const dbError = error as { code?: string; message?: string };
	if (
		dbError.code === "42703" &&
		typeof dbError.message === "string" &&
		dbError.message.includes("category")
	) {
		return c.json(
			{
				message:
					'Database schema is outdated. Run "bun run db:migrate" and retry.',
			},
			500,
		);
	}
	return c.json(
		{
			message: error instanceof Error ? error.message : "Internal server error",
		},
		500,
	);
});

app.route("/api/health", createHealthRoute());
app.route(
	"/api/sources",
	createSourcesRoute({
		contentRoot: runtime.env.contentRoot,
		sourceRepository: runtime.sourceRepository,
	}),
);
app.route("/api/search", createSearchRoute({ retriever: runtime.retriever }));
app.route(
	"/api/chat",
	createChatRoute({
		db: runtime.dbConnection.db,
		retriever: runtime.retriever,
		llmProvider: runtime.llmProvider,
	}),
);
app.route(
	"/api/artifacts",
	createArtifactsRoute({
		db: runtime.dbConnection.db,
	}),
);

app.use("/assets/*", serveStatic({ root: "./dist-web" }));
app.use("/favicon.ico", serveStatic({ root: "./dist-web" }));
app.get("*", async (c) => {
	if (c.req.path.startsWith("/api/")) {
		return c.notFound();
	}
	try {
		const html = await fs.readFile(distWebIndex, "utf8");
		return c.html(html);
	} catch {
		return c.text(
			"Frontend is not built. Run `bun run build:web` or `bun run dev`.",
			404,
		);
	}
});

export default app;
