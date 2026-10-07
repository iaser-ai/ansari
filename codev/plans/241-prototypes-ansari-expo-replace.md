# PIR Plan: Real Terms of Service and Privacy Policy pages

## Understanding

The rail's colophon links "Terms" and "Privacy" (`prototypes/ansari-expo/components/Sidebar.tsx:1056-1058`) call `showTerms` / `showPrivacy` (`Sidebar.tsx:276-288`). Both pass one placeholder paragraph to `showNotice` (`lib/notice.ts:15`), which shows a system `Alert.alert` / `window.alert`. The issue asks for two real pages that render the supplied Terms of Service and Privacy Policy **verbatim**, effective date **2026-10-07**, built the way `app/about.tsx` is built: hand-written JSX, `HeaderBar`, the reading column, and the same heading and paragraph type. No markdown renderer.

What I found while investigating:

- `components/AccountChrome.tsx` has **no** Terms/Privacy triggers (grep: zero hits). Only the Sidebar needs to change.
- `footerLink` (`Sidebar.tsx:469-486`) already calls `onNavigate?.()` before its handler, so the phone drawer closes on its own when one of the links navigates, the same way About does (`Sidebar.tsx:1050-1054`).
- `app/_layout.tsx:214-218` turns the paper grain off on "reading" routes (`/chat`, `/about`), and `_layout.tsx:292-296` registers each Stack screen. The new routes need to be added in both places.
- `lib/page-metadata.test.ts` source-scans `TITLE_SOURCES` for em-dashes in `<title>` (#238). The new pages belong in that list.
- `Section`, `Para`, `InlineLink`, the phone back bar and all the styles are **local** to `about.tsx`. Nothing is exported for reuse.
- The app's list treatment lives in `components/AnswerProse.tsx:561-599` / `1148-1175`: a hanging-indent row, a right-aligned `•` marker column (`minWidth 17`, `marginRight 9`), the marker at 0.62 foreground alpha, and a 7px gap between rows.

## Proposed Change

### 1. Legal text as structured data: `constants/legal.ts` (new)

Two documents typed as `LegalDoc = { title; effectiveDate; sections: { heading?: string; blocks: Block[] }[] }`, where `Block = { type: 'p', parts: Inline[] } | { type: 'list', items: Inline[][] }` and `Inline = string | { link: 'privacy' } | { email: string }`.

The text is copied character for character from the issue. Keeping the text as data, separate from the JSX, makes verbatim fidelity mechanically testable (§5). It also leaves the legal wording in one reviewable file instead of scattered across `<Text>` nodes with `&apos;` escapes. The content stays static and hand-written. Nothing is parsed at runtime, so this is not a markdown mechanism.

Mapping rules, following the issue's notes:
- `#` title / first line → page title (`heading(1)`). The Terms source has no `#` on its first line, but it is plainly the title, so both documents get the same treatment.
- `Effective Date: 2026-10-07` → a line under the title, set in the standfirst's italic voice.
- `## X` → section heading (`heading(2)`, About's `heading` / `headingDesktop` style).
- `- item` → list item, using the app's bullet treatment.
- **The un-bulleted line runs** in Terms ("Use of Ansari": 5 lines, "Account Registration": 3 lines) have no `-` markers and no blank lines between them. A literal markdown render would join each run into one paragraph. I will render **each line as its own paragraph**. That keeps the author's line breaks without adding bullets the source doesn't have. (Flag for reviewer: say if you would rather have these as bullets.)
- **Terms → Privacy link**: in the Terms "Privacy" section, "our Privacy Policy" becomes an inline link to `/privacy`. The parenthetical instruction in the issue's source text ("(link to the in-app Privacy page, not a relative `privacy.md` file)") is an editor's note, not legal text, so it is **not** rendered. The sentence reads: "Your use of Ansari is also governed by our [Privacy Policy], which describes how we collect, use, and protect your information."
- `feedback@askansari.ai` is rendered as an inline mail link (via `openEmail`, as About does). The visible text does not change. Note that this differs from About's `feedback@ansari.chat`. The legal text wins here, verbatim.

### 2. Shared page shell: `components/LegalPage.tsx` (new)

One component renders a `LegalDoc`. It follows `about.tsx` structurally:
- web-only `<Head><title>` and `<meta name="description">`
- the `useScreenLandmark` `main` landmark and `useSidebarInset` on desktop
- a `ScrollView` with `barContentTop`, the `READING_COLUMN` max width on desktop and `phoneGutter` on phones
- one `PAGE_ENTER` fade
- a centred masthead (title plus effective date) followed by the `Ornament`
- sections with the same heading and `Para` sizes (`answerSize` / `answerLeading`)
- the closing rule and the "Ask Ansari a question" link
- on phones only, the `HeaderBar` with the glass back button and a short bar title ("Terms" / "Privacy")

Lists reuse AnswerProse's hanging-indent bullet values. Inline links reuse About's `InlineLink` look (underline, strong foreground, 0.4-alpha decoration).

To avoid a third copy, I'll move `InlineLink`, `Ornament`, `Section` and `Para` out of `about.tsx` into `components/ReadingPage.tsx` (new) and import them from both `about.tsx` and `LegalPage.tsx`. This moves code without changing it, so About renders identically. The masthead mark (`AnsariMarkBrass`) stays About-only. The legal pages open on the title, because a legal page should not dress up as a title page.

### 3. Routes: `app/terms.tsx`, `app/privacy.tsx` (new)

Each is a few lines: `<LegalPage doc={TERMS} … />` with its web title, `"Terms of Service · Ansari"` / `"Privacy Policy · Ansari"` (middle dot, per #238), and a one-sentence meta description.

### 4. Wiring

- `components/Sidebar.tsx:276-288`: delete the placeholder `showTerms` / `showPrivacy` and the comment above them. The footer links become `footerLink('Terms', () => router.push('/terms'), 'terms-button')` and the same for Privacy. Drop `showNotice` from the import if nothing else uses it (`confirmDestructive` stays).
- `app/_layout.tsx:214-218`: add `/terms` and `/privacy` to `reading` (no grain under a column of type). `_layout.tsx:292-296`: add `<Stack.Screen name="terms" />` and `<Stack.Screen name="privacy" />`.

### 5. Tests

- `constants/legal.test.ts` (new) — **verbatim check**. The issue's two markdown blocks are stored unchanged as fixtures (`constants/__fixtures__/terms.md`, `privacy.md`). The test serialises each `LegalDoc` back to plain text (title line, effective-date line, `## ` headings, `- ` bullets, paragraphs, with the Privacy link rendered as its words) and asserts it equals the fixture after one documented normalisation: the editor's note about the `privacy.md` link is removed from the fixture. A negative case proves the comparison catches a single changed character and a dropped clause, so the check can actually fail.
- `lib/page-metadata.test.ts`: add `app/terms.tsx` and `app/privacy.tsx` to `TITLE_SOURCES`, and assert both `· Ansari` titles.
- Sidebar: the Terms/Privacy buttons push `/terms` / `/privacy` and no longer call `showNotice`. I'll add this to an existing Sidebar test if the mocks allow it. Otherwise it becomes a source-scan assertion.
- `tsc` + the existing vitest suite stay green.

## Files to Change

- `prototypes/ansari-expo/constants/legal.ts` — new, the Terms and Privacy text as typed data
- `prototypes/ansari-expo/constants/legal.test.ts` + `constants/__fixtures__/{terms,privacy}.md` — new, verbatim test
- `prototypes/ansari-expo/components/ReadingPage.tsx` — new, `InlineLink` / `Ornament` / `Section` / `Para` moved out of About
- `prototypes/ansari-expo/components/LegalPage.tsx` — new, renders a `LegalDoc` as a page
- `prototypes/ansari-expo/app/terms.tsx`, `app/privacy.tsx` — new routes
- `prototypes/ansari-expo/app/about.tsx` — import the moved primitives (no visual change)
- `prototypes/ansari-expo/components/Sidebar.tsx:276-288, 1056-1058` — navigate instead of alert
- `prototypes/ansari-expo/app/_layout.tsx:214-218, 292-296` — reading routes + Stack screens
- `prototypes/ansari-expo/lib/page-metadata.test.ts` — new title sources

## Risks & Alternatives Considered

- **Risk: a transcription error in legal text.** Mitigation: the fixture-equality test against the issue's own markdown, with a proven negative case.
- **Risk: the About refactor changes About.** Mitigation: the code moves without edits, and I'll compare before/after screenshots of About on phone and desktop.
- **Alternative: hand-write each clause as JSX, exactly like About.** Rejected: about 600 lines of near-duplicate JSX across two files, with no mechanical way to prove the text is verbatim.
- **Alternative: bundle the markdown and render it with `lib/markdown.ts` + `AnswerProse`.** Rejected by the issue (no markdown mechanism for static legal content). It would also merge the un-bulleted line runs into single paragraphs.
- **Alternative: leave About untouched and copy its primitives into `LegalPage`.** Acceptable fallback if the reviewer wants zero churn in `about.tsx`. It costs about 100 duplicated lines.

## Test Plan

- Unit: `legal.test.ts` (verbatim + negative), `page-metadata.test.ts` (titles), the Sidebar navigation test, and the full `vitest` + `tsc` run.
- Manual (web, `afx dev`):
  - Desktop: in the rail, click Terms → `/terms` opens in the reading column, the tab shows "Terms of Service · Ansari", and there is no alert. Scroll through all 16 sections. Click "Privacy Policy" in the Privacy section → `/privacy`. Click the email → mail handler. Do the same for Privacy (11 sections, 4 bulleted lists). Back/"Ask Ansari a question" returns.
  - Phone width: open the drawer and tap Terms → the drawer closes and the page shows the back bar titled "Terms". Back returns. There is no grain under the text.
  - About still looks the same as before.
- Cross-platform: iOS/Android use the same RN components with no web-only code beyond `<Head>`. I'll spot-check them in Expo Go if a simulator is available, and otherwise report that they were not run.
