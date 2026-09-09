# PIR Plan: Echo a thread-typed follow-up immediately (generalise ECHO_ID)

Fixes #128

## Understanding

In `prototypes/ansari-expo`, a follow-up question **typed into an open thread**
is not drawn until the post-`done` refetch lands. For the few seconds between
pressing send and that refetch, the thread shows a "thinking" line and then a
streaming answer bubble **with no question above it**. The carried-in question
from the home screen (`?q=`) does not have this gap.

### Root cause (confirmed)

`lib/chat-reconcile.ts` synthesises exactly one client-side row: the carried-in
question, keyed `ECHO_ID` and reconciled against the server copy by
`content === q` (`chat-reconcile.ts:75-100`).

A thread-typed follow-up takes a different path. `send()` in
`app/chat/[id].tsx:298-317` calls `sendMessage.mutate(...)` and sets
`streamingText` / `trace` state, but **never records the follow-up text
anywhere the reconciler can see it**. So `reconcileThread` renders:

1. the server messages (the pre-send thread, ending in the prior answer),
2. the synthetic streaming answer bubble (`chat-reconcile.ts:106-119`),

and nothing in between. The follow-up user message only appears when
`useGetConversation` refetches after `sendMessage`'s `onSuccess`
(`app/chat/[id].tsx:257-268`) — by which point the answer has been streaming
against an empty slot.

This is pre-existing from #121; #124 re-enabled incremental streaming, which
makes the empty slot conspicuous (before, the whole turn appeared at once on
`done`). #124 deliberately scoped it out ("wiring, not behavior change").

### The landed-answer detection constraint

`landedAnswer` (`chat-reconcile.ts:60-66`) is computed purely from
`serverMessages.length > sentAtCount` and the last server message's role. The
fix adds a **client** row to the output `messages` list only — it never touches
`serverMessages` — so the hand-off detection is structurally unaffected. A test
will lock this in.

## Proposed Change

Generalise the echo: the reconciler learns about the just-sent follow-up the
same way it knows about `q`, and applies the same identity trick.

### 1. `lib/chat-reconcile.ts`

- Add two fields to `ReconcileInput`:
  - `pendingFollowUp: string | undefined` — the text of the follow-up sent this
    turn, cleared once the persisted copy has been reconciled in.
  - `followUpKey: string` — this turn's stable list key for that row
    (`__followup-question-<turnSeq>`), the user-row analogue of `streamKey`.
- Add `FOLLOWUP_KEY_PREFIX = '__followup-question-'` (kept in sync with the
  screen, exactly as `STREAM_KEY_PREFIX` / `ECHO_ID` already are).
- After the existing `withEcho` construction and **before** the streaming-bubble
  append, when `pendingFollowUp` is set:
  - Find the **last** row with `role === 'user' && content === pendingFollowUp
    && id !== ECHO_ID`. (Last, not first: the carried-in `q` may be identical
    text and is already claimed by `ECHO_ID` at the front; the follow-up is the
    most recent occurrence. The `id !== ECHO_ID` guard covers the prepended
    echo row when `q === pendingFollowUp` and the server copy hasn't landed.)
  - If found (the refetch has delivered it): override that row's `id` to
    `followUpKey`. No duplicate row, no remount.
  - If not found (still pre-refetch): append a synthetic
    `{ id: followUpKey, role: 'user', content: pendingFollowUp, conversationId,
    citations: [], createdAt: '' }` row — same shape as the `ECHO_ID` synthetic.
- Add `landedFollowUp: Message | null` to `ReconcileResult`: the persisted user
  row for this turn once the refetch has delivered it (scan `serverMessages`
  from index `sentAtCount` for the first `role === 'user'` with
  `content === pendingFollowUp`). This lets the screen give the row a durable
  key override on the hand-off, mirroring how `landedAnswer` drives the
  assistant's key override — so the row does not revert to its raw id (and
  re-animate) when `pendingFollowUp` is cleared.

### 2. `app/chat/[id].tsx`

- Add `const [pendingFollowUp, setPendingFollowUp] = useState('')` and a
  `followUpKey = useRef('')`.
- Add `const FOLLOWUP_KEY_PREFIX = '__followup-question-'` next to
  `STREAM_KEY_PREFIX`.
- In `send(content, opening)` — **after** the early-return guard:
  - `followUpKey.current = `${FOLLOWUP_KEY_PREFIX}${turnSeq.current}``
  - `setPendingFollowUp(opening ? '' : content)` — the carried-in question is
    still handled by `ECHO_ID`; only thread-typed follow-ups need this.
- Pass `pendingFollowUp` and `followUpKey.current` into `reconcileThread(...)`;
  add `pendingFollowUp` to the `useMemo` dep array (`followUpKey` stays a ref,
  like `streamKey`).
- Destructure `landedFollowUp` from the result.
- In the `done` hand-off effect (`app/chat/[id].tsx:397-408`): when
  `streamingText && landedAnswer`, also — guarded on its own truthiness —
  remap `landedFollowUp.id → followUpKey.current` in `keyOverrides`, add that
  key to `drawn.current`, and `setPendingFollowUp('')`. This is the exact
  parallel of the existing `landedAnswer` handling.
- The synthetic follow-up row is genuinely new content, so it animates in once
  via `TURN_ENTER` (`isNewContent(keyFor(item))`), which is already the desired
  behaviour for a follow-up typed in the thread — and `carriedInWait`
  (`app/chat/[id].tsx:465`) stays `false` because `lastMessage.id` is now the
  follow-up key, not `ECHO_ID`, so `ThinkingLine` animates as it should.

### Why this approach

It reuses the mechanism already in place (`ECHO_ID` + `keyOverrides` +
`drawn`), keeps `chat-reconcile.ts` the single home of the reconciliation
logic, and keeps `landedAnswer` untouched. The alternative — optimistically
writing the user message into the React Query cache — would couple the screen
to the cache shape, risk a fledge-of-frame duplicate against the real refetch,
and is harder to unit-test than the pure reconciler.

## Files to Change

- `prototypes/ansari-expo/lib/chat-reconcile.ts` — `pendingFollowUp` /
  `followUpKey` inputs, `FOLLOWUP_KEY_PREFIX`, synthetic/reconciled follow-up
  row, `landedFollowUp` in the result.
- `prototypes/ansari-expo/app/chat/[id].tsx` — `pendingFollowUp` state,
  `followUpKey` ref, `FOLLOWUP_KEY_PREFIX`, wire into `send()` and
  `reconcileThread(...)`, extend the `done` hand-off effect.
- `prototypes/ansari-expo/lib/chat-reconcile.test.ts` — new cases (below).

No `apps/` or `packages/` changes. Prototype-side only.

## Risks & Alternatives Considered

- **Risk: perturbing `landedAnswer` / the `done` hand-off.** The synthetic user
  row is added to the output list only; `landedAnswer` reads `serverMessages`
  and `sentAtCount`, never the output. Mitigation: a dedicated test asserting
  `landedAnswer` is identical with and without `pendingFollowUp` set, for the
  same `serverMessages`.
- **Risk: the follow-up row remounts / re-animates on `done`** when
  `pendingFollowUp` is cleared and the row reverts to its server id.
  Mitigation: the `landedFollowUp` → `keyOverrides` remap + `drawn` add, exactly
  as done for the assistant row.
- **Risk: `q === pendingFollowUp` (same text carried in and re-asked).** The
  "last match, skip `ECHO_ID`" rule keeps the two reconciliations from claiming
  the same row; `landedFollowUp`'s scan starts at `sentAtCount` so it can't grab
  the carried-in copy at index 0. Covered by a test.
- **Risk: double-rendering the question on send failure** — the synthetic row
  plus `SendFailure`'s own `"<question>" was not delivered` copy. This already
  happens for the carried-in path (`ECHO_ID` row + `SendFailure`), so it is
  consistent, not a regression. Left as-is.
- **Alternative: optimistic cache write** — rejected, see "Why this approach".
- **Alternative: render the pending follow-up straight from screen state,
  bypassing the reconciler** — rejected: splits the list-construction logic
  across two files and loses unit-test coverage of the reconcile step.

## Test Plan

### Unit (`lib/chat-reconcile.test.ts`, `pnpm --filter ... test` / `vitest run`)

- **synthetic follow-up appears pre-refetch**: `pendingFollowUp` set,
  `serverMessages` still the pre-send thread → output is
  `[...server, followUpKey-row, STREAM_KEY]` with the follow-up row carrying the
  right `content` and `role: 'user'`.
- **reconciled on refetch**: `serverMessages` now includes the persisted user +
  assistant, still streaming → the persisted user row's id becomes
  `followUpKey`, no duplicate, assistant still held back behind the synthetic
  streaming bubble.
- **`landedFollowUp` returned** once the persisted user row is present; `null`
  before.
- **`landedAnswer` unaffected**: same `serverMessages` / `sentAtCount`, with and
  without `pendingFollowUp` → identical `landedAnswer`.
- **`q === pendingFollowUp`**: carried-in question and follow-up have the same
  text → `ECHO_ID` stays on the first user row, `followUpKey` on the last;
  `landedFollowUp` is the second occurrence.
- **no `pendingFollowUp`**: existing behaviour byte-for-byte unchanged (the
  existing suite must stay green).

### Manual (running worktree, `dev-approval` gate)

1. Open an existing thread with at least one prior Q&A.
2. Type a follow-up, press send.
3. **Expected**: the follow-up question appears **immediately** as a user
   bubble at the foot of the thread, the thinking line sits under it, then the
   answer streams **below the question** — no empty slot, no question popping in
   late when the refetch lands.
4. After the answer completes: exactly one question bubble and one answer (no
   duplicate, no flash/re-animation of the question at `done`).
5. Carried-in path unchanged: from the home screen ask a question → thread opens
   with the question already at the head, answer streams beneath it.
6. Send-failure path: kill the network, send a follow-up → question bubble shows
   above the "Answer not delivered" notice; Retry re-runs the turn.
7. Scroll up through a long thread after several follow-ups → no turn
   re-animates as it scrolls back into view.

### Cross-platform

- Web + iOS (Expo Go or simulator): verify 2–4 above on both; the animation /
  `drawn` gate is shared code but the FlatList virtualization behaviour differs.

### Regression checks

- `vitest run` (whole prototype suite), `tsc --noEmit`.
