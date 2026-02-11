import { EMBEDDING_DIMENSIONS } from "../db/schema";
import type { EmbeddingProvider, LlmProvider } from "../providers/types";
import type {
	KnowledgeGraphRepository,
	TraversalResult,
} from "../repositories/KnowledgeGraphRepository";

import { GraphExtractor } from "./GraphExtractor";

/**
 * Knowledge Graph の構築・検索・RAGコンテキスト生成を担うサービス
 */
export class KnowledgeGraphService {
	private extractor: GraphExtractor;

	constructor(
		private graphRepo: KnowledgeGraphRepository,
		llmProvider: LlmProvider,
		private embeddingProvider?: EmbeddingProvider,
		private expectedEmbeddingDimensions = EMBEDDING_DIMENSIONS,
	) {
		this.extractor = new GraphExtractor(llmProvider);
	}

	// ─── Graph Construction ──────────────────────────────────────────

	/**
	 * テキストからエンティティ・関係を抽出し、Knowledge Graph に登録する
	 */
	async buildGraphFromDocument(content: string): Promise<{
		nodesCreated: number;
		edgesCreated: number;
	}> {
		const extraction = await this.extractor.extract(content);

		let nodesCreated = 0;
		let edgesCreated = 0;

		// embedding を一括生成
		const embeddingResults = this.embeddingProvider
			? await Promise.all(
					extraction.entities.map((e) =>
						this.embeddingProvider
							?.createEmbedding(e.name)
							.catch(() => undefined),
					),
				)
			: extraction.entities.map(() => undefined);

		// ノード登録
		const nameToId = new Map<string, string>();
		for (let i = 0; i < extraction.entities.length; i++) {
			const entity = extraction.entities[i];
			const embedding = embeddingResults[i];
			const nodeId = GraphExtractor.generateNodeId(entity.name, entity.type);
			nameToId.set(entity.name.toLowerCase(), nodeId);

			if (embedding && embedding.length !== this.expectedEmbeddingDimensions) {
				throw new Error(
					`Embedding dimension mismatch: expected ${this.expectedEmbeddingDimensions}, got ${embedding.length}`,
				);
			}

			await this.graphRepo.upsertNode({
				id: nodeId,
				name: entity.name,
				type: entity.type,
				properties: entity.properties ?? {},
				embedding,
			});
			nodesCreated++;
		}

		// エッジ登録
		for (const relation of extraction.relations) {
			const sourceId = nameToId.get(relation.source.toLowerCase());
			const targetId = nameToId.get(relation.target.toLowerCase());

			if (!sourceId || !targetId) continue;

			const edgeId = GraphExtractor.generateEdgeId(
				sourceId,
				targetId,
				relation.relationType,
			);

			await this.graphRepo.upsertEdge({
				id: edgeId,
				sourceId,
				targetId,
				relationType: relation.relationType,
				weight: relation.weight ?? 1.0,
			});
			edgesCreated++;
		}

		return { nodesCreated, edgesCreated };
	}

	// ─── RAG Context Generation ──────────────────────────────────────

	/**
	 * エンティティ名のリストからグラフコンテキストを生成する（RAG用）
	 */
	async getContextForEntities(entities: string[]): Promise<string | null> {
		if (entities.length === 0) return null;

		// 1. ノード名から一括で ID を取得
		const validNodes = await this.graphRepo.findNodesByNames(entities);
		if (validNodes.length === 0) return null;

		const nodeIds = validNodes.map((n) => n.id);
		// 2. 一括で 2ホップ探索
		const traversalResults = await this.graphRepo.traverseBatch(nodeIds, 2);

		// 3. 開始ノードごとに結果をグルーピング（コンテキスト生成のため）
		// traverseBatch は「どのノードからの探索結果か」を返さないため、
		// 実際には全エンティティを一つの「知識グラフ」としてまとめるのが効率的

		let context = `[Knowledge Graph Context for: ${validNodes.map((n) => n.name).join(", ")}]\n`;

		// ノードの属性情報
		for (const node of validNodes) {
			if (
				node.properties &&
				Object.keys(node.properties as object).length > 0
			) {
				context += `- ${node.name} (${node.type}): ${JSON.stringify(node.properties)}\n`;
			}
		}

		// 関連情報の生成
		const byDepth = new Map<number, TraversalResult[]>();
		for (const t of traversalResults) {
			const arr = byDepth.get(t.depth) ?? [];
			arr.push(t);
			byDepth.set(t.depth, arr);
		}

		for (const [depth, items] of byDepth) {
			context += `\nDepth ${depth} relations:\n`;
			for (const item of items) {
				const arrow = item.direction === "outgoing" ? "→" : "←";
				context += `- ${arrow} [${item.relation}] ${item.node.name} (${item.node.type})\n`;
			}
		}

		return context;
	}

	/**
	 * 2つのエンティティ間の関係パスを探してコンテキスト化する
	 */
	async getPathContext(
		fromName: string,
		toName: string,
	): Promise<string | null> {
		const fromNode = await this.graphRepo.findNodeByName(fromName);
		const toNode = await this.graphRepo.findNodeByName(toName);

		if (!fromNode || !toNode) return null;

		const paths = await this.graphRepo.findPaths(fromNode.id, toNode.id, 5);

		if (paths.length === 0) return null;

		let context = `[Relationship Path: "${fromName}" → "${toName}"]\n`;
		for (let i = 0; i < paths.length; i++) {
			const path = paths[i];
			context += `Path ${i + 1} (weight: ${path.totalWeight.toFixed(2)}):\n`;
			for (let j = 0; j < path.path.length; j++) {
				const node = path.path[j];
				context += `  ${node.name} (${node.type})`;
				if (j < path.relations.length) {
					context += ` --[${path.relations[j]}]--> `;
				}
			}
			context += "\n";
		}

		return context;
	}

	/**
	 * サブグラフをコンテキスト化する
	 */
	async getSubgraphContext(entityNames: string[]): Promise<string | null> {
		if (entityNames.length === 0) return null;

		const nodes = await Promise.all(
			entityNames.map((name) => this.graphRepo.findNodeByName(name)),
		);
		const nodeIds = nodes
			.filter((n): n is NonNullable<typeof n> => n != null)
			.map((n) => n.id);

		const subgraph = await this.graphRepo.getSubgraph(nodeIds, 1);

		const nodeMap = new Map(subgraph.nodes.map((n) => [n.id, n]));

		let context = `[Knowledge Subgraph]\n`;
		context += `Nodes (${subgraph.nodes.length}):\n`;
		for (const node of subgraph.nodes) {
			context += `  - ${node.name} (${node.type})\n`;
		}
		context += `Relations (${subgraph.edges.length}):\n`;
		for (const edge of subgraph.edges) {
			const srcNode = nodeMap.get(edge.sourceId);
			const tgtNode = nodeMap.get(edge.targetId);
			context += `  - ${srcNode?.name ?? edge.sourceId} --[${edge.relationType}]--> ${tgtNode?.name ?? edge.targetId}\n`;
		}

		return context;
	}
}
