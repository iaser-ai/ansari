# pir-241 thread — Real Terms/Privacy pages (issue #241)

## 2026-10-07 — plan
- AccountChrome has no Terms/Privacy triggers; only Sidebar.tsx footer links change.
- Plan: legal text as typed data (constants/legal.ts) + fixture-equality verbatim test against the issue's markdown; shared LegalPage shell modelled on about.tsx; move About's Section/Para/InlineLink/Ornament into components/ReadingPage.tsx.
- Open question for reviewer: Terms' un-bulleted line runs ("Use of Ansari", "Account Registration") rendered one paragraph per line, not bullets.
