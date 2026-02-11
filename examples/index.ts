import { AzureOpenAiProvider, RagEngine, readEnv } from "../src";

import { createApp } from "./app";

const env = readEnv();
const provider = AzureOpenAiProvider.fromEnv();

const engine = await RagEngine.create({
	databaseUrl: env.databaseUrl,
	llmProvider: provider,
	embeddingProvider: provider,
});

const app = createApp(engine);

console.log(`🚀 RAG Example Server running on http://localhost:${env.port}`);

export default {
	port: env.port,
	fetch: app.fetch,
};
