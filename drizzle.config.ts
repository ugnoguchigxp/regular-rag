import type { Config } from "drizzle-kit";
import { APP_CONFIG_DEFAULTS } from "./src/config/appDefaults";

export default {
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: {
		url: APP_CONFIG_DEFAULTS.databaseUrl,
	},
} satisfies Config;
