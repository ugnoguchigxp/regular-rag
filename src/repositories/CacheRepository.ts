import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { chatbotCache } from "../db/schema";

export class CacheRepository {
	constructor(private db: NodePgDatabase<typeof schema>) {}

	async findByHash(hash: string) {
		return await this.db.query.chatbotCache.findFirst({
			where: eq(chatbotCache.requestHash, hash),
		});
	}

	async save(
		hash: string,
		question: string,
		context: Record<string, unknown>,
		response: string,
	) {
		await this.db
			.insert(chatbotCache)
			.values({
				requestHash: hash,
				question,
				context,
				response,
			})
			.onConflictDoUpdate({
				target: chatbotCache.requestHash,
				set: {
					question,
					context,
					response,
					updatedAt: sql`now()`,
				},
			});
	}

	async incrementHitCount(hash: string) {
		await this.db
			.update(chatbotCache)
			.set({
				hitCount: sql`${chatbotCache.hitCount} + 1`,
				lastHitAt: sql`now()`,
			})
			.where(eq(chatbotCache.requestHash, hash));
	}
}
