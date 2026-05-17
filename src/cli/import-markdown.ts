import { connectDb, createDbConnection } from "../db";
import { importMarkdownDirectory } from "../modules/sources/markdown-importer.service";
import { SourceRepository } from "../modules/sources/source.repository";
import {
	ensureContentRoot,
	ensureGitRepo,
} from "../modules/sources/wiki/content-repo";
import { AzureOpenAiProvider } from "../providers/AzureOpenAiProvider";
import type { EmbeddingProvider } from "../providers/types";
import { readAppEnv } from "../app/env";

class UnconfiguredEmbeddingProvider implements EmbeddingProvider {
	constructor(private readonly reason: string) {}

	async createEmbedding(): Promise<never> {
		throw new Error(this.reason);
	}
}

async function main() {
	const env = readAppEnv();
	const dbConnection = createDbConnection(env.databaseUrl);

	try {
		await connectDb(dbConnection.pgClient);
		await ensureContentRoot(env.contentRoot);
		await ensureGitRepo(env.contentRoot);

		let embeddingProvider: EmbeddingProvider;
		try {
			embeddingProvider = AzureOpenAiProvider.fromEnv();
		} catch (error) {
			embeddingProvider = new UnconfiguredEmbeddingProvider(
				error instanceof Error
					? error.message
					: "Azure OpenAI embedding configuration is missing.",
			);
		}

		const sourceRepository = new SourceRepository(
			dbConnection.db,
			embeddingProvider,
		);
		const result = await importMarkdownDirectory({
			contentRoot: env.contentRoot,
			sourceRepository,
		});

		console.log(
			JSON.stringify(
				{
					ok: true,
					contentRoot: env.contentRoot,
					...result,
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
