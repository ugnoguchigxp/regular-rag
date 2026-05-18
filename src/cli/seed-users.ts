import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { readAppEnv } from "../app/env";
import { createDbConnection } from "../db";
import { refreshTokens, users } from "../db/schema";
import { hashPassword } from "../modules/auth/password";
import { userRoleSchema } from "../modules/auth/types";

type CliArgs = {
	file: string;
	generateMissingPasswords: boolean;
	help: boolean;
};

const seedUserSchema = z.object({
	email: z.string().email(),
	displayName: z.string().min(1),
	role: userRoleSchema.default("member"),
	isActive: z.boolean().default(true),
	password: z.string().min(8).optional(),
	passwordEnv: z.string().min(1).optional(),
});

const seedUsersSchema = z.array(seedUserSchema).min(1);

type SeedUser = z.infer<typeof seedUserSchema>;

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		file: "seed/users.json",
		generateMissingPasswords: false,
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
		if (token === "--generate-missing-passwords") {
			args.generateMissingPasswords = true;
			continue;
		}
		throw new Error(`Unknown argument: ${token}`);
	}

	return args;
}

function printHelp() {
	console.log(`Usage: bun run db:seed:users [options]

Options:
  --file <path>                  Seed JSON path. Defaults to seed/users.json.
  --generate-missing-passwords   Generate passwords when passwordEnv is unset or empty.
  -h, --help                     Show this help.

Password sources:
  - password in seed JSON
  - environment variable named by passwordEnv
  - generated password with --generate-missing-passwords
`);
}

async function readSeedUsers(filePath: string): Promise<SeedUser[]> {
	const resolved = path.resolve(process.cwd(), filePath);
	const raw = await readFile(resolved, "utf8");
	return seedUsersSchema.parse(JSON.parse(raw));
}

function generatePassword(): string {
	return `rr_${randomBytes(18).toString("base64url")}`;
}

function resolvePassword(
	user: SeedUser,
	generateMissingPasswords: boolean,
): { password: string; source: "file" | "env" | "generated" } {
	if (user.password) {
		return { password: user.password, source: "file" };
	}
	if (user.passwordEnv) {
		const envPassword = process.env[user.passwordEnv]?.trim();
		if (envPassword) {
			if (envPassword.length < 8) {
				throw new Error(
					`${user.passwordEnv} for ${user.email} must be at least 8 characters.`,
				);
			}
			return { password: envPassword, source: "env" };
		}
	}
	if (generateMissingPasswords) {
		return { password: generatePassword(), source: "generated" };
	}

	const source = user.passwordEnv
		? `environment variable ${user.passwordEnv}`
		: "password";
	throw new Error(
		`Missing password for ${user.email}. Set ${source} or pass --generate-missing-passwords.`,
	);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}

	const seedUsers = await readSeedUsers(args.file);
	const hasActiveAdmin = seedUsers.some(
		(user) => user.role === "admin" && user.isActive,
	);
	if (!hasActiveAdmin) {
		throw new Error("Seed data must include at least one active admin user.");
	}

	const env = readAppEnv();
	const db = createDbConnection(env.databaseUrl);
	const results: Array<{
		email: string;
		displayName: string;
		role: "admin" | "member";
		isActive: boolean;
		action: "created" | "updated";
		passwordSource: "file" | "env" | "generated";
		generatedPassword?: string;
	}> = [];

	try {
		for (const seedUser of seedUsers) {
			const normalizedEmail = seedUser.email.toLowerCase();
			const password = resolvePassword(seedUser, args.generateMissingPasswords);
			const passwordHash = await hashPassword(password.password);
			const existing = await db.db.query.users.findFirst({
				where: eq(users.email, normalizedEmail),
			});

			if (existing) {
				await db.db
					.update(users)
					.set({
						displayName: seedUser.displayName,
						role: seedUser.role,
						isActive: seedUser.isActive,
						passwordHash,
						updatedAt: new Date(),
					})
					.where(eq(users.id, existing.id));
				await db.db
					.delete(refreshTokens)
					.where(eq(refreshTokens.userId, existing.id));
				results.push({
					email: normalizedEmail,
					displayName: seedUser.displayName,
					role: seedUser.role,
					isActive: seedUser.isActive,
					action: "updated",
					passwordSource: password.source,
					...(password.source === "generated"
						? { generatedPassword: password.password }
						: {}),
				});
				continue;
			}

			await db.db.insert(users).values({
				email: normalizedEmail,
				passwordHash,
				displayName: seedUser.displayName,
				role: seedUser.role,
				isActive: seedUser.isActive,
			});
			results.push({
				email: normalizedEmail,
				displayName: seedUser.displayName,
				role: seedUser.role,
				isActive: seedUser.isActive,
				action: "created",
				passwordSource: password.source,
				...(password.source === "generated"
					? { generatedPassword: password.password }
					: {}),
			});
		}

		const [activeAdminCount] = await db.db
			.select({ count: sql<number>`cast(count(*) as integer)` })
			.from(users)
			.where(and(eq(users.role, "admin"), eq(users.isActive, true)));
		if (!activeAdminCount || activeAdminCount.count < 1) {
			throw new Error("Seed completed without any active admin user.");
		}

		console.log(
			JSON.stringify(
				{
					ok: true,
					users: results,
				},
				null,
				2,
			),
		);
	} finally {
		if (db.ownsConnection) {
			await db.pgClient.end();
		}
	}
}

await main();
