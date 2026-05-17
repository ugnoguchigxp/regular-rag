CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_kind" text NOT NULL,
	"uri" text NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"last_indexed_at" timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS "sources_uri_idx" ON "sources" ("uri");
CREATE INDEX IF NOT EXISTS "sources_source_kind_idx" ON "sources" ("source_kind");
CREATE INDEX IF NOT EXISTS "sources_content_hash_idx" ON "sources" ("content_hash");
CREATE INDEX IF NOT EXISTS "sources_body_trgm_idx" ON "sources" USING gin ("body" gin_trgm_ops);

CREATE TABLE IF NOT EXISTS "source_fragments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
	"locator" text NOT NULL,
	"heading" text,
	"content" text NOT NULL,
	"embedding" vector(1536),
	"search_vector" tsvector,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "source_fragments_source_id_idx" ON "source_fragments" ("source_id");
CREATE UNIQUE INDEX IF NOT EXISTS "source_fragments_source_locator_idx" ON "source_fragments" ("source_id", "locator");
CREATE INDEX IF NOT EXISTS "source_fragments_search_vector_idx" ON "source_fragments" USING gin ("search_vector");
CREATE INDEX IF NOT EXISTS "source_fragments_content_trgm_idx" ON "source_fragments" USING gin ("content" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "source_fragments_embedding_hnsw_idx" ON "source_fragments" USING hnsw ("embedding" vector_cosine_ops);

CREATE TABLE IF NOT EXISTS "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "messages_conversation_id_idx" ON "messages" ("conversation_id");

CREATE TABLE IF NOT EXISTS "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
	"message_id" uuid NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
	"type" text NOT NULL,
	"title" text,
	"content" jsonb NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "artifacts_conversation_id_idx" ON "artifacts" ("conversation_id");
CREATE INDEX IF NOT EXISTS "artifacts_message_id_idx" ON "artifacts" ("message_id");

CREATE TABLE IF NOT EXISTS "retrieval_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
	"message_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL,
	"query" text NOT NULL,
	"fragment_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"scores" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"context" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "retrieval_logs_conversation_id_idx" ON "retrieval_logs" ("conversation_id");
CREATE INDEX IF NOT EXISTS "retrieval_logs_message_id_idx" ON "retrieval_logs" ("message_id");
