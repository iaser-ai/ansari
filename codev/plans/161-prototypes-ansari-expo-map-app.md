# PIR Plan: Map apps/api's citable documents to `Citation` in the prototype

> **Revision 2 (2026-09-25): redesigned for spec 168.** Revision 1 of this plan was built on #66's
> sibling `documents` key on thread GET. #165 reverted that key (it duplicated `tool_calls`
> data, copied document text permanently into public share snapshots, and its unapplied
> migration took staging down). Spec 168 (PR #180) replaced it with **dedicated `/documents`
> endpoints**. Thread GET and share GET are byte-identical to before #66. See
> "What changed from revision 1" below. The marker-resolution design approved in revision 1
> (strong-key matching, drop rather than guess, all sources listed) is unchanged.

## Understanding

The backend now serves each answer's citable sources separately from the thread
(`codev/specs/168-serve-citable-documents-derive.md`):

```ts
// GET /api/v2/threads/{id}/documents: authenticated, owner-scoped, same 404 as thread GET
{ thread_id: string,
  messages: Array<{ message_id: string, message_index: number, documents: DocumentBlock[] }> }
// GET /api/v2/share/{id}/documents: public, reads the share snapshot
{ id: string, messages: Array<{ message_index: number, documents: DocumentBlock[] }> }
// DocumentBlock, identical in both:
{ type: 'document', source: { type, media_type, data: string }, title: string, context?: string }
```

Verified against the merged code (`apps/api/src/app/api/v2/threads/[id]/documents/route.ts`,
`.../share/[id]/documents/route.ts`, `apps/api/lib/db/citable-documents.ts`):

- Only assistant messages with ≥1 citable document are listed, so a thread with none returns
  `messages: []`. Notices ("No Results" and the like) are filtered upstream by the preserved
  `citations.enabled`. This needs no client-side guard.
- `message_index` is the position in thread GET's **raw** `messages` array, **including
  `role: 'tool'` rows**. Both reads order by `(created_at, id)`. The prototype drops `tool` rows
  in `mapMessage`, so any index join must happen **before** that filter.
- The derived blocks carry the tool's original strings: `source.data` is `doc.source.data`, and
  `title` and `context` pass through (`formatToolResultForGemini`, `agent.ts:392`). The
  per-tool shapes the resolver matches on are therefore unchanged:

| Tool | `context` | `title` | `source.data` |
|---|---|---|---|
| quran | `Retrieved from the Holy Quran` | `Quran 2:255` | JSON `{ ar, en }` |
| hadith | `Retrieved from hadith collections` | `<book> - Chapter N: <chapter>, Hadith M (Grade: …) (LK id …)` | JSON `{ ar, en, grade, collection, chapter, lk_id }` |
| tafsir | `Retrieved from Encyclopedia of Evidence-based Tafsir` | `Tafsir Encyclopedia, Volume V, Page P` | plain text, optionally prefixed `Chapter: …\n\n` |
| mawsuah | `Retrieved from Encyclopedia of Islamic Jurisprudence` | `Encyclopedia of Islamic Jurisprudence, Volume V, Page P` | plain text, optionally prefixed `Chapter: …\n\n` |

- The server-side cost of `/documents` is about 5 ms (median, 25-answer synthetic thread), about
  5× thread GET's ~1 ms. The owner accepted this (`codev/reviews/168-*.md`). On a phone, both
  requests are dominated by network round-trip, so fetching both in parallel costs roughly one
  round-trip.
- The prototype has **no share view** (`app/` has only `chat/[id]`, index, login, register,
  about). `/share/{id}/documents` therefore has no consumer here and is out of scope.

### Inline markers: kept, resolved through the model's own "Citations:" list

Neither #66 nor spec 168 adds inline `[N]` markers. However, the
existing facilitator prompt **already tells the model** to write `[1]`, `[2]` inline and a
trailing `**Citations**:` list (`apps/api/lib/ai/prompts/facilitator.ts:116-133`), with each
entry giving "its number, title, and bilingual content". Hadith entries must also carry the
`(LK id …)` token verbatim. Real answers therefore arrive with model-numbered markers **and a
key that says what each number means**. No prompt change is needed, so the Islamic-content
prompt rule is not triggered.

The model's numbering has **no fixed relationship to `documents` array order**, which is
tool-dispatch order after dedup (spec 168 keeps that order). So we can't just pair `[2]` with `documents[1]`. Instead each
marker is **resolved**:

1. Parse the trailing "Citations:" section into entries `N → entry text`.
2. Match each entry to exactly one document, strongest key first:
   - **hadith**: the `LK id` token in the entry equals the document's `lk_id` (exact).
   - **quran**: the `S:A` (or `S:A-B`) reference in the entry equals the one in the document
     title `Quran S:A`.
   - **tafsir / mawsuah**: same work, plus the same `Volume V` and `Page P`.
   - **fallback**: normalized title equality (case/punctuation-insensitive,
     `Qur'an`≡`Quran`).
   An entry that matches zero documents, or more than one, is **unresolved**.
3. Resolved markers stay inline and open that document's source sheet. **Unresolved markers
   are stripped**, one by one, so a superscript never opens a source the model didn't name.
   The project rule is that a wrong real citation is worse than none (`lib/sample-citations.ts`
   header).
4. Markers are **renumbered 1..k in order of first appearance** in the prose, and the pills use
   the same numbers, so the reader never sees gaps (e.g. `[1] [3]`) left by stripped markers.
5. Retrieved documents that no marker cites are **still listed** after the cited ones, as
   pills `k+1…n` with no inline marker. They are real sources the model was given, and the
   issue asks for the answer's actual sources. *(Confirmed at plan review: keep all sources.)*
6. The trailing "Citations:" section is always removed from the displayed text, because the
   pills replace it.
7. **Fallback:** if nothing resolves (no Citations list, or the model ignored the format),
   behave as a document-only answer: strip every marker and list all documents as pills in
   document order.

This keeps the model's inline references wherever we can prove what they point at. It still
never links a marker by guesswork. `stripUnbackedCitations` still covers answers with no
`documents`, unchanged from #158/#160.


## What changed from revision 1

| | Revision 1 (#66) | Revision 2 (spec 168) |
|---|---|---|
| Where documents come from | `documents` key on each thread-GET message | separate `GET /threads/{id}/documents` |
| Wire schema | optional `documents` on `wireMessageSchema` | **removed**; new `threadDocumentsSchema` for the new endpoint. `wireMessageSchema` returns to its pre-#161 shape |
| Join | none needed (inline) | by `message_id` against thread GET's message `id`, cross-checked with `message_index` (see below) |
| Fetch | one request | two requests **in parallel inside the same query function**, so the answer, its markers and its pills arrive together |
| Failure of the sources request | n/a | **degrades, never blocks**: the conversation renders with citations stripped, as today (see below) |
| `lib/document-citations.ts` | new | **unchanged**: same `WireDocument[]` input. `WireDocument` is re-pointed at the new schema's element |
| Khushu' fallback, stripping, "keep all sources" | as approved | unchanged |

**Join key.** The architect named `message_index` as the join key. It is the only key the share
endpoint has. The thread endpoint also returns `message_id`, and the prototype only reads
threads. I propose to **join on `message_id` and require `message_index` to agree**: the
entry is attached only if `raw.messages[message_index].id === message_id` and that message is an
assistant message. A disagreement (e.g. the thread changed between the two requests, or an
ordering drift) attaches nothing for that entry and logs `{messageId, reason}`. This keeps the
drop-rather-than-guess rule at the join as well as at the markers. If you'd rather join on
`message_index` alone (so the same code serves share later), the change is one line, but we
would lose that cross-check.

**Failure posture.** Staging went down on #66 because a sources problem took the whole thread
with it. The thread fetch keeps its loud-failure zod gate unchanged. The sources request must
never make a conversation unreadable:
- **HTTP or network error on `/documents`** (including a 404 from an API older than spec 168):
  render with no citations and strip, exactly as #158/#160. Log `console.warn` with the status
  only.
- **A 200 whose body fails `threadDocumentsSchema`**: same degraded render, but log
  `console.error` naming the ZodError path. This is the "wrong backend" signal, surfaced
  without taking the answer away. (Alternative: throw, which is consistent with the thread
  gate but repeats the staging failure mode. I recommend against it.)
- A malformed single entry fails the whole documents parse (zod is all-or-nothing), which
  degrades the whole thread to no citations. That is acceptable: the server already fails
  closed per record, so a malformed body means a contract break, not bad data.

## Proposed Change

1. **Wire schema** (`lib/api/wire-schemas.ts`)
   - Remove the `documents` field from `wireMessageSchema`, back to its pre-#161 shape.
   - Keep `documentBlockSchema` (unchanged, matches spec 168's `DocumentBlock`).
   - Add `threadDocumentsSchema = z.object({ thread_id: z.string(), messages: z.array(z.object({
     message_id: z.string(), message_index: z.number().int().nonnegative(),
     documents: z.array(documentBlockSchema) })) })`. It is non-strict, like the rest of the file.
   - No share-documents schema (no consumer, see Understanding).

2. **Decode** (`lib/api/decode.ts`)
   - `decodeConversationDetail(rawThread, rawDocuments?)` parses the thread (throws on mismatch,
     unchanged). Then it parses the documents with `safeParse`. On failure it logs and uses none,
     then maps.
   - New pure `joinThreadDocuments(detail: WireThreadDetail, docs: WireThreadDocuments):
     Map<string, WireDocument[]>` implements the `message_id` + `message_index` cross-check rule
     above.

3. **Fetch** (`lib/api/hooks.ts`, `fetchConversation`)
   - `Promise.all([apiFetch(thread), apiFetch(documents).catch(→ undefined + warn)])`, then
     decode. The query key, the hook signature and the screen are unchanged. The existing
     post-stream invalidation refetches both, so a just-streamed answer gets its sources on the
     same refetch that replaces the streaming bubble.

4. **Mapper** (`lib/api/mappers.ts`)
   - `mapConversationDetail(detail, documentsByMessageId = new Map())`. `mapMessage` reads the
     documents for `msg.id` from the map instead of `msg.documents`. Everything downstream
     (`resolveCitations`, the khushu' fallback gate, the strip condition) is unchanged.

5. **`lib/document-citations.ts`**: no logic change. It gets its `WireDocument` type import
   from the schema module as before.

6. **Docs**
   - `codev/resources/arch.md` "Prototype chat display": replace "`documents` (#66) on the wire
     message" with the spec-168 fetch, join and failure posture. Also make sure the reverted #66
     paragraph that the develop merge brought back is not contradicted.
   - `lib/api/mappers.ts`, `lib/citations.ts`, `lib/sample-citations.ts`, `README.md`: replace
     "#66 / `documents` key" wording with "spec 168 `/documents`". This is the "fix a doc defect
     everywhere" rule, including my own revision-1 comments.

## Files to Change

- `prototypes/ansari-expo/lib/api/wire-schemas.ts`: drop `documents` from `wireMessageSchema`,
  add `threadDocumentsSchema` + `WireThreadDocuments`
- `prototypes/ansari-expo/lib/api/decode.ts`: second argument, safe-parse, `joinThreadDocuments`
- `prototypes/ansari-expo/lib/api/hooks.ts:87-93`: parallel fetch with fail-soft documents
- `prototypes/ansari-expo/lib/api/mappers.ts`: consume the join map
- `prototypes/ansari-expo/lib/api/decode.test.ts`: move the revision-1 "real documents" cases to
  the two-payload decode; add join and failure cases
- `prototypes/ansari-expo/lib/document-citations.ts` / `.test.ts`: unchanged (the 20 tests stay
  as the resolver's spec)
- `codev/resources/arch.md`, `prototypes/ansari-expo/README.md`, `lib/citations.ts`,
  `lib/sample-citations.ts`: wording

No apps/api change. Thread GET, share GET and the streaming path are untouched.

## Risks & Alternatives Considered

- **Risk: the two requests see different thread states** (a message persisted between them).
  Appends land at the end, and the id + index cross-check drops anything inconsistent. The
  worst case is one answer without sources until the next refetch.
- **Risk: `/documents` payload size.** It is unbounded and linear in thread length (PR #180
  review finding 2; a follow-up issue is planned upstream). The prototype fetches it once per
  thread load. When the upstream `?message_id=`/cap lands, we can adopt it in a later issue.
- **Risk: the model paraphrases a Citations entry** (carried over). The entry doesn't resolve
  and its marker is dropped, never mislinked.
- **Alternative: a separate react-query query for documents, merged in the screen.** Rejected:
  the thread would render first and markers and pills would pop in a moment later on every
  load, and the chat screen and `chat-reconcile` would need to learn about a second query. The
  saving is about 5 ms of server time.
- **Alternative: fetch documents lazily, only when a source is tapped.** Rejected: the markers
  themselves depend on the documents (resolution decides which `[N]` survive), so the text
  can't be rendered correctly without them.
- **Alternative: join on `message_index` only.** It works and matches the share endpoint, but
  it loses the free consistency check that `message_id` gives. Kept as the one-line fallback
  if you prefer it.

## Test Plan

- **Unit, resolver (`document-citations.test.ts`):** the existing 20 cases, unchanged. This
  includes the mutation check (positional pairing fails 5 of them).
- **Unit, decode (`decode.test.ts`):**
  - Thread + documents payloads → the right assistant message gets resolved markers and pills.
  - `message_index` counts `tool` rows: a thread `[user, tool, assistant]` with
    `message_index: 2` attaches to the assistant.
  - Id/index disagreement → nothing attached for that entry, and other entries still attach.
  - An entry pointing at a user message → ignored.
  - `rawDocuments` undefined (fetch failed) → identical to the no-documents output (stripped,
    `citations: []`).
  - Malformed documents body → same degraded output, no throw. The thread-shape gate tests
    still throw.
  - Khushu' thread whose first answer has documents → real sources; without → sample (carried
    over).
  - `messages: []` → identical to no documents.
- **Unit, fetch:** `fetchConversation` with a rejecting documents request still resolves the
  conversation. Mock at the `apiFetch` boundary only.
- `pnpm --filter ansari-expo test`, typecheck, and the porch build check (with
  `apps/api/.env.ci` loaded, as CI does).
- **Manual (dev-approval), against staging once it runs spec 168:**
  - A search-triggering question ("What does the Qur'an say about patience? Cite a hadith
    too."). After the stream, the answer shows inline markers and pills together. Tapping a
    marker opens the source its sentence cites, checked against the raw `/documents` response
    and the model's original Citations text. No "Citations:" list is shown.
  - "hello" → no pills, stripped text.
  - An old thread → loads, and has sources if its tool records carry the new metadata (pre-168
    rows fail closed upstream, so no sources).
  - I will also measure and report how often markers resolve across 5–10 real answers.
- **Cross-platform:** web plus iOS simulator.
