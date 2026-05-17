import { serve } from "@hono/node-server";
import app from "./hono";
import { readAppEnv } from "./env";

const env = readAppEnv();

serve(
	{
		fetch: app.fetch,
		port: env.port,
	},
	(info) => {
		console.log(
			`regular-rag server listening on http://localhost:${info.port}`,
		);
	},
);
