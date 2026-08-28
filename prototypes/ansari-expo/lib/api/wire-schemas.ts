import { z } from 'zod';

/**
 * Zod schemas for the RAW wire shapes returned by this repo's `apps/api`
 * (`/api/v2/**` and `/api/health`).
 *
 * These describe what apps/api PROMISES. Every adapter response is parsed
 * through them and **throws on mismatch** — that is the loud-failure gate. If a
 * response ever arrives shaped like the prototype's old Replit "Ansari 4" API
 * (`{ id, title, preview }`, `MessageExchange`, …), `.parse()` throws a ZodError,
 * react-query surfaces `isError`, and the UI shows an error state — never a
 * clean-but-empty screen that hides a broken integration.
 *
 * Schemas are intentionally NOT `.strict()`: apps/api may add fields over time,
 * and rejecting unknown keys would be brittle. We assert the fields we depend on
 * exist with the right types; that is enough to catch a wholesale shape change.
 */

/** Thread summary — `GET /threads` element and `POST /threads` response. */
export const threadSchema = z.object({
  thread_id: z.string(),
  thread_name: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  // apps/api emits these via `?.toISOString()`, so they are omitted (undefined)
  // when the underlying DB value is null.
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type WireThread = z.infer<typeof threadSchema>;

export const threadListSchema = z.array(threadSchema);

/**
 * A single Claude-format content block. Text blocks are strictly typed because
 * we render them; other block kinds (tool_use, tool_result, document, and any
 * future type) only need a `type` string — we don't render them, so we tolerate
 * their shape while still rejecting genuinely malformed content (e.g. a number).
 */
export const contentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.string() }).passthrough(),
]);

/** Message `content` is a bare string for a single text block, else an array. */
export const messageContentSchema = z.union([
  z.string(),
  z.array(contentBlockSchema),
]);

export const wireMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: messageContentSchema,
  agent_name: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  created_at: z.string().optional(),
});
export type WireMessage = z.infer<typeof wireMessageSchema>;

/** `GET /threads/{id}` — a thread plus its messages. */
export const threadDetailSchema = threadSchema.extend({
  messages: z.array(wireMessageSchema),
});
export type WireThreadDetail = z.infer<typeof threadDetailSchema>;

// --- Auth ------------------------------------------------------------------

/** `POST /users/register` — note: NO first_name/last_name (differs from login). */
export const registerResponseSchema = z.object({
  status: z.string(),
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.string(),
});

/** `POST /users/login` — includes the user's names. */
export const loginResponseSchema = z.object({
  status: z.string(),
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.string(),
  first_name: z.string(),
  last_name: z.string(),
});

/** `POST /users/refresh_token` — rotates the pair; NO `status` field. */
export const refreshResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.string().optional(),
});

/** Endpoints returning a bare `{ message }` — `POST /users/logout` and
 * `DELETE /threads/{id}`. */
export const messageResponseSchema = z.object({
  message: z.string(),
});

/** `GET /api/health`. */
export const healthSchema = z.object({
  status: z.string(),
  service: z.string().optional(),
  timestamp: z.string().optional(),
});
