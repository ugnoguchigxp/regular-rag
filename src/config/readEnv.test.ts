import { describe, expect, it } from "vitest";

import { readEnv } from "./readEnv";

describe("readEnv", () => {
	it("throws when DATABASE_URL is missing", () => {
		expect(() => readEnv({})).toThrowError("DATABASE_URL is required");
	});

	it("uses default port when PORT is not provided", () => {
		const result = readEnv({ DATABASE_URL: "postgres://example" });
		expect(result).toEqual({
			port: 3000,
			databaseUrl: "postgres://example",
		});
	});

	it("parses PORT as number", () => {
		const result = readEnv({
			DATABASE_URL: "postgres://example",
			PORT: "8080",
		});
		expect(result.port).toBe(8080);
	});

	it("throws when PORT is invalid", () => {
		expect(() =>
			readEnv({
				DATABASE_URL: "postgres://example",
				PORT: "0",
			}),
		).toThrowError("PORT must be a positive number");

		expect(() =>
			readEnv({
				DATABASE_URL: "postgres://example",
				PORT: "not-a-number",
			}),
		).toThrowError("PORT must be a positive number");
	});
});
