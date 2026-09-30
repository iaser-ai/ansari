# PIR Plan: Compact the retrieval trace into a source-category row

> **Revised at dev-approval (reviewer feedback).** Two points below are superseded:
> 1. The lead word is always **"Searching"**. There is no "Reading" and no `phase`,
>    because swapping the first word shifted the whole row. `sourceProgress()`
>    returns `SourceProgress[]` directly.
> 2. The order is **Qur'an · Hadith · Fiqh · Tafsir**, the order the facilitator
>    prompt lists its tools (`apps/api/lib/ai/prompts/facilitator.ts:58-61`). The
>    row therefore tends to light left to right instead of going 1, 2, 4, 3.
> 3. (PR review) The claims below that the row wraps to "at most 2 lines" at the
>    largest Dynamic Type are wrong. Type scaling is uncapped, as it is everywhere in the
>    app, so at the accessibility sizes the row wraps further, deliberately.

## Understanding

While Ansari retrieves sources, the waiting line under the question
(`components/ThinkingLine.tsx:35-74`) renders **one `<Text>` per search query**
(`trace.map(formatTraceLine)`, line 45). A single question commonly issues
several queries per source, so the block grows unbounded ("Searching quran for
…", "Searching quran for …", "Searching quran for …", "Searching hadith…", …),
and every line has the same colour (`colors.mutedForeground`). Nothing
distinguishes "in flight" from "done" except the wording.

The user wants a fixed, compact line (1 line, 2 at most) that names every
source category once. Each category starts dimmed and brightens when its search
is complete, and a "Searching" label says what is happening. They explicitly
invited elevating the idea, as long as it stays simple and focused.

Facts from the code that shape the design:

- **Wire events.** The API emits `tool_call { name }` when the model requests a
  tool (`apps/api/lib/facilitator/agent.ts:757`, mapped in
  `apps/api/src/app/api/v2/threads/[id]/chat/route.ts:115-123`) and
  `tool_result { tool, query, resultCount }` when each call finishes
  (`agent.ts:960-966`). Budget-skipped calls also emit a `tool_result`, with
  `resultCount: 0` (`agent.ts:921-924`). So every call is closed by a result.
  Within a round, calls run sequentially. The model can run several rounds, so a
  category can be searched again after it has already completed.
- **Categories.** There are exactly four search tools (`TOOL_LABELS`,
  `apps/api/lib/tools/resilience.ts:300-305`): `search_quran`, `search_hadith`,
  `search_mawsuah`, `search_tafsir_encyclopedia`. `displayTool()`
  (`lib/chat-trace.ts:38-42`) already reduces them to `quran` / `hadith` /
  `mawsuah` / `tafsir encyclopedia`.
- **Reducer invariants.** `traceReducer` (`lib/chat-trace.ts:53-75`) keeps one
  entry per call. It matches results by tool, falls back FIFO on a name
  mismatch, and appends a completed entry when a result has no call, so a
  spinner is never stranded. These invariants are tested in
  `lib/chat-trace.test.ts:43-110`, and they are exactly what a per-category view
  needs underneath.
- **Consumers.** `ThinkingLine` has two callers: `app/index.tsx:832` (no trace,
  while the conversation is created) and `app/chat/[id].tsx:768` (live trace).
  `formatTraceLine` is used only by `ThinkingLine` and its tests.

## Proposed Change

### 1. Pure derivation: `sourceProgress(entries)` in `lib/chat-trace.ts`

Keep `traceReducer` and `TraceEntry` exactly as they are, so the per-query
invariants and their tests stay untouched. Layer a **pure category-level
derivation** on top of them:

```ts
export type SourceState = 'idle' | 'searching' | 'done';
export interface SourceProgress { key: string; label: string; state: SourceState }

export function sourceProgress(entries: TraceEntry[]): {
  phase: 'searching' | 'searched';   // drives the leading label
  sources: SourceProgress[];         // fixed order, always the four known ones
};
```

Rules:
- **Fixed catalogue, fixed order:** Qur'an · Hadith · Tafsir · Fiqh. This is
  scripture first, then scholarship, and it matches the Sources footer's
  Qur'an → Hadith → scholarly order (`lib/footnote-groups.ts:19-23`). All four
  are always shown, so the row never changes shape and it answers "what can
  Ansari consult?" at a glance. Keys match the `displayTool` labels
  (`quran`, `hadith`, `tafsir encyclopedia`, `mawsuah`).
- **Per-category state, from that category's entries:**
  - `searching` if **any** entry is pending. A category searched again in a
    later round goes back to `searching`, which is truthful. It returns to
    `done` when that call resolves.
  - `done` if it has entries and none are pending. This includes 0-result and
    budget-skipped searches: the search in that category *is* complete, which is
    the signal the user asked for.
  - `idle` if the category has no entries (not consulted, or not yet consulted).
- **Unknown tool ids** (a future `search_*`) are appended after the four as an
  extra category, labelled by `displayTool` in title case, so a new tool is
  never silently dropped. **Nameless entries** (`the sources`) belong to no
  category, but they still count toward `phase`.
- **Never stuck:** state is recomputed from the entries every time and not
  stored, so the reducer's "never strand a spinner" guarantee carries over.
  If an FIFO-fallback re-labels a pending hadith entry as quran, hadith has no
  entries left and goes back to idle. It never stays half-lit.
- **`phase`:** `searching` while anything is pending or before any tool event
  arrives. `searched` once at least one entry exists and none is pending, which
  covers the gap where the model is reading results before it writes.

### 2. `ThinkingLine` renders one compact row

```
[mark]  Searching  Qur'an · Hadith · Tafsir · Fiqh
```

- Leading label: **"Searching"** during `phase: 'searching'`, and **"Reading"**
  once every started search is done (`phase: 'searched'`). The second label
  says what is actually happening in the pause before the answer starts, so the
  line never looks frozen with everything lit. It stays in the existing prose
  italic, in `mutedForeground`.
- Each category is its own `Animated.Text` in a `flexDirection: 'row',
  flexWrap: 'wrap'` container, separated by dim middle dots. That gives
  **one line on a phone, and a wrap to a second line** only on very narrow
  widths or at large Dynamic Type. Opacity per state:
  - `idle`: **0.35**, recessive but legible.
  - `searching`: a gentle opacity **breath between 0.35 and 0.7**, reusing the
    motion tokens (`DURATION`, `EASE_IN_OUT`) and the same style as
    `AnsariMarkPulse`. This shows *which* source is being searched right now,
    without a spinner or any extra glyph. It is the one "elevation" beyond the
    literal request, and it keeps the row simple. Under reduced motion it is a
    static 0.6.
  - `done`: **1.0**, eased in with `DURATION.state` / `EASE_OUT` (a static
    change under reduced motion).
  - The text colour stays `mutedForeground` for every state, so the full-opacity
    state reads as "lit", not as a new colour.
- The mark stays top-aligned with the first line, as it is today. Because the
  row is fixed in shape, the `multiline` branch collapses to one layout (mark
  centred on the first line).
- **The no-trace caller** (`app/index.tsx:832`, and the thread before its first
  event) shows the same row with every category idle under "Searching". The
  wait therefore looks the same on both screens, and the first `tool_call`
  simply lights a word in place, with no layout jump when the trace starts.
  This replaces the old "Searching the sources…" fallback line.
- **Accessibility:** the row gets one `accessibilityLabel` that summarises the
  state (e.g. "Searching sources. Qur'an done, Hadith searching, Tafsir not
  searched, Fiqh not searched."), with `accessibilityLiveRegion="polite"` on
  Android, so screen-reader users are not given the opacity-only signal.

### 3. Remove the superseded per-line copy

`formatTraceLine` and `plural` lose their only caller, so they are deleted along
with their `describe('formatTraceLine')` tests. This deliberately supersedes the
per-query line copy (the query text and the result counts). The module doc
comment and the `ThinkingLine` doc comment are updated to describe the category
row. `TraceEntry` keeps `query` / `resultCount`. They are harmless, they are
still what the reducer records, and they stay available if counts are ever
wanted again.

## Files to Change

- `prototypes/ansari-expo/lib/chat-trace.ts`: add `SourceState`,
  `SourceProgress`, the `SOURCE_CATALOGUE` constant, and `sourceProgress()`.
  Delete `formatTraceLine` / `plural` (lines 77-110). Update the module doc
  comment (lines 3-13). `traceReducer`, `displayTool` and `TraceEntry` are
  unchanged.
- `prototypes/ansari-expo/lib/chat-trace.test.ts`: add a
  `describe('sourceProgress')` block. Remove `describe('formatTraceLine')`
  (lines 112-160). Keep the `displayTool` / `traceReducer` tests unchanged.
- `prototypes/ansari-expo/components/ThinkingLine.tsx`: replace the per-line map
  (lines 43-73) with the label and category row. Add a small `SourceWord`
  subcomponent for the per-state opacity animation, plus the accessibility
  label. Update the doc comment. `GeneratingMark` is untouched.
- `prototypes/ansari-expo/app/chat/[id].tsx` / `app/index.tsx`: **no change
  expected**, because the `ThinkingLine` props stay the same (`trace?:
  TraceEntry[]`).
- `codev/resources/arch.md` ("Prototype chat display"): add a short paragraph on
  the trace row, covering the per-query reducer, the category derivation and the
  fixed catalogue.

## Risks & Alternatives Considered

- **Risk: a category is dimmed for the whole turn** (the model did not use it).
  This is intentional and honest, since dim reads as "not consulted". The
  "Reading" label then makes it clear that the search part is over.
- **Risk: detail is lost.** The queries and result counts leave the UI. The
  user asked for compactness over detail, and the counts were never citation
  UI. The reducer still records them, so bringing them back later (for example
  on a long press) is cheap.
- **Risk: the category catalogue drifts from the backend.** It is hard-coded on
  the client, because the prototype cannot import `apps/api`. Mitigation:
  unknown `search_*` ids are appended rather than dropped, and there is a test
  for it.
- **Risk: nested `Text` opacity.** RN ignores `opacity` on nested `<Text>`
  spans. Using sibling `Animated.Text` nodes in a wrapping row avoids this, and
  it works the same on web.
- **Alternative: show only the categories invoked this turn.** Rejected. The
  row would grow and reorder as tools fire (the same kind of jitter we are
  removing), and the user asked for all categories dim, lighting up as they
  complete.
- **Alternative: replace `traceReducer` with a per-category reducer.** Rejected.
  The per-query reducer already solves the hard cases (out-of-order results,
  name mismatches, orphan results) and has tests for them. A derivation over its
  output inherits those guarantees for free.
- **Alternative: a checkmark or spinner glyph per category.** Rejected as extra
  visual complexity. Opacity plus the breathing active word carry the state.
- **Open copy question for the reviewer:** "Fiqh" for Mawsuah (short and
  recognisable, since it is the Encyclopedia of Islamic Jurisprudence) and
  "Tafsir" for Tafsir Encyclopedia. Other candidates are "Mawsuah" and
  "Jurisprudence". The same goes for "Reading" versus "Searched" as the
  post-search label.

## Test Plan

- **Unit (vitest, `lib/chat-trace.test.ts`)** for `sourceProgress`:
  - an empty trace gives all four `idle` in the order Qur'an, Hadith, Tafsir,
    Fiqh, with `phase: 'searching'`
  - a pending call gives that category `searching` and the others `idle`
  - a completed call gives `done`, and a 0-result call also gives `done`
  - a category with two calls, one resolved and one pending, stays `searching`,
    and goes to `done` when both are resolved
  - a category re-searched after `done` goes back to `searching`
  - a name mismatch (the FIFO fallback in `traceReducer`) leaves no category
    stuck `searching` once every call has a result
  - an unknown `search_foo` is appended after the four, labelled "Foo"
  - a nameless entry changes no category but keeps `phase: 'searching'` while
    it is pending
  - `phase` is `searched` once there are entries and none is pending
  - Existing `displayTool` / `traceReducer` tests still pass unchanged.
- **Typecheck + full prototype suite:** `npm test` and `tsc --noEmit` in
  `prototypes/ansari-expo`.
- **Manual (worktree dev server, web + iOS simulator):**
  - Ask a question that uses several sources (e.g. "What does Islam say about
    patience?"). The line stays at **one line**, with all four categories dim.
    The active one breathes, and each lights up to full once its searches
    finish. When searching ends the label changes to "Reading", and the row
    hands off to the streaming answer exactly as before.
  - Ask a greeting ("salaam") that uses no tools. The row stays dim under
    "Searching" until the answer streams, with no layout jump.
  - Start from the home screen. The row appears under the lifted question and
    continues into the thread without fading in twice or changing shape.
  - Narrow the web window to about 320px, or set the largest Dynamic Type. The
    row wraps to **at most 2 lines**.
  - With OS reduced motion on, there is no breathing, only static opacity
    steps.
  - With VoiceOver on, the row reads its summary label.
