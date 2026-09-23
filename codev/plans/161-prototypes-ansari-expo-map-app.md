# PIR Plan: Map apps/api's real `documents` to `Citation` in the prototype

## Understanding

#66 has shipped (merged in PR #162). `GET /api/v2/threads/{id}` and `GET /api/v2/share/{id}` now
emit an additive `documents` key on an assistant message, **only when non-empty**
(`apps/api/src/app/api/v2/threads/[id]/route.ts:71-73`, `apps/api/src/app/api/v2/share/[id]/route.ts:38`).
Each element is a `document` ContentBlock: `{ type: 'document', source: { type: 'text',
media_type: 'text/plain', data }, title, context? }`. The data is deduped, in dispatch order, and
contains only `citations.enabled: true` sources.

The prototype ignores it today:

- `prototypes/ansari-expo/lib/api/wire-schemas.ts:52-59`: `wireMessageSchema` has no `documents`.
  Zod strips unknown keys, so the data is dropped when the response is parsed.
- `prototypes/ansari-expo/lib/api/mappers.ts:114`: every message gets `citations: []`.
- `prototypes/ansari-expo/lib/api/mappers.ts:137-170`: the only citations that ever render are the
  hard-coded khushu' sample (`lib/sample-citations.ts`), which also replaces that answer's text.
- `prototypes/ansari-expo/lib/api/mappers.ts:163-167`: any assistant answer with no citations
  goes through `stripUnbackedCitations`, which removes the model's own `[N]` markers and its
  trailing "Citations:" list.

The four search tools determine what `title` / `source.data` look like
(`apps/api/lib/tools/search-*.ts`):

| Tool | `context` | `title` | `source.data` |
|---|---|---|---|
| quran | `Retrieved from the Holy Quran` | `Quran 2:255` | JSON `{ ar, en }` |
| hadith | `Retrieved from hadith collections` | `<book> - Chapter N: <chapter>, Hadith M (Grade: …) (LK id …)` | JSON `{ ar, en, grade, collection, chapter, lk_id }` |
| tafsir | `Retrieved from Encyclopedia of Evidence-based Tafsir` | `Tafsir Encyclopedia, Volume V, Page P` | plain text, optionally prefixed `Chapter: …\n\n` |
| mawsuah | `Retrieved from Encyclopedia of Islamic Jurisprudence` | `Encyclopedia of Islamic Jurisprudence, Volume V, Page P` | plain text, optionally prefixed `Chapter: …\n\n` |

Documents reach the UI only through the thread GET. The streamed answer does not carry them, but
`chat-reconcile` already swaps the streamed bubble for the persisted message once the detail
refetch lands. The persisted message will carry the citations, so no streaming changes are
needed.

### One point that differs from the issue text, for the reviewer to decide

The issue says #66 adds no inline `[N]` markers. That is true of #66 itself. However, the
existing facilitator prompt **already tells the model** to write `[1]`, `[2]` inline and a
trailing `**Citations**:` list (`apps/api/lib/ai/prompts/facilitator.ts:116-133`). Real answers
therefore arrive with model-numbered markers. That numbering is the model's own, in the order it
chose to cite, and it has **no reliable relationship to the `documents` array order**, which is
tool-dispatch order after dedup. If we kept those markers and gave the pills document-order
numbers, a superscript `[2]` could open a source the sentence never used. The project rule is
that a wrong real citation is worse than none (`lib/sample-citations.ts` header).

**Proposal:** an answer with real documents gets the footnote-pill list from its documents, **and
still has the model's inline markers and trailing "Citations:" list stripped**. The markers
can't be trusted to point at the right pill, and the list duplicates the pills. This follows
the issue's stated outcome ("footnote-pill list … but **no inline superscript markers**").
It departs from the literal bullet "`stripUnbackedCitations`: only strip when documents are
absent". Under this proposal the strip keeps its name and behavior but runs on every real
assistant answer. The only answer that keeps its markers is the khushu' sample, whose markers
are hand-matched. If the reviewer would rather keep the model's markers, the change is one
condition in the mapper, but the plan recommends against it.

## Proposed Change

1. **Wire schema** (`lib/api/wire-schemas.ts`)
   - Add `documentBlockSchema`, matching #66 exactly:
     `z.object({ type: z.literal('document'), source: z.object({ type: z.string(), media_type: z.string(), data: z.string() }), title: z.string(), context: z.string().optional() })`.
     It is non-strict, like the rest of the file.
   - `wireMessageSchema` gains `documents: z.array(documentBlockSchema).optional()`. The key is
     absent on document-less messages and on older deploys, so it has to be optional. A
     present-but-malformed array still throws, which keeps the loud-failure gate.
   - Update the header/doc comments to say which content types we now render.

2. **Document → Citation mapper** (new `lib/document-citations.ts`, pure and RN-free so it can
   be unit-tested)
   - `documentsToCitations(docs, messageId): Citation[]`. Markers are `1..n` in array order, and
     `id` is `${messageId}-doc-${marker}`.
   - Classification comes from `context`, falling back to the `title` prefix:
     - **quran** → `sourceType: 'quran'`, `reference: "Qur'an 2:255"` (from the title),
       `sourceTitle: "Qur'an"`, `arabicText: data.ar`, `translationText: data.en`,
       `url: https://quran.com/2/255`. The URL is only set when the title parses as
       `S:A`, the same scheme the sample already uses.
     - **hadith** → `sourceType: 'hadith'`, `reference`: the `title` minus its trailing
       `(LK id …)` token, `sourceTitle: data.collection`, `arabicText: data.ar`,
       `translationText: data.en`. `url` is left unset: the repo has no verified hadith URL
       scheme, and a guessed link is not acceptable.
     - **tafsir / mawsuah** → `sourceType: 'scholarly'`, `reference: title`,
       `sourceTitle`: the encyclopedia name. The passage goes in `arabicText` if it is mostly
       Arabic script. Otherwise it goes in `translationText`. The `Chapter: …` prefix is
       lifted into the reference.
     - **Unknown context, or JSON that fails to parse** → `sourceType: 'scholarly'`,
       `reference: title`, `sourceTitle: context ?? ''`, `translationText: data`. We show the
       raw text rather than drop a real source or throw.
   - Pure functions only. Nothing is fabricated: every field comes from the document itself.

3. **Mapper** (`lib/api/mappers.ts`)
   - `mapMessage`: an assistant message with `documents?.length` gets
     `citations: documentsToCitations(...)`. Everything else gets `[]` as before.
   - Khushu' sample gate: it now applies only when that first assistant answer has **no real
     documents**, and is kept as the fallback demo the issue allows. A real answer is never
     overwritten by sample text or sample sources. (If the reviewer prefers, we delete
     `sample-citations.ts` entirely. That is simple to do, but no demo would remain on an
     environment without #66.)
   - Strip step: strip every assistant answer except the khushu' sample, per the decision
     above. The condition changes from `citations.length === 0` to "not the sample".
   - Rewrite the header comment. `citations` is no longer "apps/api never carries". It now
     comes from `documents` (#66), with the sample kept as a fallback.

4. **Docs**
   - Update `lib/citations.ts` header, `lib/sample-citations.ts` header, and the prototype
     README's "empty by design" section wherever they say "real citations arrive with #66".
     This follows the lesson "fix a doc defect everywhere".
   - Update the `codev/resources/arch.md` "Prototype chat display" section to describe the
     documents → pills path and the marker decision.

## Files to Change

- `prototypes/ansari-expo/lib/api/wire-schemas.ts:33-59`: `documentBlockSchema`, optional
  `documents` on `wireMessageSchema`
- `prototypes/ansari-expo/lib/document-citations.ts`: new, `documentsToCitations`
- `prototypes/ansari-expo/lib/document-citations.test.ts`: new
- `prototypes/ansari-expo/lib/api/mappers.ts:15-37, 105-170`: attach real citations, narrow the
  sample gate, adjust the strip condition, update comments
- `prototypes/ansari-expo/lib/api/decode.test.ts:219-345`: new real-documents cases; khushu'
  cases updated where their premise changes
- `prototypes/ansari-expo/lib/citations.ts:1-13`, `lib/sample-citations.ts:3-39`,
  `prototypes/ansari-expo/README.md`: doc comments
- `codev/resources/arch.md`: prototype chat display section

The API, the shared UI components (`AnswerMessage`, `CitationChip`, `SourceFolio`,
`SourcePanel`), and the generated `Citation` type do not change.

## Risks & Alternatives Considered

- **Risk: tool output format drifts** (e.g. hadith JSON keys renamed). Mitigation: the mapper
  falls back to raw text, and unit tests pin each tool's current shape using fixtures copied
  from the `search-*.ts` builders. The zod schema checks only the #66 envelope, not the
  per-tool `data` payload, so a payload change degrades the display without breaking the
  thread.
- **Risk: long tafsir/mawsuah passages.** `SourceFolio` shows the whole text. I will check in
  the running app that the sheet scrolls, and cap the preview if it does not.
- **Risk: many documents.** One turn can retrieve 10+ sources, which means 10+ pills. We accept
  this for the prototype: it is real data, and hiding sources would misrepresent what the answer
  was built on. The count is noted in the review.
- **Alternative: keep the model's `[N]` markers and map them to documents by position.**
  Rejected (see Understanding): the numbering doesn't match, so markers would open wrong sources.
- **Alternative: match the model's "Citations:" list entries to documents by title.** Rejected
  for this issue. It is fragile (the model paraphrases titles) and is really the prompt/marker
  problem the issue explicitly sends to a separate, sign-off-gated issue.

## Test Plan

- **Unit (`document-citations.test.ts`):** one fixture per tool (quran, hadith, tafsir,
  mawsuah) builds the expected `Citation`. Also covered: marker order 1..n; hadith `LK id`
  removed from the reference; Quran URL set only for a parseable `S:A` title; malformed
  JSON → raw-text fallback; unknown context → scholarly fallback.
- **Unit (`decode.test.ts`):**
  - An assistant message with `documents` decodes to non-empty `citations` whose `content` has
    no `[N]` and no "Citations:" block.
  - A message without `documents` is unchanged from #158/#160: stripped, `citations: []`.
  - A khushu' thread whose first answer HAS documents gets the real citations and keeps its
    real text, not the sample.
  - A khushu' thread with no documents still gets the sample, with its markers.
  - A malformed `documents` array (e.g. missing `title`) throws a ZodError.
  - A negative check: the with-documents assertion fails when the mapper drops `documents`.
- `pnpm --filter ansari-expo test` and the typecheck pass.
- **Manual (dev-approval):** run the prototype against an apps/api that includes #66.
  - Ask a question that triggers search, e.g. "What does the Qur'an say about patience?". After
    the stream completes and the refetch lands, the answer shows footnote pills for the real
    sources. Tapping one opens SourcePanel/SourceFolio with Arabic + English, and the Qur'an
    link opens quran.com. No stray `[N]` or "Citations:" appears in the prose.
  - Ask something that uses no tool (e.g. "hello"): no pills, text stripped as before.
  - Open an old thread from before #66: no pills, no errors.
  - Check a shared thread view if it uses the same decoder.
- **Cross-platform:** web plus the iOS simulator at minimum, for the pill list and the source
  sheet (RTL Arabic rendering).
