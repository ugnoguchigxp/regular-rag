ALTER TABLE "sources"
ADD COLUMN IF NOT EXISTS "category" text;

UPDATE "sources"
SET
	"category" = CASE
		WHEN strpos(regexp_replace("uri", '^.*/pages/', ''), '/') > 0 THEN split_part(regexp_replace("uri", '^.*/pages/', ''), '/', 1)
		ELSE 'tech'
	END
WHERE
	"category" IS NULL
	OR btrim("category") = '';

ALTER TABLE "sources"
ALTER COLUMN "category"
SET DEFAULT 'tech';

ALTER TABLE "sources"
ALTER COLUMN "category"
SET NOT NULL;

CREATE INDEX IF NOT EXISTS "sources_source_kind_category_idx" ON "sources" ("source_kind", "category");
