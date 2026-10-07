# PIR Review: Real Terms of Service and Privacy Policy pages

Fixes #241

## Summary

The rail's Terms and Privacy links used to show a system alert with one placeholder paragraph each. They now open real `/terms` and `/privacy` pages that render the supplied Terms of Service and Privacy Policy word for word, effective 2026-10-06. The pages are laid out like About. The legal wording is typed data (`constants/legal.ts`), and a test holds it line for line to the source documents. About's layout components (sections, paragraphs, links, ornament) moved into a shared `components/ReadingPage.tsx`. Review feedback also lightened the italic captions, removed About's em-dashes and the ornament under each page title, and replaced the closing "Ask Ansari a question" link with a button.

## Files Changed

- `prototypes/ansari-expo/constants/legal.ts` (+468 / -0): both documents as typed data
- `prototypes/ansari-expo/constants/__fixtures__/terms.md` (+77 / -0), `privacy.md` (+65 / -0): the issue's source text, with the effective date changed on instruction at review
- `prototypes/ansari-expo/constants/legal.test.ts` (+122 / -0): word-for-word check plus negative cases
- `prototypes/ansari-expo/components/LegalPage.tsx` (+356 / -0): lays out a `LegalDoc` as a reading page
- `prototypes/ansari-expo/components/ReadingPage.tsx` (+269 / -0): `Section`, `SectionHeading`, `Para`, `InlineLink`, `Ornament`, `AskAnsariButton`
- `prototypes/ansari-expo/app/terms.tsx` (+22 / -0), `app/privacy.tsx` (+22 / -0): routes, each with its own web `<Head>`
- `prototypes/ansari-expo/app/about.tsx` (+32 / -234): uses the shared components; em-dashes removed; light-italic captions; no ornament under the title; button at the foot
- `prototypes/ansari-expo/constants/featured.ts` (+8 / -8): em-dashes removed from venues and descriptions
- `prototypes/ansari-expo/components/Sidebar.tsx` (+11 / -18): Terms/Privacy push routes; placeholder `showNotice` calls removed
- `prototypes/ansari-expo/app/_layout.tsx` (+8 / -4): Stack screens and grain-free reading routes
- `prototypes/ansari-expo/components/SidebarLegalLinks.test.ts` (+52 / -0), `lib/about-copy.test.ts` (+30 / -0), `lib/page-metadata.test.ts` (+4 / -0)
- `codev/resources/arch.md` (+2 / -0), `codev/resources/arch-critical.md` (+1 / -1), `codev/resources/lessons-learned.md` (+9 / -0)
- `codev/plans/241-prototypes-ansari-expo-replace.md`, `codev/state/pir-241_thread.md`, `codev/projects/241-…/status.yaml`

## Commits

- `98f2439` [PIR #241] Plan draft
- `f508683` [PIR #241][Phase: implement] feat: real Terms of Service and Privacy Policy pages
- `3ab16f4` [PIR #241][Phase: implement] fix: review round 1 — date, light italics, no em-dashes, no title ornament, Ask button
- plus `chore(porch)` state commits

## Test Results

- `tsc --noEmit`: ✓ pass
- `vitest run`: ✓ pass (35 → 37 files, 518 tests, 18 new)
- porch `build` / `tests` checks: ✓ pass
- Manual verification in headless Chrome over CDP:
  - Desktop 1280×900: the rail's Terms link goes to `/terms` with no dialog. The tab reads "Terms of Service · Ansari" and all 16 section headings render. The inline "Privacy Policy" link goes to `/privacy`, and the rail's Privacy link goes to `/privacy`. About's "Ask Ansari a question" button returns to `/`.
  - Phone 390×844: the back bar is titled Terms or Privacy, and bullet lists show their hanging indent.
  - About renders the same after the components moved, except for the requested changes. Its visible text contains no em-dash.
  - The human reviewer approved the running build at `dev-approval` after one round of feedback.
- iOS and Android were not run. No code is platform-specific beyond the web-only `<Head>`.

## Architecture Updates

- **COLD** `codev/resources/arch.md`: a new paragraph, "Reading pages and legal text (issue #241)", in the prototype section. It covers the shared `ReadingPage` components, `LegalPage` as a pure layout over `constants/legal.ts`, the fixture rule (legal wording changes only with its fixture, and only on instruction), each route owning its own `<Head>`, and the grain-free reading routes.
- **HOT** `codev/resources/arch-critical.md`: the existing "Prototype chat display" map entry now also points to this paragraph. No new critical fact was added.

## Lessons Learned Updates

- **COLD** `codev/resources/lessons-learned.md`: a new section, "Legal pages — prototype (issue #241)", with four lessons:
  - Prove verbatim text with a fixture-equality test that names each allowed difference and has negative cases.
  - A "verbatim" fact can still change at review; change the fixture with the data.
  - A source-scan test needs the literal where it scans, which is why each route owns its `<Head>`.
  - `porch` must be run from the worktree root.
- **HOT** not changed: `lessons-critical.md`'s map is at its 12-topic cap, and none of these lessons is broad enough to displace an existing entry.

## Things to Look At During PR Review

- **Legal text is verbatim apart from three named differences.**
  - The effective date is **2026-10-06**. The reviewer changed it at `dev-approval`; the issue said 2026-10-07. The fixtures carry the new date, and the test comment records why.
  - The editor's note in the Terms ("(link to the in-app Privacy page, not a relative `privacy.md` file)") is not rendered. "Privacy Policy" is a link to `/privacy` in its place.
  - The Privacy title's `# ` marker is dropped.
- **Un-bulleted line runs.** In the Terms, "Use of Ansari" and "Account Registration" are consecutive lines with no markers. Each line is its own paragraph rather than a bullet, as confirmed at plan approval.
- **Email addresses differ.** The legal text uses `feedback@askansari.ai`, kept verbatim. About still uses `feedback@ansari.chat`, and someone should decide whether these should match.
- **About was refactored.** Its layout components moved without edits. The only structural change is that "Recently featured" uses `SectionHeading`. All other visual differences on About are the ones requested in review.
- **The Ask button is on all three pages.** The request was for About, but the legal pages close the same way, so they share `AskAnsariButton`.
- About still has one ornament, before "Recently featured". Only the ornament under the title was asked to go.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-241 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-241`
- **What to verify**:
  - Desktop rail: Terms and Privacy open their pages with no alert, and the tab titles use `·`.
  - In the Terms "Privacy" section, the "Privacy Policy" link opens `/privacy`. The email links open the mail handler.
  - Phone width: open the drawer and tap Terms. The drawer closes, and the back bar returns.
  - About: no em-dashes, light-italic subtitle, no ornament under the title, and "Ask Ansari a question" is a button.
