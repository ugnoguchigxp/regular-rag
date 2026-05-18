import { APP_CONFIG_DEFAULTS } from "./appDefaults";

export type EnvConfig = {
	port: number;
	databaseUrl: string;
};

export function readEnv(_env: NodeJS.ProcessEnv = process.env): EnvConfig {
	return {
		port: APP_CONFIG_DEFAULTS.port,
		databaseUrl: APP_CONFIG_DEFAULTS.databaseUrl,
	};
}
