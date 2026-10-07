# air-238 thread

- Swapped the em-dash for `·` in all four route `<title>`s; `app.json` name "Ansari 4" → "Ansari" (no eas.json/store config depends on it; other "Ansari 4" hits are comments only).
- `public/index.html` had a `<!-- ansari:share-tags -->` marker whose comment claimed `scripts/build.js` injects absolute-URL share tags at export. That script doesn't exist in this repo (Replit-era leftover restored in #129). Replaced the marker with static tags and an accurate comment.
- Caveat: `og:image` is root-relative (`/og-image.png`), as the issue specifies. Facebook and X want absolute URLs, so the card picture won't show there until a production host is known.
- Test: `lib/page-metadata.test.ts` source-scans titles + shell metas; negative-tested by reintroducing an em-dash (2 failures, then green).
