import path from "node:path";
import devServer from "@hono/vite-dev-server";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
	// Load env file from project root (one level up from 'web' root)
	const env = loadEnv(mode, __dirname, "");
	Object.assign(process.env, env);

	return {
		root: "web",
		plugins: [
			tailwindcss(),
			react(),
			devServer({
				entry: path.resolve(__dirname, "src/app/hono.ts"),
				exclude: [/^\/(?!api(?:\/|$)).*/],
				injectClientScript: false,
			}),
		],
		resolve: {
			alias: {
				"@": path.resolve(__dirname, "./web/src"),
				"@web": path.resolve(__dirname, "./web/src"),
				"@server": path.resolve(__dirname, "./src"),
			},
		},
		server: {
			port: 5173,
		},
		optimizeDeps: {
			include: ["dayjs"],
			exclude: ["markdown-wysiwyg-editor"],
		},
		build: {
			outDir: "../dist-web",
			emptyOutDir: true,
		},
	};
});
