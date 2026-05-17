import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
	PORT: z.coerce.number().int().positive().default(5173),
	DATABASE_URL: z
		.string()
		.min(1)
		.default("postgres://postgres:postgres@localhost:5432/regular_rag"),
	REGULAR_RAG_CONTENT_ROOT: z.string().default("../wiki-knowledge"),
});

export type AppEnv = {
	port: number;
	databaseUrl: string;
	contentRoot: string;
};

export function readAppEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
	const parsed = EnvSchema.parse(env);
	return {
		port: parsed.PORT,
		databaseUrl: parsed.DATABASE_URL,
		contentRoot: path.resolve(process.cwd(), parsed.REGULAR_RAG_CONTENT_ROOT),
	};
}
