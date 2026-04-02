import { RagEngine } from "./src/core/RagEngine";
import { BraveSearchProvider } from "./src/providers/BraveSearchProvider";
import { AzureOpenAiProvider } from "./src/providers/AzureOpenAiProvider";

async function main() {
    console.log("Starting Web Search Verification...");

    const llmProvider = AzureOpenAiProvider.fromEnv();
    const embeddingProvider = AzureOpenAiProvider.fromEnv();
    const webSearchProvider = BraveSearchProvider.fromEnv();

    const engine = await RagEngine.create({
        databaseUrl: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/postgres",
        llmProvider,
        embeddingProvider,
        webSearchProvider,
    });

    console.log("RagEngine created with WebSearchProvider.");

    const query = "Latest news about TypeScript 5.8";
    console.log(`Searching web for: "${query}"...`);

    try {
        const results = await engine.searchWeb(query, 3);
        console.log("Search Results:");
        results.forEach((res, i) => {
            console.log(`[${i + 1}] ${res.title}`);
            console.log(`    URL: ${res.url}`);
            console.log(`    Snippet: ${res.snippet}`);
            if (res.content) {
                console.log(`    Content length: ${res.content.length}`);
            }
            console.log("---");
        });
    } catch (error) {
        console.error("Web Search failed:", error);
    } finally {
        await engine.close();
    }
}

main().catch(console.error);
