import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";

import type { RagEngine } from "../src";
import { RagRequestSchema } from "../src";

const IngestRequestSchema = z.object({
	content: z.string().min(1),
});

export function createApp(engine: RagEngine) {
	const app = new Hono();

	app.use("*", logger());
	app.use("*", cors());

	// Health Check
	app.get("/health", (c) => c.json({ status: "ok" }));

	// RAG API
	app.post("/api/rag", async (c) => {
		const rawBody = await c.req.json().catch(() => null);
		const parsedBody = RagRequestSchema.safeParse(rawBody);
		if (!parsedBody.success) {
			return c.json({ error: "invalid request body" }, 400);
		}

		const body = parsedBody.data;
		if (body.messages.length === 0) {
			return c.json({ error: "messages is required" }, 400);
		}

		try {
			const result = await engine.query(body.messages, body.context);
			return c.json(result);
		} catch (error) {
			console.error("RAG Error:", error);
			return c.json({ error: String(error) }, 500);
		}
	});

	// Document Ingestion API
	app.post("/api/ingest", async (c) => {
		const rawBody = await c.req.json().catch(() => null);
		const parsedBody = IngestRequestSchema.safeParse(rawBody);
		if (!parsedBody.success) {
			return c.json({ error: "content is required" }, 400);
		}

		try {
			const result = await engine.ingestDocument(parsedBody.data.content);
			return c.json(result);
		} catch (error) {
			console.error("Ingest Error:", error);
			return c.json({ error: String(error) }, 500);
		}
	});

	// Chat UI
	app.get("/", (c) => {
		const currentDir = dirname(fileURLToPath(import.meta.url));
		const html = readFileSync(resolve(currentDir, "views/chat.html"), "utf-8");
		return c.html(html);
	});

	return app;
}
