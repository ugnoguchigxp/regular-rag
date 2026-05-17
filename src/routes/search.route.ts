import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { SourceRetriever } from "../modules/rag/retriever";

const SearchRequestSchema = z.object({
	query: z.string().min(1),
	topK: z.number().int().min(1).max(20).optional(),
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
			const retrieved = await deps.retriever.retrieve(body.query, {
				topK: body.topK ?? 8,
				enableTrigramFallback: true,
			});
			return c.json({
				query: body.query,
				results: retrieved,
			});
		},
	);
}
