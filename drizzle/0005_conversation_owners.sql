ALTER TABLE "conversations"
ADD COLUMN IF NOT EXISTS "user_id" uuid;

UPDATE "conversations"
SET "user_id" = (
	SELECT "id"
	FROM "users"
	ORDER BY "created_at" ASC
	LIMIT 1
)
WHERE "user_id" IS NULL
	AND EXISTS (SELECT 1 FROM "users");

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'conversations_user_id_users_id_fk'
	) THEN
		ALTER TABLE "conversations"
		ADD CONSTRAINT "conversations_user_id_users_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS "conversations_user_id_idx"
ON "conversations" ("user_id");
