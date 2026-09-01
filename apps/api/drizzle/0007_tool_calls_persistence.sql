CREATE TABLE "tool_call_orphans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"source" text,
	"client" text,
	"tool_calls" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tool_calls" jsonb;--> statement-breakpoint
ALTER TABLE "tool_call_orphans" ADD CONSTRAINT "tool_call_orphans_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tool_call_orphans_thread" ON "tool_call_orphans" USING btree ("thread_id","created_at");