import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { SourceRepository } from "./source.repository";

export type MarkdownImportResult = {
	importedFiles: number;
	skippedFiles: number;
	removedSources: number;
	files: Array<{ path: string; sourceId: string }>;
};

function firstMarkdownHeading(body: string): string | null {
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("#")) continue;
		const title = trimmed.replace(/^#+\s*/, "").trim();
		if (title) return title;
	}
	return null;
}

export async function collectMarkdownFiles(
	contentRoot: string,
): Promise<string[]> {
	const pagesRoot = path.resolve(contentRoot, "pages");
	const files: string[] = [];

	const walk = async (dir: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.resolve(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}
			if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				files.push(fullPath);
			}
		}
	};

	await walk(pagesRoot);
	return files.sort();
}

export async function importMarkdownDirectory(params: {
	contentRoot: string;
	sourceRepository: SourceRepository;
}): Promise<MarkdownImportResult> {
	const markdownFiles = await collectMarkdownFiles(params.contentRoot);
	const results: MarkdownImportResult = {
		importedFiles: 0,
		skippedFiles: 0,
		removedSources: 0,
		files: [],
	};

	for (const filePath of markdownFiles) {
		const content = await readFile(filePath, "utf8");
		if (!content.trim()) {
			results.skippedFiles += 1;
			continue;
		}

		const hash = createHash("sha256").update(content).digest("hex");
		const title =
			firstMarkdownHeading(content) ?? path.basename(filePath, ".md");
		const sourceId = await params.sourceRepository.upsertSourceDocument({
			sourceKind: "wiki",
			uri: filePath,
			title,
			body: content,
			contentHash: hash,
			metadata: {
				relativePath: path.relative(params.contentRoot, filePath),
				importedAt: new Date().toISOString(),
			},
		});

		results.importedFiles += 1;
		results.files.push({ path: filePath, sourceId });
	}

	results.removedSources =
		await params.sourceRepository.deleteStaleSourcesForRoot({
			rootPath: params.contentRoot,
			keepUris: results.files.map((item) => item.path),
		});

	return results;
}
