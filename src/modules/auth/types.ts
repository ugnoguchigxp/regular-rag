import { z } from "zod";

export const userRoleSchema = z.enum(["admin", "member"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const jwtPayloadSchema = z.object({
	userId: z.string().uuid(),
	email: z.string().email(),
	role: userRoleSchema,
	type: z.enum(["access", "refresh"]),
});
export type JwtPayload = z.infer<typeof jwtPayloadSchema>;

export type AuthUser = {
	id: string;
	email: string;
	passwordHash: string;
	displayName: string;
	role: UserRole;
	isActive: boolean;
	lastLoginAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

export type AuthSessionUser = Pick<
	AuthUser,
	"id" | "email" | "displayName" | "role"
>;
