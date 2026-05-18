import { readAppEnv } from "../app/env";
import { createWikiBlobSyncer } from "../modules/sources/wiki/blob-sync";

type Direction = "pull" | "push";

type CliOptions = {
	direction: Direction;
};

function parseCliOptions(argv: string[]): CliOptions {
	let direction: Direction = "pull";
	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") {
			console.log(`Usage: bun run src/cli/wiki-blob-sync.ts [options]

Options:
  --direction=pull|push   Sync direction. Defaults to pull.
  -h, --help              Show this help.
`);
			process.exit(0);
		}
		if (arg.startsWith("--direction=")) {
			const value = arg.slice("--direction=".length).trim();
			if (value !== "pull" && value !== "push") {
				throw new Error("--direction must be pull or push.");
			}
			direction = value;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	return { direction };
}

async function main() {
	const options = parseCliOptions(process.argv.slice(2));
	const env = readAppEnv();
	const syncer = createWikiBlobSyncer(env);
	if (!syncer) {
		console.log(
			JSON.stringify(
				{
					ok: true,
					enabled: false,
					message: "WIKI_STORAGE_BACKEND is not azure-blob.",
				},
				null,
				2,
			),
		);
		return;
	}

	const result =
		options.direction === "pull"
			? await syncer.pull({ force: true })
			: await syncer.push();
	console.log(
		JSON.stringify(
			{
				ok: true,
				contentRoot: env.contentRoot,
				...result,
			},
			null,
			2,
		),
	);
}

await main();
