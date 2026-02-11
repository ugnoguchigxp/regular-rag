import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { knowledgeEdges, knowledgeNodes } from "../db/schema";

// ─── Types ───────────────────────────────────────────────────────────

export interface GraphNode {
	id: string;
	name: string;
	type: string;
	properties: Record<string, unknown>;
}

export interface GraphEdge {
	id: string;
	sourceId: string;
	targetId: string;
	relationType: string;
	weight: number;
	properties: Record<string, unknown>;
}

export interface TraversalResult {
	node: GraphNode;
	relation: string;
	depth: number;
	direction: "outgoing" | "incoming";
}

export interface SubgraphResult {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface PathResult {
	path: GraphNode[];
	relations: string[];
	totalWeight: number;
}

// ─── Internal Types ──────────────────────────────────────────────────
interface NodeRow {
	id: string;
	name: string;
	type: string;
	properties: Record<string, unknown>;
}

interface TraversalRow extends NodeRow {
	relation: string;
	depth: number;
	direction: string;
}

// ─── Repository ──────────────────────────────────────────────────────

export class KnowledgeGraphRepository {
	constructor(private db: NodePgDatabase<typeof schema>) {}

	// ─── Node CRUD ───────────────────────────────────────────────────

	async upsertNode(node: {
		id: string;
		name: string;
		type: string;
		properties?: Record<string, unknown>;
		embedding?: number[];
	}) {
		await this.db
			.insert(knowledgeNodes)
			.values({
				id: node.id,
				name: node.name,
				type: node.type,
				properties: node.properties ?? {},
				embedding: node.embedding,
			})
			.onConflictDoUpdate({
				target: knowledgeNodes.id,
				set: {
					name: node.name,
					type: node.type,
					properties: node.properties ?? {},
					embedding: node.embedding,
					updatedAt: sql`now()`,
				},
			});
	}

	async deleteNode(nodeId: string) {
		await this.db.delete(knowledgeNodes).where(eq(knowledgeNodes.id, nodeId));
	}

	async findNodeByName(name: string) {
		return await this.db.query.knowledgeNodes.findFirst({
			where: eq(knowledgeNodes.name, name),
		});
	}

	async findNodeById(id: string) {
		return await this.db.query.knowledgeNodes.findFirst({
			where: eq(knowledgeNodes.id, id),
		});
	}

	async findNodesByNames(names: string[]) {
		if (names.length === 0) return [];
		return await this.db.query.knowledgeNodes.findMany({
			where: inArray(knowledgeNodes.name, names),
		});
	}

	// ─── Edge CRUD ───────────────────────────────────────────────────

	async upsertEdge(edge: {
		id: string;
		sourceId: string;
		targetId: string;
		relationType: string;
		weight?: number;
		properties?: Record<string, unknown>;
	}) {
		await this.db
			.insert(knowledgeEdges)
			.values({
				id: edge.id,
				sourceId: edge.sourceId,
				targetId: edge.targetId,
				relationType: edge.relationType,
				weight: edge.weight ?? 1.0,
				properties: edge.properties ?? {},
			})
			.onConflictDoUpdate({
				target: knowledgeEdges.id,
				set: {
					relationType: edge.relationType,
					weight: edge.weight ?? 1.0,
					properties: edge.properties ?? {},
				},
			});
	}

	async deleteEdge(edgeId: string) {
		await this.db.delete(knowledgeEdges).where(eq(knowledgeEdges.id, edgeId));
	}

	// ─── Search ──────────────────────────────────────────────────────
	private escapeLike(str: string): string {
		return str.replace(/[%_\\]/g, "\\$&");
	}

	async searchNodes(query: string, limit = 10): Promise<GraphNode[]> {
		const result = await this.db
			.select({
				id: knowledgeNodes.id,
				name: knowledgeNodes.name,
				type: knowledgeNodes.type,
				properties: knowledgeNodes.properties,
			})
			.from(knowledgeNodes)
			.where(ilike(knowledgeNodes.name, `%${this.escapeLike(query)}%`))
			.limit(limit);

		return result.map((r) => ({
			...r,
			properties: (r.properties ?? {}) as Record<string, unknown>,
		}));
	}

	// ─── Neighbors (1-hop) ───────────────────────────────────────────

	async getNeighbors(nodeId: string) {
		const outgoing = await this.db
			.select({
				node: {
					id: knowledgeNodes.id,
					name: knowledgeNodes.name,
					type: knowledgeNodes.type,
					properties: knowledgeNodes.properties,
				},
				relation: knowledgeEdges.relationType,
				weight: knowledgeEdges.weight,
			})
			.from(knowledgeEdges)
			.innerJoin(knowledgeNodes, eq(knowledgeEdges.targetId, knowledgeNodes.id))
			.where(eq(knowledgeEdges.sourceId, nodeId));

		const incoming = await this.db
			.select({
				node: {
					id: knowledgeNodes.id,
					name: knowledgeNodes.name,
					type: knowledgeNodes.type,
					properties: knowledgeNodes.properties,
				},
				relation: knowledgeEdges.relationType,
				weight: knowledgeEdges.weight,
			})
			.from(knowledgeEdges)
			.innerJoin(knowledgeNodes, eq(knowledgeEdges.sourceId, knowledgeNodes.id))
			.where(eq(knowledgeEdges.targetId, nodeId));

		return { outgoing, incoming };
	}

	// ─── Multi-hop Traversal (再帰CTE) ──────────────────────────────

	async traverse(nodeId: string, maxDepth = 3): Promise<TraversalResult[]> {
		return this.traverseBatch([nodeId], maxDepth);
	}

	async traverseBatch(
		nodeIds: string[],
		maxDepth = 3,
	): Promise<TraversalResult[]> {
		if (nodeIds.length === 0) return [];

		const result = await this.db.execute(sql`
            WITH RECURSIVE graph_traverse AS (
                -- Base case: direct neighbors of any input node
                SELECT
                    n.id,
                    n.name,
                    n.type,
                    n.properties,
                    e.relation_type AS relation,
                    1 AS depth,
                    CASE WHEN e.source_id = ANY(${nodeIds}) THEN 'outgoing' ELSE 'incoming' END AS direction,
                    ARRAY[n.id] AS path,
                    CASE WHEN e.source_id = ANY(${nodeIds}) THEN e.source_id ELSE e.target_id END AS start_node_id
                FROM knowledge_edges e
                JOIN knowledge_nodes n ON (
                    CASE WHEN e.source_id = ANY(${nodeIds}) THEN e.target_id ELSE e.source_id END = n.id
                )
                WHERE e.source_id = ANY(${nodeIds}) OR e.target_id = ANY(${nodeIds})

                UNION ALL

                -- Recursive case
                SELECT
                    n2.id,
                    n2.name,
                    n2.type,
                    n2.properties,
                    e2.relation_type AS relation,
                    gt.depth + 1 AS depth,
                    CASE WHEN e2.source_id = gt.id THEN 'outgoing' ELSE 'incoming' END AS direction,
                    gt.path || n2.id AS path,
                    gt.start_node_id
                FROM graph_traverse gt
                JOIN knowledge_edges e2 ON (e2.source_id = gt.id OR e2.target_id = gt.id)
                JOIN knowledge_nodes n2 ON (
                    CASE WHEN e2.source_id = gt.id THEN e2.target_id ELSE e2.source_id END = n2.id
                )
                WHERE gt.depth < ${maxDepth}
                    AND NOT (n2.id = ANY(gt.path))  -- cycle prevention
                    AND NOT (n2.id = gt.start_node_id) -- don't go back to start
            )
            SELECT DISTINCT ON (id) id, name, type, properties, relation, depth, direction
            FROM graph_traverse
            ORDER BY id, depth ASC
        `);

		return (result.rows as unknown as TraversalRow[]).map((row) => ({
			node: {
				id: row.id,
				name: row.name,
				type: row.type,
				properties: row.properties ?? {},
			},
			relation: row.relation,
			depth: row.depth,
			direction: row.direction as "outgoing" | "incoming",
		}));
	}

	// ─── Subgraph Extraction ─────────────────────────────────────────

	async getSubgraph(nodeIds: string[], maxDepth = 1): Promise<SubgraphResult> {
		if (nodeIds.length === 0) return { nodes: [], edges: [] };

		// Collect all related nodes via batch traversal
		const traversal = await this.traverseBatch(nodeIds, maxDepth);
		const allNodeIds = new Set([
			...nodeIds,
			...traversal.map((t) => t.node.id),
		]);
		const nodeIdArray = Array.from(allNodeIds);

		// Fetch nodes
		const nodes = await this.db
			.select({
				id: knowledgeNodes.id,
				name: knowledgeNodes.name,
				type: knowledgeNodes.type,
				properties: knowledgeNodes.properties,
			})
			.from(knowledgeNodes)
			.where(inArray(knowledgeNodes.id, nodeIdArray));

		// Fetch edges between these nodes
		const edges = await this.db
			.select({
				id: knowledgeEdges.id,
				sourceId: knowledgeEdges.sourceId,
				targetId: knowledgeEdges.targetId,
				relationType: knowledgeEdges.relationType,
				weight: knowledgeEdges.weight,
				properties: knowledgeEdges.properties,
			})
			.from(knowledgeEdges)
			.where(
				and(
					inArray(knowledgeEdges.sourceId, nodeIdArray),
					inArray(knowledgeEdges.targetId, nodeIdArray),
				),
			);

		return {
			nodes: nodes.map((n) => ({
				...n,
				properties: (n.properties ?? {}) as Record<string, unknown>,
			})),
			edges: edges.map((e) => ({
				...e,
				weight: e.weight ?? 1.0,
				properties: (e.properties ?? {}) as Record<string, unknown>,
			})),
		};
	}

	// ─── Path Finding (再帰CTE) ─────────────────────────────────────

	async findPaths(
		fromId: string,
		toId: string,
		maxDepth = 5,
	): Promise<PathResult[]> {
		const result = await this.db.execute(sql`
            WITH RECURSIVE path_search AS (
                -- Base case
                SELECT
                    ARRAY[${fromId}] AS node_path,
                    ARRAY[]::text[] AS relations,
                    0::real AS total_weight,
                    ${fromId} AS current_id,
                    0 AS depth
                
                UNION ALL

                -- Recursive step
                SELECT
                    ps.node_path || n.id,
                    ps.relations || e.relation_type,
                    ps.total_weight + COALESCE(e.weight, 1.0),
                    n.id,
                    ps.depth + 1
                FROM path_search ps
                JOIN knowledge_edges e ON (e.source_id = ps.current_id OR e.target_id = ps.current_id)
                JOIN knowledge_nodes n ON (
                    CASE WHEN e.source_id = ps.current_id THEN e.target_id ELSE e.source_id END = n.id
                )
                WHERE ps.depth < ${maxDepth}
                    AND NOT (n.id = ANY(ps.node_path))  -- cycle prevention
            )
            SELECT node_path, relations, total_weight
            FROM path_search
            WHERE current_id = ${toId}
            ORDER BY total_weight ASC
            LIMIT 5
        `);

		interface PathRow {
			node_path: string[];
			relations: string[];
			total_weight: number;
		}

		const rows = result.rows as unknown as PathRow[];
		if (rows.length === 0) return [];

		// Collect all unique node IDs across all paths
		const allNodeIdsInPaths = Array.from(
			new Set(rows.flatMap((r) => r.node_path)),
		);

		const nodeResults = await this.db
			.select({
				id: knowledgeNodes.id,
				name: knowledgeNodes.name,
				type: knowledgeNodes.type,
				properties: knowledgeNodes.properties,
			})
			.from(knowledgeNodes)
			.where(inArray(knowledgeNodes.id, allNodeIdsInPaths));

		const nodeMap = new Map(nodeResults.map((n) => [n.id, n]));

		return rows.map((row) => ({
			path: row.node_path
				.map((id) => nodeMap.get(id))
				.filter((n): n is NonNullable<typeof n> => n != null)
				.map((n) => ({
					...n,
					properties: (n.properties ?? {}) as Record<string, unknown>,
				})),
			relations: row.relations,
			totalWeight: row.total_weight,
		}));
	}
}
