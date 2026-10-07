# pir-241 thread — Real Terms/Privacy pages (issue #241)

## 2026-10-07 — plan
- AccountChrome has no Terms/Privacy triggers; only Sidebar.tsx footer links change.
- Plan: legal text as typed data (constants/legal.ts) + fixture-equality verbatim test against the issue's markdown; shared LegalPage shell modelled on about.tsx; move About's Section/Para/InlineLink/Ornament into components/ReadingPage.tsx.
- Open question for reviewer: Terms' un-bulleted line runs ("Use of Ansari", "Account Registration") rendered one paragraph per line, not bullets.

## 2026-10-07 — implement
- Plan approved (paragraph-per-line confirmed). legal.ts generated from the issue's markdown (fixtures in constants/__fixtures__), then checked in as the source of truth; legal.test.ts compares line-for-line with documented normalisations (Privacy title `# `, the editor's note on the Privacy link) and proves it catches a changed char / dropped clause / list→para.
- Head/<title> lives in the route files, not LegalPage, so page-metadata's source scan sees literal titles.
- Verified in headless Chrome over CDP: rail Terms → /terms with no dialog, tab "Terms of Service · Ansari", 16 h2s; inline "Privacy Policy" → /privacy; phone back bar; About unchanged after the primitive move.
