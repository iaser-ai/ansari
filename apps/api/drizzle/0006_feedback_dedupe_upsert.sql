-- Issue #87: one-time dedup, then the unique index that prevents recurrence.
-- The index cannot build while duplicate (user_id, message_id, feedback_class)
-- groups exist, so dedup-then-index must run in this order, in one migration.
-- Hand-written DELETE below (human-reviewed, human-applied at deploy): keep the
-- best row per group — prefer a non-empty comment, else latest created_at,
-- lowest id wins ties — and delete the rest.
DELETE FROM "feedback" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "user_id", "message_id", "feedback_class"
      ORDER BY ("comment" IS NOT NULL AND "comment" <> '') DESC,
               "created_at" DESC NULLS LAST,
               "id" ASC
    ) AS rn
    FROM "feedback"
  ) ranked
  WHERE rn > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feedback_user_message_class" ON "feedback" USING btree ("user_id","message_id","feedback_class");
