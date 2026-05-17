import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
	evaluateRetrieverCompat,
	type SourceRetriever,
} from "../modules/rag/retriever";

const SearchRequestSchema = z.object({
	query: z.string().min(1),
	topK: z.number().int().min(1).max(20).optional(),
	category: z
		.string()
		.trim()
		.min(1)
		.regex(/^[^/]+$/, "Invalid category")
		.optional(),
});

type SearchRouteDeps = {
	retriever: SourceRetriever;
};

export function createSearchRoute(deps: SearchRouteDeps) {
	return new Hono().post(
		"/",
		zValidator("json", SearchRequestSchema),
		async (c) => {
			const body = c.req.valid("json");
			const evaluation = await evaluateRetrieverCompat(
				deps.retriever,
				body.query,
				{
					topK: body.topK ?? 8,
					enableTrigramFallback: true,
					category: body.category,
				},
			);
			return c.json({
				query: body.query,
				topK: body.topK ?? 8,
				category: body.category ?? null,
				strategy: evaluation.strategy,
				vectorResults: evaluation.vectorResults,
				textResults: evaluation.textResults,
				mergedResults: evaluation.mergedResults,
				selectedResults: evaluation.selectedResults,
			});
		},
	);
}
