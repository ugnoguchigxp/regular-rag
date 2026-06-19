import { access, mkdir, rename, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { readAppEnv } from "../app/env";

export type DbCliArgs = {
	file: string;
	help: boolean;
};

export const DEFAULT_DB_SEED_FILE = "seed/dev-db.sql.gz";

export function parseDbCliArgs(argv: string[], usage: string): DbCliArgs {
	const args: DbCliArgs = {
		file: DEFAULT_DB_SEED_FILE,
		help: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === "--help" || token === "-h") {
			args.help = true;
			continue;
		}
		if (token === "--file") {
			const file = argv[i + 1];
			if (!file) {
				throw new Error("--file requires a path.");
			}
			args.file = file;
			i += 1;
			continue;
		}
		throw new Error(`Unknown argument for ${usage}: ${token}`);
	}

	return args;
}

export function printDbSeedHelp(command: "db:dump" | "db:seed") {
	if (command === "db:dump") {
		console.log(`Usage: bun run db:dump [options]

Options:
  --file <path>   Output dump path. Defaults to ${DEFAULT_DB_SEED_FILE}.
  -h, --help      Show this help.
`);
		return;
	}

	console.log(`Usage: bun run db:seed [options]

Options:
  --file <path>   Dump SQL path. Defaults to ${DEFAULT_DB_SEED_FILE}.
  -h, --help      Show this help.
`);
}

export function resolveDbTarget() {
	const env = readAppEnv();
	const databaseUrl = new URL(env.databaseUrl);
	const database = databaseUrl.pathname.replace(/^\/+/, "");
	if (!database) {
		throw new Error("DATABASE_URL must include a database name.");
	}

	return {
		databaseUrl: env.databaseUrl,
		database,
		user: decodeURIComponent(databaseUrl.username || "postgres"),
		password: databaseUrl.password
			? decodeURIComponent(databaseUrl.password)
			: undefined,
	};
}

export async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function runCommand(
	command: string,
	args: string[],
	options: {
		stdin?: NodeJS.ReadableStream;
		stdout?: NodeJS.WritableStream;
		env?: NodeJS.ProcessEnv;
	},
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: [
				options.stdin ? "pipe" : "ignore",
				options.stdout ? "pipe" : "inherit",
				"inherit",
			],
			env: options.env,
		});

		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
		});

		if (options.stdin && child.stdin) {
			options.stdin.pipe(child.stdin);
		}
		if (options.stdout && child.stdout) {
			child.stdout.pipe(options.stdout);
		}
	});
}

function compressedSqlFile(filePath: string): boolean {
	return filePath.endsWith(".gz");
}

export async function dockerComposeDbContainerIsRunning(): Promise<boolean> {
	const chunks: Buffer[] = [];
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn("docker", ["compose", "ps", "-q", "db"], {
				stdio: ["ignore", "pipe", "ignore"],
			});
			child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			child.on("error", reject);
			child.on("close", (code) => {
				if (code === 0) {
					resolve();
					return;
				}
				reject(new Error(`docker compose ps exited with ${code}`));
			});
		});
	} catch {
		return false;
	}

	return Buffer.concat(chunks).toString("utf8").trim().length > 0;
}

export async function dumpDatabaseToFile(filePath: string): Promise<void> {
	const target = resolveDbTarget();
	const resolved = path.resolve(process.cwd(), filePath);
	await mkdir(path.dirname(resolved), { recursive: true });
	const tmpPath = `${resolved}.tmp`;
	const output = createWriteStream(tmpPath);
	const gzip = compressedSqlFile(resolved) ? createGzip({ level: 9 }) : null;
	if (gzip) {
		gzip.pipe(output);
	}
	const commandOutput = gzip ?? output;
	const args = [
		"pg_dump",
		"-U",
		target.user,
		"-d",
		target.database,
		"--clean",
		"--if-exists",
		"--no-owner",
		"--no-privileges",
	];

	try {
		if (await dockerComposeDbContainerIsRunning()) {
			await runCommand("docker", ["compose", "exec", "-T", "db", ...args], {
				stdout: commandOutput,
			});
		} else {
			await runCommand("pg_dump", args.slice(1), {
				stdout: commandOutput,
				env: { ...process.env, PGPASSWORD: target.password ?? "" },
			});
		}
		await finished(output);
		await rename(tmpPath, resolved);
	} catch (error) {
		output.destroy();
		await unlink(tmpPath).catch(() => {});
		throw error;
	}
}

export async function restoreDatabaseFromFile(filePath: string): Promise<void> {
	const target = resolveDbTarget();
	const resolved = path.resolve(process.cwd(), filePath);
	if (!(await fileExists(resolved))) {
		throw new Error(`Seed dump not found: ${resolved}`);
	}

	const args = [
		"psql",
		"-U",
		target.user,
		"-d",
		target.database,
		"-v",
		"ON_ERROR_STOP=1",
		"-f",
		"-",
	];
	const input = compressedSqlFile(resolved)
		? createReadStream(resolved).pipe(createGunzip())
		: createReadStream(resolved, { encoding: "utf8" });

	if (await dockerComposeDbContainerIsRunning()) {
		await runCommand("docker", ["compose", "exec", "-T", "db", ...args], {
			stdin: input,
		});
		return;
	}

	await runCommand("psql", args.slice(1), {
		stdin: input,
		env: { ...process.env, PGPASSWORD: target.password ?? "" },
	});
}
