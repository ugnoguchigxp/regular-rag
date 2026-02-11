import { describe, expect, it } from "vitest";

import { normalizeSearchPlan } from "./llm";

describe("normalizeSearchPlan", () => {
	it("fills default top_k when missing", () => {
		const normalized = normalizeSearchPlan({
			should_search: true,
			search_query: "dialysis",
		});
		expect(normalized.top_k).toBe(5);
	});

	it("clamps and floors top_k into allowed range", () => {
		const low = normalizeSearchPlan({
			should_search: true,
			search_query: "q",
			top_k: -3,
		});
		const high = normalizeSearchPlan({
			should_search: true,
			search_query: "q",
			top_k: 100,
		});
		const decimal = normalizeSearchPlan({
			should_search: true,
			search_query: "q",
			top_k: 4.9,
		});

		expect(low.top_k).toBe(1);
		expect(high.top_k).toBe(8);
		expect(decimal.top_k).toBe(4);
	});
});
