# air-100 thread — Prototype chat UI: markdown rendering (issue #100)

## 2026-09-01 — orientation + design

Explored `prototypes/ansari-expo`. Key facts that shaped the design:

- `AnswerMessage.tsx` already does custom inline parsing: splits paragraphs on
  blank lines and substitutes `[N]` citation markers with `CitationChip`. Any
  markdown solution must preserve that.
- Vitest runs Node/jsdom only (`lib/**/*.test.{ts,tsx}`); react-native modules
  don't load. `react-native-web` is already a dependency, so component tests can
  alias `react-native` → `react-native-web` under jsdom.
- Streaming today: `streamChat` resolves with the FULL answer; the screen shows a
  ThinkingIndicator while pending and renders the message once, post-invalidate.
  So "streaming-safe" = the parser must tolerate partial markdown without
  crashing/garbling (tested by parsing every prefix of a real answer), and the
  parse is memoized on content.
- Link-opening precedent: `CitationSheet` uses `Linking.openURL` (react-native),
  which react-native-web maps to a new tab. Following that convention.
- PR #69 (air-64) touches `lib/api/*` + README only — no overlap with this change
  (components + new `lib/markdown.ts`).

**Library decision**: no new dependency. `react-native-markdown-display` is
unmaintained (last release 2021, old peer deps vs RN 0.81/React 19) and its rule
system would fight the citation-chip inline pass. Ansari answers use a small,
known markdown subset (bold/italic, headers, lists, blockquote, links). A
~170-line pure parser gives: zero dep risk on RN 0.81/web export, explicit
streaming tolerance (unclosed `**` renders bold-to-end; half links render as
text), and full unit-testability in the existing Node vitest setup.

**Plan**:
1. `lib/markdown.ts` — pure block+inline parser, Arabic run splitter,
   first-strong direction helper.
2. `AnswerMessage.tsx` — render AST: headings, lists, blockquotes (RTL-aware
   border side), links (accent + underline, Linking.openURL), Arabic runs get
   Amiri at a bumped size; citation chips still substituted inside any text run.
3. Tests: parser unit tests (incl. streaming-prefix fuzz over a real
   staging-shaped answer) + jsdom component test of AnswerMessage via
   react-native-web alias (mock reanimated/haptics like lib/auth/context.test.tsx
   mocks its deps).

## 2026-09-01 — implementation complete

- `lib/markdown.ts` (parser + Arabic-run splitter + first-strong direction),
  `AnswerMessage.tsx` renders the AST; citation chips work inside any markdown
  text run. Links via `Linking.openURL` (CitationSheet precedent; new tab on web).
- Tests: 13 parser tests (incl. parse-every-prefix streaming fuzz over a
  staging-shaped sample) + 5 component tests rendering through react-native-web
  under jsdom (`react-native` aliased in vitest.config.ts). Suite 63/63 green,
  typecheck clean.
- `expo export --platform web` builds cleanly (what staging serves).
- Screenshot harness (scratchpad, esbuild + headless Chrome, no staging calls):
  full staging-shaped answer renders correctly — RTL blockquote gets its bar on
  the right, Arabic runs in Amiri at 21px, mixed-direction list items fine;
  mid-stream partial (unclosed bold, half link) renders without crash.
- Native (Expo Go) not verifiable headless — flagged as manual check in PR.
  Rendering uses only standard nested-Text patterns, no web-only APIs.

## 2026-09-01 — PR #103 open, at pr gate

PR #103 (builder/air-100 → develop) with the AIR review in the body and the RTL
screenshot embedded (committed under codev/projects/100-*/). CMAP skipped:
prototype-only UI, no core logic. porch checks green (pr_exists, e2e_tests).
Waiting on human pr-gate approval. Remaining manual items noted in PR: native
(Expo Go) visual glance, and post-merge staging verification.
