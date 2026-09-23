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

### Inline markers: kept, resolved through the model's own "Citations:" list

The issue says #66 adds no inline `[N]` markers. That is true of #66 itself. However, the
existing facilitator prompt **already tells the model** to write `[1]`, `[2]` inline and a
trailing `**Citations**:` list (`apps/api/lib/ai/prompts/facilitator.ts:116-133`), with each
entry giving "its number, title, and bilingual content". Hadith entries must also carry the
`(LK id …)` token verbatim. Real answers therefore arrive with model-numbered markers **and a
key that says what each number means**. No prompt change is needed, so the Islamic-content
prompt rule is not triggered.

The model's numbering has **no fixed relationship to `documents` array order**, which is
tool-dispatch order after dedup. So we can't just pair `[2]` with `documents[1]`. Instead each
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
   issue asks for the answer's actual sources. *(Alternative the reviewer may prefer: show
   only the cited sources. It is one line either way.)*
6. The trailing "Citations:" section is always removed from the displayed text, because the
   pills replace it.
7. **Fallback:** if nothing resolves (no Citations list, or the model ignored the format),
   behave as a document-only answer: strip every marker and list all documents as pills in
   document order.

This keeps the model's inline references wherever we can prove what they point at. It still
never links a marker by guesswork. `stripUnbackedCitations` still covers answers with no
`documents`, unchanged from #158/#160.

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
   - `documentToCitation(doc): Omit<Citation, 'id' | 'marker'>`: the per-document field
     mapping below.
   - `resolveCitations(content, docs, messageId): { content: string; citations: Citation[] }`:
     the marker-resolution algorithm above (parse the Citations list, match, strip unresolved
     markers, renumber, append uncited documents, drop the list, fall back). `id` is
     `${messageId}-doc-${documentIndex}`, so it stays stable across renumbering.
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
   - `mapMessage`: an assistant message with `documents?.length` gets its `content` and
     `citations` from `resolveCitations(...)`. Everything else gets `[]` as before.
   - Khushu' sample gate: it now applies only when that first assistant answer has **no real
     documents**, and is kept as the fallback demo the issue allows. A real answer is never
     overwritten by sample text or sample sources. (If the reviewer prefers, we delete
     `sample-citations.ts` entirely. That is simple to do, but no demo would remain on an
     environment without #66.)
   - Strip step: unchanged. `stripUnbackedCitations` runs when `citations.length === 0`, which
     is now exactly "no real documents and not the sample". Answers with documents have
     already had their markers resolved and their list removed by `resolveCitations`.
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
- `prototypes/ansari-expo/lib/document-citations.ts`: new, `documentToCitation` +
  `resolveCitations`, reusing the `CITATIONS_SECTION` regex exported from `lib/citations.ts`
- `prototypes/ansari-expo/lib/document-citations.test.ts`: new
- `prototypes/ansari-expo/lib/api/mappers.ts:15-37, 105-170`: attach real citations, narrow the
  sample gate, adjust the strip condition, update comments
- `prototypes/ansari-expo/lib/api/decode.test.ts:219-345`: new real-documents cases; khushu'
  cases updated where their premise changes
- `prototypes/ansari-expo/lib/citations.ts:1-24`: export the section regex; doc comment, `lib/sample-citations.ts:3-39`,
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
- **Risk: the model paraphrases or mangles a Citations entry.** Then that entry doesn't
  resolve, and its marker is stripped rather than mislinked. The degraded case is the
  document-only pill list, never a wrong link. The strong keys (LK id, surah:ayah, volume/page)
  are ones the prompt tells the model to copy verbatim. I will spot-check resolution rates on
  a handful of real answers at dev-approval and report them.
- **Risk: the streamed bubble shows no markers (the stream strips them), then the persisted
  answer shows them after the refetch swap.** That makes the swap visible in a small way. We
  accept it: the stream has no documents to resolve against.
- **Alternative: map markers to documents by position.** Rejected: the model's numbering
  doesn't follow document order, so markers would open wrong sources.
- **Alternative: build citations from the model's Citations list text alone, ignoring
  `documents`.** Rejected: that shows what the model *says* a source contains rather than the
  retrieved text itself.
- **Alternative: strip all markers and show pills only** (the previous draft of this plan).
  Rejected at plan review: we want inline references kept where they can be trusted.

## Test Plan

- **Unit (`document-citations.test.ts`):**
  - Field mapping: one fixture per tool (quran, hadith, tafsir, mawsuah) builds the expected
    `Citation`. Also covered: hadith `LK id` removed from the reference; Quran URL set only for
    a parseable `S:A` title; malformed JSON → raw-text fallback; unknown context → scholarly
    fallback.
  - Resolution:
    - The model's `[1]` names `documents[2]` by LK id, and the marker opens `documents[2]`.
    - Model numbering that is out of document order is resolved correctly.
    - An unresolved entry strips only its own marker.
    - An ambiguous match (two candidates) is unresolved.
    - Renumbering leaves no gaps, and inline markers match pill numbers.
    - Uncited documents are appended after the cited ones.
    - The Citations section is removed.
    - No Citations list → fallback (all markers stripped, document-order pills).
    - The same marker used twice resolves to the same pill.
  - Negative check: a deliberately wrong LK id in the entry must NOT link.
- **Unit (`decode.test.ts`):**
  - An assistant message with `documents` and a matching Citations list decodes with inline
    markers kept, `citations` numbered to match, and no "Citations:" block.
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
    sources and inline superscripts. Tapping a superscript opens the source that its sentence
    cites. I will check this against the model's original Citations text in the raw API
    response. The Qur'an link opens quran.com. No "Citations:" list appears in the prose.
  - Ask something that uses no tool (e.g. "hello"): no pills, text stripped as before.
  - Open an old thread from before #66: no pills, no errors.
  - Check a shared thread view if it uses the same decoder.
- **Cross-platform:** web plus the iOS simulator at minimum, for the pill list and the source
  sheet (RTL Arabic rendering).
