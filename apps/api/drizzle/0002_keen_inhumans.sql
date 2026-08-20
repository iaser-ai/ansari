ALTER TABLE "users" ADD COLUMN "registered_via" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "client" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client" text;