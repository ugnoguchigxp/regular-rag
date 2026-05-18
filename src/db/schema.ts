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
	uniqueIndex,
	uuid,
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

export const sources = pgTable(
	"sources",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		sourceKind: text("source_kind").notNull(),
		category: text("category").default("tech").notNull(),
		uri: text("uri").notNull(),
		title: text("title"),
		body: text("body").notNull(),
		contentHash: text("content_hash").notNull(),
		metadata: jsonb("metadata").default({}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
	},
	(table) => ({
		uriUniqueIdx: uniqueIndex("sources_uri_idx").on(table.uri),
		sourceKindIdx: index("sources_source_kind_idx").on(table.sourceKind),
		sourceKindCategoryIdx: index("sources_source_kind_category_idx").on(
			table.sourceKind,
			table.category,
		),
		contentHashIdx: index("sources_content_hash_idx").on(table.contentHash),
		bodyTrgmIdx: index("sources_body_trgm_idx").using(
			"gin",
			sql`${table.body} gin_trgm_ops`,
		),
	}),
);

export const sourceFragments = pgTable(
	"source_fragments",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		sourceId: uuid("source_id")
			.notNull()
			.references(() => sources.id, { onDelete: "cascade" }),
		locator: text("locator").notNull(),
		heading: text("heading"),
		content: text("content").notNull(),
		embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
		searchVector: tsvector("search_vector"),
		metadata: jsonb("metadata").default({}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		sourceIdx: index("source_fragments_source_id_idx").on(table.sourceId),
		sourceLocatorIdx: uniqueIndex("source_fragments_source_locator_idx").on(
			table.sourceId,
			table.locator,
		),
		searchVectorIdx: index("source_fragments_search_vector_idx").using(
			"gin",
			sql`${table.searchVector}`,
		),
		contentTrgmIdx: index("source_fragments_content_trgm_idx").using(
			"gin",
			sql`${table.content} gin_trgm_ops`,
		),
		embeddingHnswIdx: index("source_fragments_embedding_hnsw_idx").using(
			"hnsw",
			sql`${table.embedding} vector_cosine_ops`,
		),
	}),
);

export const conversations = pgTable("conversations", {
	id: uuid("id").defaultRandom().primaryKey(),
	title: text("title"),
	metadata: jsonb("metadata").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const messages = pgTable(
	"messages",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		content: text("content").notNull(),
		metadata: jsonb("metadata").default({}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		conversationIdx: index("messages_conversation_id_idx").on(
			table.conversationId,
		),
	}),
);

export const artifacts = pgTable(
	"artifacts",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		messageId: uuid("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		type: text("type").notNull(),
		title: text("title"),
		content: jsonb("content").notNull(),
		version: integer("version").default(1).notNull(),
		metadata: jsonb("metadata").default({}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		conversationIdx: index("artifacts_conversation_id_idx").on(
			table.conversationId,
		),
		messageIdx: index("artifacts_message_id_idx").on(table.messageId),
	}),
);

export const retrievalLogs = pgTable(
	"retrieval_logs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		conversationId: uuid("conversation_id").references(() => conversations.id, {
			onDelete: "set null",
		}),
		messageId: uuid("message_id").references(() => messages.id, {
			onDelete: "set null",
		}),
		query: text("query").notNull(),
		fragmentIds: jsonb("fragment_ids").default([]).notNull(),
		scores: jsonb("scores").default({}).notNull(),
		context: jsonb("context").default({}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => ({
		conversationIdx: index("retrieval_logs_conversation_id_idx").on(
			table.conversationId,
		),
		messageIdx: index("retrieval_logs_message_id_idx").on(table.messageId),
	}),
);

export const userSettings = pgTable("user_settings", {
	userId: text("user_id").primaryKey(),
	systemContext: text("system_context").default("").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});
