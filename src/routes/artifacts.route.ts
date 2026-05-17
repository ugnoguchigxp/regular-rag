import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import { z } from "zod";
import type * as schema from "../db/schema";
import { artifacts } from "../db/schema";

const ArtifactsQuerySchema = z.object({
	conversationId: z.string().uuid().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
});

const UpdateArtifactSchema = z.object({
	title: z.string().optional(),
	content: z.record(z.string(), z.unknown()),
	version: z.coerce.number().int().positive().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

type ArtifactsRouteDeps = {
	db: NodePgDatabase<typeof schema>;
};

export function createArtifactsRoute(deps: ArtifactsRouteDeps) {
	return new Hono()
		.get("/", zValidator("query", ArtifactsQuerySchema), async (c) => {
			const { conversationId, limit } = c.req.valid("query");
			const whereClause = conversationId
				? and(eq(artifacts.conversationId, conversationId))
				: undefined;
			const baseQuery = deps.db
				.select({
					id: artifacts.id,
					conversationId: artifacts.conversationId,
					messageId: artifacts.messageId,
					type: artifacts.type,
					title: artifacts.title,
					content: artifacts.content,
					version: artifacts.version,
					metadata: artifacts.metadata,
					createdAt: artifacts.createdAt,
					updatedAt: artifacts.updatedAt,
				})
				.from(artifacts);
			const filteredQuery = whereClause
				? baseQuery.where(whereClause)
				: baseQuery;
			const items = await filteredQuery
				.orderBy(desc(artifacts.updatedAt))
				.limit(limit);
			return c.json({ items });
		})
		.get("/:artifactId", async (c) => {
			const artifactId = c.req.param("artifactId");
			const item = await deps.db.query.artifacts.findFirst({
				where: eq(artifacts.id, artifactId),
				columns: {
					id: true,
					conversationId: true,
					messageId: true,
					type: true,
					title: true,
					content: true,
					version: true,
					metadata: true,
					createdAt: true,
					updatedAt: true,
				},
			});
			if (!item) {
				return c.json({ message: "Artifact not found" }, 404);
			}
			return c.json(item);
		})
		.put(
			"/:artifactId",
			zValidator("json", UpdateArtifactSchema),
			async (c) => {
				const artifactId = c.req.param("artifactId");
				const payload = c.req.valid("json");
				const existing = await deps.db.query.artifacts.findFirst({
					where: eq(artifacts.id, artifactId),
					columns: { id: true, version: true, metadata: true },
				});
				if (!existing) {
					return c.json({ message: "Artifact not found" }, 404);
				}

				const nextVersion = payload.version ?? existing.version + 1;
				const [updated] = await deps.db
					.update(artifacts)
					.set({
						title: payload.title ?? null,
						content: payload.content,
						version: nextVersion,
						metadata:
							payload.metadata ??
							(existing.metadata as Record<string, unknown>),
						updatedAt: new Date(),
					})
					.where(eq(artifacts.id, artifactId))
					.returning({
						id: artifacts.id,
						conversationId: artifacts.conversationId,
						messageId: artifacts.messageId,
						type: artifacts.type,
						title: artifacts.title,
						content: artifacts.content,
						version: artifacts.version,
						metadata: artifacts.metadata,
						createdAt: artifacts.createdAt,
						updatedAt: artifacts.updatedAt,
					});
				return c.json(updated);
			},
		);
}
