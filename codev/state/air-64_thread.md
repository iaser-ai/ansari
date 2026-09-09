# air-64 — thread

Issue #64: prototypes/ansari-expo — thread delete + title-only history search (adapter-only, AIR).

## Findings (2026-08-28)
- #63 (PR #68) already MERGED and already wired BOTH actions end-to-end:
  - `useDeleteConversation` → `DELETE /api/v2/threads/{id}`, validates with `messageResponseSchema.parse` (throws on bad shape); screen invalidates the list query on success (`app/index.tsx:255`).
  - `useListConversations` → screen passes `{ q }`; `fetchConversations` filtered client-side.
- So the "inert action" premise from the issue is already resolved by #63. The real remaining deltas for #64:
  1. **Search semantics bug**: old filter ran over the *mapped* `title`, so a `thread_name: null` thread became `'New conversation'` and matched "new"/"conversation" — violates DoD "null neither matches". Fixed to filter over raw `thread_name` only.
  2. **Missing tests** for filter (case-insensitive, title-only, null-safe) and delete (throws on bad shape).

## Changes
- `lib/api/mappers.ts`: added pure `filterThreadsByName(threads, q)` — title-only over raw `thread_name`, case-insensitive, null-safe.
- `lib/api/decode.ts`: `decodeConversationList(raw, q?)` filters before mapping; added `decodeDeleteResult(raw)` (the delete mutationFn body minus network).
- `lib/api/hooks.ts`: `fetchConversations` delegates filtering to `decodeConversationList(raw, q)`; `useDeleteConversation` uses `decodeDeleteResult`.
- `lib/api/decode.test.ts`: added filter + delete-loud-failure suites.
- README: title-only note already present (lines 79-80); reinforced why message text is unsearchable.

## Hard constraints
- All changes inside `prototypes/ansari-expo/`.
- 7-package task graph, root `pnpm-lock.yaml` byte-identical — verified in PR body.
