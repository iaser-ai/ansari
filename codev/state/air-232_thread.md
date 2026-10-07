# air-232 — favicon repaint on OS theme switch

## Implement
- Root cause confirmed in real Chrome: the SVG's inner `prefers-color-scheme` query is
  resolved once at rasterise time. A tab open across a scheme flip never re-requests
  the favicon. #230's CDP check looked at the SVG as a document, not at the favicon
  pipeline, so it missed this.
- Fix: inline `<script id="ansari-favicon-scheme">` in `public/index.html`, placed after the
  icon links. On a `matchMedia('(prefers-color-scheme: dark)')` change it *replaces* the SVG
  `<link>` with a clone whose href is `/favicon.svg?scheme=dark|light`. Why replace rather
  than set `href`: a new element is a new candidate. Why a per-scheme URL: a bitmap cached
  under one ink is never served for the other. The clone keeps its position and its lack of
  `sizes`, so the #230 ranking against the `.ico` still holds.
- Verified with a request-logging server, a throwaway headful Chrome profile, and CDP
  `Emulation.setEmulatedMedia` light→dark→light. Fix: `GET /favicon.svg?scheme=dark`, then
  `?scheme=light`. Control (develop's index.html): no favicon request after the first load.
- NOT verified: the pixels in the real tab strip after a real OS flip. Emulated media fires
  the page's `change` event but doesn't change what the browser-side decoder sees. Needs a
  human spot-check (I did not toggle the user's OS theme).
- Corrected the "re-evaluates live" claims in the index.html and build-icons.mjs comments.
