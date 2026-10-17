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
 * future type) only need a `type` string — we don't render them from `content`,
 * so we tolerate their shape while still rejecting genuinely malformed content
 * (e.g. a number). An answer's source documents are served separately, by
 * `GET /threads/{id}/documents` (spec 168 — see `threadDocumentsSchema`).
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

/**
 * A citable source document (spec 168) — the `document` ContentBlock apps/api
 * derives from an answer's tool records: `source.data` is the text itself (JSON
 * `{ar, en, …}` for Qur'an/hadith, a plain passage for the encyclopedias).
 * Strictly typed, since we render every field of it.
 */
export const documentBlockSchema = z.object({
  type: z.literal('document'),
  source: z.object({
    type: z.string(),
    media_type: z.string(),
    data: z.string(),
  }),
  title: z.string(),
  context: z.string().optional(),
});
export type WireDocument = z.infer<typeof documentBlockSchema>;

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

/**
 * `GET /threads/{id}/documents` (spec 168) — the citable sources behind a
 * thread's answers, served apart from thread GET (which stays frozen). Lists
 * only assistant messages with at least one document. `message_index` is the
 * message's position in thread GET's RAW `messages` array — `tool` rows
 * included — and `message_id` is its id; the decoder requires both to agree.
 *
 * Unlike the schemas above, a mismatch here does NOT fail the conversation:
 * the decoder logs it and renders the answers without sources (see
 * `decodeConversationDetail`).
 */
export const threadDocumentsSchema = z.object({
  thread_id: z.string(),
  messages: z.array(
    z.object({
      message_id: z.string(),
      message_index: z.number().int().nonnegative(),
      documents: z.array(documentBlockSchema),
    }),
  ),
});
export type WireThreadDocuments = z.infer<typeof threadDocumentsSchema>;

/**
 * `GET /share/{id}` — a shared thread's snapshot. Public. Its messages carry
 * no ids; the snapshot is all there is.
 */
export const sharedThreadSchema = z.object({
  id: z.string(),
  thread_name: z.string().nullable().optional(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: messageContentSchema,
      created_at: z.string().nullable().optional(),
    }),
  ),
  created_at: z.string().optional(),
});

/**
 * `GET /share/{id}/documents` (spec 168) — the citable sources copied into the
 * snapshot at share time, keyed by `message_index` alone (a position in share
 * GET's `messages`).
 */
export const sharedDocumentsSchema = z.object({
  messages: z.array(
    z.object({
      message_index: z.number().int().nonnegative(),
      documents: z.array(documentBlockSchema),
    }),
  ),
});

// --- Auth (apps/auth, better-auth 1.7.7) -------------------------------------

/**
 * `POST /api/auth/sign-in/email` and `POST /api/auth/sign-up/email`. `token`
 * is the session token (the bearer for every later apps/auth call); the user
 * carries the names apps/auth stores as additional fields.
 */
export const authSessionSchema = z.object({
  token: z.string().min(1),
  user: z.object({
    id: z.string(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
  }),
});

/** `GET /api/auth/token` — a fresh JWT for `apps/api`, from the session bearer. */
export const authTokenSchema = z.object({
  token: z.string().min(1),
});

/** `POST /api/auth/request-password-reset` and `POST /api/auth/reset-password`. */
export const authStatusSchema = z.object({
  status: z.literal(true),
});

/** `POST /api/auth/sign-out`. */
export const signOutSchema = z.object({
  success: z.boolean(),
});

/** Endpoints returning a bare `{ message }` — `DELETE /threads/{id}`. */
export const messageResponseSchema = z.object({
  message: z.string(),
});

/** `GET /api/health`. */
export const healthSchema = z.object({
  status: z.string(),
  service: z.string().optional(),
  timestamp: z.string().optional(),
});
