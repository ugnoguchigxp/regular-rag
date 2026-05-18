CREATE TABLE IF NOT EXISTS "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"system_context" text NOT NULL DEFAULT '',
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
