import {
	dumpDatabaseToFile,
	parseDbCliArgs,
	printDbSeedHelp,
} from "./db-dump-helpers";

async function main() {
	const args = parseDbCliArgs(process.argv.slice(2), "db:dump");
	if (args.help) {
		printDbSeedHelp("db:dump");
		return;
	}

	await dumpDatabaseToFile(args.file);
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
