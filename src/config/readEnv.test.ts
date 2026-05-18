import { describe, expect, it } from "vitest";

import { APP_CONFIG_DEFAULTS } from "./appDefaults";
import { readEnv } from "./readEnv";

describe("readEnv", () => {
	it("returns shared defaults", () => {
		expect(readEnv()).toEqual({
			host: APP_CONFIG_DEFAULTS.host,
			port: APP_CONFIG_DEFAULTS.port,
			databaseUrl: APP_CONFIG_DEFAULTS.databaseUrl,
		});
	});
});
