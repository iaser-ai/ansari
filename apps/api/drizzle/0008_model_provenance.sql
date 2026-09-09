ALTER TABLE "messages" ADD COLUMN "model_provider" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "tool_call_orphans" ADD COLUMN "model_provider" text;--> statement-breakpoint
ALTER TABLE "tool_call_orphans" ADD COLUMN "model_id" text;