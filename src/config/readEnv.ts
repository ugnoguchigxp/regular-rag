const DEFAULT_PORT = 3000;

export type EnvConfig = {
	port: number;
	databaseUrl: string;
};

export function readEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
	const databaseUrl = env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required");
	}

	const port = Number(env.PORT ?? DEFAULT_PORT);
	if (!Number.isFinite(port) || port <= 0) {
		throw new Error("PORT must be a positive number");
	}

	return {
		port,
		databaseUrl,
	};
}
