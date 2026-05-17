import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectMarkdownFiles } from "./markdown-importer.service";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async (dir) => {
			await rm(dir, { recursive: true, force: true });
		}),
	);
});

describe("collectMarkdownFiles", () => {
	it("collects markdown files recursively under pages/", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "regular-rag-importer-"));
		tempDirs.push(root);
		const pagesRoot = path.join(root, "pages");
		await mkdir(path.join(pagesRoot, "a", "b"), { recursive: true });

		await writeFile(path.join(pagesRoot, "index.md"), "# Home\n", "utf8");
		await writeFile(path.join(pagesRoot, "a", "nested.md"), "# Nested\n", "utf8");
		await writeFile(path.join(pagesRoot, "a", "b", "deep.md"), "# Deep\n", "utf8");
		await writeFile(path.join(pagesRoot, "a", "note.txt"), "ignore", "utf8");

		const files = await collectMarkdownFiles(root);
		expect(files).toEqual(
			[
				path.join(pagesRoot, "a", "b", "deep.md"),
				path.join(pagesRoot, "a", "nested.md"),
				path.join(pagesRoot, "index.md"),
			].sort((x, y) => x.localeCompare(y)),
		);
	});
});
