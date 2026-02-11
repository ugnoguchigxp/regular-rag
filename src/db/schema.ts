import { sql } from "drizzle-orm";
import {
	customType,
	index,
	integer,
	jsonb,
	pgTable,
	real,
	text,
	timestamp,
	vector,
} from "drizzle-orm/pg-core";

export const EMBEDDING_DIMENSIONS = 1536;

const tsvector = customType<{ data: string }>({
	dataType() {
		return "tsvector";
	},
});

export const ragDocuments = pgTable(
	"rag_documents",
	{
		id: text("id").primaryKey(),
		content: text("content").notNull(),
		path: text("path"),
		metadata: jsonb("metadata"),
		screen: text("screen"),
		domain: text("domain"),
		embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
		tsv: tsvector("tsv"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
	},
	(table) => ({
		pathIdx: index("idx_rag_documents_path").on(table.path),
		screenIdx: index("idx_rag_documents_screen").on(table.screen),
		tsvIdx: index("idx_rag_documents_tsv").using("gin", sql`${table.tsv}`),
	}),
);

export const chatbotCache = pgTable("chatbot_cache", {
	id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
	requestHash: text("request_hash").notNull().unique(),
	question: text("question").notNull(),
	context: jsonb("context"),
	response: text("response").notNull(),
	hitCount: integer("hit_count").default(0).notNull(),
	lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const knowledgeNodes = pgTable(
	"knowledge_nodes",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		type: text("type").notNull(), // 'entity', 'concept', 'topic', 'person', 'drug', etc.
		properties: jsonb("properties").default({}),
		embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
	},
	(table) => ({
		nameIdx: index("idx_nodes_name").on(table.name),
		nameTrgmIdx: index("idx_nodes_name_trgm").using(
			"gin",
			sql`${table.name} gin_trgm_ops`,
		),
		typeIdx: index("idx_nodes_type").on(table.type),
	}),
);

export const knowledgeEdges = pgTable(
	"knowledge_edges",
	{
		id: text("id").primaryKey(),
		sourceId: text("source_id")
			.notNull()
			.references(() => knowledgeNodes.id, { onDelete: "cascade" }),
		targetId: text("target_id")
			.notNull()
			.references(() => knowledgeNodes.id, { onDelete: "cascade" }),
		relationType: text("relation_type").notNull(), // 'is_a', 'part_of', 'causes', 'treats', etc.
		weight: real("weight").default(1.0),
		properties: jsonb("properties").default({}),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
	},
	(table) => ({
		sourceIdx: index("idx_edges_source").on(table.sourceId),
		targetIdx: index("idx_edges_target").on(table.targetId),
		relationIdx: index("idx_edges_relation").on(table.relationType),
	}),
);
