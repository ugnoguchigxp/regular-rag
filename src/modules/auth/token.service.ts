import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { SignJWT, jwtVerify } from "jose";
import type * as schema from "../../db/schema";
import { refreshTokens } from "../../db/schema";
import type { AppEnv } from "../../app/env";
import { HttpError } from "./errors";
import { jwtPayloadSchema, type JwtPayload } from "./types";

const hashToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

const secretKey = (jwtSecret: string): Uint8Array =>
	new TextEncoder().encode(jwtSecret);

type JwtCorePayload = Omit<JwtPayload, "type">;

export async function generateAccessToken(
	payload: JwtCorePayload,
	env: AppEnv,
): Promise<string> {
	return new SignJWT({ ...payload, type: "access" })
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime(env.jwtAccessExpiresIn)
		.sign(secretKey(env.jwtSecret));
}

export async function generateRefreshToken(
	payload: JwtCorePayload,
	db: NodePgDatabase<typeof schema>,
	env: AppEnv,
): Promise<string> {
	const token = await new SignJWT({ ...payload, type: "refresh" })
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime(env.jwtRefreshExpiresIn)
		.sign(secretKey(env.jwtSecret));

	const verified = await jwtVerify(token, secretKey(env.jwtSecret));
	const exp = verified.payload.exp;
	if (typeof exp !== "number") {
		throw new HttpError(500, "Failed to parse refresh token expiration.");
	}
	await db.insert(refreshTokens).values({
		token: hashToken(token),
		userId: payload.userId,
		expiresAt: new Date(exp * 1000),
	});

	return token;
}

export async function verifyAccessToken(
	token: string,
	env: AppEnv,
): Promise<JwtPayload> {
	const verified = await jwtVerify(token, secretKey(env.jwtSecret));
	if (verified.payload.type !== "access") {
		throw new Error("Invalid access token type.");
	}
	return jwtPayloadSchema.parse(verified.payload);
}

export async function consumeRefreshToken(
	token: string,
	db: NodePgDatabase<typeof schema>,
	env: AppEnv,
): Promise<JwtPayload> {
	const tokenHash = hashToken(token);
	const [deleted] = await db
		.delete(refreshTokens)
		.where(eq(refreshTokens.token, tokenHash))
		.returning({
			userId: refreshTokens.userId,
			expiresAt: refreshTokens.expiresAt,
		});

	if (!deleted) {
		throw new HttpError(401, "Invalid refresh token.");
	}
	if (new Date() > deleted.expiresAt) {
		throw new HttpError(401, "Refresh token expired.");
	}

	const verified = await jwtVerify(token, secretKey(env.jwtSecret));
	if (verified.payload.type !== "refresh") {
		throw new HttpError(401, "Invalid refresh token.");
	}
	const payload = jwtPayloadSchema.parse(verified.payload);
	if (payload.userId !== deleted.userId) {
		throw new HttpError(401, "Invalid refresh token.");
	}
	return payload;
}

export async function revokeRefreshToken(
	token: string,
	db: NodePgDatabase<typeof schema>,
): Promise<void> {
	await db
		.delete(refreshTokens)
		.where(eq(refreshTokens.token, hashToken(token)));
}

export async function revokeAllRefreshTokensForUser(
	userId: string,
	db: NodePgDatabase<typeof schema>,
): Promise<void> {
	await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
}
