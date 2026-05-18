import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { SettingsRepository } from "../modules/settings/settings.repository";

const UpdateSystemContextSchema = z.object({
	systemContext: z.string(),
});

type SettingsRouteDeps = {
	settingsRepository: SettingsRepository;
};

export function createSettingsRoute(deps: SettingsRouteDeps) {
	if (!deps?.settingsRepository) {
		throw new Error("settingsRepository is not configured");
	}
	const repo = deps.settingsRepository as unknown as {
		getSystemContext?: () => Promise<{
			systemContext: string;
			updatedAt: Date;
		}>;
		getUserSettings?: (userId: string) => Promise<{
			systemContext: string;
			updatedAt: Date;
		}>;
		updateSystemContext?: (...args: string[]) => Promise<{
			systemContext: string;
			updatedAt: Date;
		}>;
	};

	return new Hono()
		.get("/system-context", async (c) => {
			const record = repo.getSystemContext
				? await repo.getSystemContext()
				: repo.getUserSettings
					? await repo.getUserSettings("local")
					: null;
			if (!record) {
				throw new Error("settingsRepository.getSystemContext is not available");
			}
			return c.json({
				systemContext: record.systemContext,
				updatedAt: record.updatedAt.toISOString(),
			});
		})
		.put(
			"/system-context",
			zValidator("json", UpdateSystemContextSchema),
			async (c) => {
				const body = c.req.valid("json");
				if (!repo.updateSystemContext) {
					throw new Error(
						"settingsRepository.updateSystemContext is not available",
					);
				}
				const record =
					repo.updateSystemContext.length >= 2
						? await repo.updateSystemContext("local", body.systemContext)
						: await repo.updateSystemContext(body.systemContext);
				return c.json({
					systemContext: record.systemContext,
					updatedAt: record.updatedAt.toISOString(),
				});
			},
		);
}
