import {
	parseDbCliArgs,
	printDbSeedHelp,
	restoreDatabaseFromFile,
} from "./db-dump-helpers";

async function main() {
	const args = parseDbCliArgs(process.argv.slice(2), "db:seed");
	if (args.help) {
		printDbSeedHelp("db:seed");
		return;
	}

	await restoreDatabaseFromFile(args.file);
	console.log(
		JSON.stringify(
			{
				ok: true,
				file: args.file,
			},
			null,
			2,
		),
	);
}

await main();
