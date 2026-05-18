import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema";
import { userSettings } from "../../db/schema";

const GLOBAL_SYSTEM_CONTEXT_KEY = "__global_system_context__";
const LEGACY_KEYS = ["local", "global", "system"];

export type SystemContextRecord = {
	userId: string;
	systemContext: string;
	createdAt: Date;
	updatedAt: Date;
};

export class SettingsRepository {
	constructor(private readonly db: NodePgDatabase<typeof schema>) {}

	private async ensureGlobalRecord(): Promise<SystemContextRecord> {
		const existingGlobal = await this.db.query.userSettings.findFirst({
			where: eq(userSettings.userId, GLOBAL_SYSTEM_CONTEXT_KEY),
		});
		if (existingGlobal) {
			return existingGlobal;
		}

		for (const legacyKey of LEGACY_KEYS) {
			const legacy = await this.db.query.userSettings.findFirst({
				where: eq(userSettings.userId, legacyKey),
			});
			if (!legacy) continue;
			const now = new Date();
			const [migrated] = await this.db
				.insert(userSettings)
				.values({
					userId: GLOBAL_SYSTEM_CONTEXT_KEY,
					systemContext: legacy.systemContext,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoNothing()
				.returning();
			if (migrated) {
				return migrated;
			}
			const retry = await this.db.query.userSettings.findFirst({
				where: eq(userSettings.userId, GLOBAL_SYSTEM_CONTEXT_KEY),
			});
			if (retry) return retry;
		}

		const now = new Date();
		const [created] = await this.db
			.insert(userSettings)
			.values({
				userId: GLOBAL_SYSTEM_CONTEXT_KEY,
				systemContext: "",
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		return created;
	}

	async getSystemContext(): Promise<SystemContextRecord> {
		return await this.ensureGlobalRecord();
	}

	async updateSystemContext(
		systemContext: string,
	): Promise<SystemContextRecord> {
		await this.ensureGlobalRecord();
		const now = new Date();
		const [updated] = await this.db
			.insert(userSettings)
			.values({
				userId: GLOBAL_SYSTEM_CONTEXT_KEY,
				systemContext,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: userSettings.userId,
				set: {
					systemContext,
					updatedAt: now,
				},
			})
			.returning();
		return updated;
	}
}
