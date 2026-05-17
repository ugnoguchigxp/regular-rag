import type { EmbeddingProvider } from "../../providers/types";
import type { SourceRepository } from "../sources/source.repository";
import type { RetrievedFragment } from "./types";

const RRF_CONSTANT = 60;

export type RetrieveOptions = {
	topK: number;
	enableTrigramFallback?: boolean;
};

function mergeRrf(
	vectorResults: Array<{
		id: string;
		sourceId: string;
		sourceUri: string;
		locator: string;
		heading: string | null;
		content: string;
		score: number;
	}>,
	textResults: Array<{
		id: string;
		sourceId: string;
		sourceUri: string;
		locator: string;
		heading: string | null;
		content: string;
		score: number;
	}>,
	topK: number,
): RetrievedFragment[] {
	const merged = new Map<string, RetrievedFragment>();

	vectorResults.forEach((result, index) => {
		const rank = index + 1;
		const rrfScore = 1 / (RRF_CONSTANT + rank);
		merged.set(result.id, {
			id: result.id,
			sourceId: result.sourceId,
			sourceUri: result.sourceUri,
			locator: result.locator,
			heading: result.heading,
			content: result.content,
			vectorScore: result.score,
			combinedScore: rrfScore,
		});
	});

	textResults.forEach((result, index) => {
		const rank = index + 1;
		const rrfScore = 1 / (RRF_CONSTANT + rank);
		const existing = merged.get(result.id);
		if (existing) {
			existing.textScore = result.score;
			existing.combinedScore += rrfScore;
		} else {
			merged.set(result.id, {
				id: result.id,
				sourceId: result.sourceId,
				sourceUri: result.sourceUri,
				locator: result.locator,
				heading: result.heading,
				content: result.content,
				textScore: result.score,
				combinedScore: rrfScore,
			});
		}
	});

	return [...merged.values()]
		.sort((a, b) => b.combinedScore - a.combinedScore)
		.slice(0, topK);
}

export class SourceRetriever {
	constructor(
		private readonly sourceRepository: SourceRepository,
		private readonly embeddingProvider: EmbeddingProvider,
	) {}

	async retrieve(
		query: string,
		options: RetrieveOptions,
	): Promise<RetrievedFragment[]> {
		const topK = Math.max(1, options.topK);
		const embedding = await this.embeddingProvider.createEmbedding(query);
		const [vectorResults, textResults] = await Promise.all([
			this.sourceRepository.vectorSearchSourceContent(embedding, topK * 5, [
				"wiki",
			]),
			this.sourceRepository.searchSourceContent(query, topK * 5, ["wiki"]),
		]);

		const merged = mergeRrf(vectorResults, textResults, topK);
		if (merged.length > 0 || !options.enableTrigramFallback) {
			return merged;
		}
		return textResults.slice(0, topK).map((item, index) => ({
			id: item.id,
			sourceId: item.sourceId,
			sourceUri: item.sourceUri,
			locator: item.locator,
			heading: item.heading,
			content: item.content,
			textScore: item.score,
			trigramScore: item.score,
			combinedScore: 1 / (RRF_CONSTANT + index + 1),
		}));
	}
}
