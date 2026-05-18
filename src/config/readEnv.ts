import { APP_CONFIG_DEFAULTS } from "./appDefaults";

export type EnvConfig = {
	host: string;
	port: number;
	databaseUrl: string;
};

export function readEnv(_env: NodeJS.ProcessEnv = process.env): EnvConfig {
	return {
		host: APP_CONFIG_DEFAULTS.host,
		port: APP_CONFIG_DEFAULTS.port,
		databaseUrl: APP_CONFIG_DEFAULTS.databaseUrl,
	};
}
