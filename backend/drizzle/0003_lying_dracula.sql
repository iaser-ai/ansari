ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "system_key" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_system_key" ON "users" USING btree ("system_key");--> statement-breakpoint
-- Conditional backfill (spec 4): mark the EXISTING system rows with system_key, but ONLY
-- when they are legitimate service-created rows (password_hash = 'nologin' AND the matching
-- source). A row registered by an attacker who pre-claimed the email has a real bcrypt hash
-- and is deliberately NOT marked — it must be remediated manually (inspect-before-apply, see
-- the deploy runbook) rather than promoted to system status.
UPDATE "users" SET "system_key" = 'ai-skill'
  WHERE "email" = 'ai-skill@system.ansari.chat'
    AND "password_hash" = 'nologin'
    AND "source" = 'ai-skill';--> statement-breakpoint
UPDATE "users" SET "system_key" = 'leaderboard'
  WHERE "email" = 'leaderboard@system.ansari.chat'
    AND "password_hash" = 'nologin'
    AND "source" = 'leaderboard';