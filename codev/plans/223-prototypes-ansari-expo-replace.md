# PIR Plan: Replace the Ansari mark with the new logo (prototypes/ansari-expo)

## Understanding

Issue #223 asks for the new three-piece logo (crown diamond / chevron band / foot wave, 216×246 viewBox) to replace the current mark everywhere in `prototypes/ansari-expo`, keeping the existing treatments: the struck-brass emblem, the 3D spin coin, the staggered pulse ("loading animation"), and the raster icon/favicon/splash/OG set.

What the code actually looks like (all paths relative to `prototypes/ansari-expo/`):

- **One vector source.** `constants/ansariMark.ts` holds `ANSARI_MARK_VIEWBOX` (106×142), `ANSARI_MARK_SHAPES` (`star`, `band`, `arcs`, in visual top→bottom order), the legacy `ANSARI_MARK_PATHS` (source order: star, then arcs+band in one string), the joined `ANSARI_MARK_PATH`, and `ANSARI_MARK_EMBLEM_HEIGHT = 32`. Every renderer reads from here:
  - `components/AnsariMarkPulse.tsx` — three opacity layers, staggered by index of `ANSARI_MARK_SHAPES` (top→bottom). Used by `ThinkingLine.tsx:78` (15 px, "Searching…") and `:174` (32 px, `GeneratingMark`).
  - `components/AnsariMarkBrass.tsx` — emboss stack over `ANSARI_MARK_PATH`. Used by `Sidebar.tsx:607` (32 px), `about.tsx:328` (40/46 px), `AuthForm.tsx:205` (40/44 px).
  - `components/AnsariMarkSpin.tsx` — the phone hero coin (`app/index.tsx:627`), flat `ANSARI_MARK_PATH` with edge plies.
  - `components/AnsariWordmark.tsx` — flat, reads `ANSARI_MARK_PATHS`; no importers (left in place, per the issue).
- **Brass constants are in artwork units.** `AnsariMarkBrass.tsx:57-86` — `BLEED = 8`, `SHADOW_DX/DY = 2.2/2.7`, `SHADOW_BLUR = 1.8`, `EDGE_OFFSET = 1.7`, `HIGHLIGHT_WIDTH = 1.6`, `GRAIN_FREQUENCY = 0.07` — all quoted against the 142-unit-tall viewBox. The new viewBox is 246 tall (×1.73), so leaving the numbers alone would shrink every offset to ~58 % of its current pixel size. They must at minimum be rescaled, then checked by eye.
- **Aspect ratio changes.** 106/142 = 0.746 → 216/246 = 0.878. At the 32 px emblem height the mark grows from ~24 px to ~28 px wide. Every renderer derives width from `ANSARI_MARK_ASPECT_RATIO`, so nothing hard-codes width, but the sidebar brand row, About masthead and auth header gain ~4–6 px of mark width and need a visual check.
- **New artwork's source order is bottom→top**: path 1 = foot wave (y 150–246), path 2 = chevron (y ~75–170), path 3 = diamond (y 0–72). So the mapping into `ANSARI_MARK_SHAPES` (visual order) is diamond ← path 3, band ← path 2, wave ← path 1.
- **Rasters are independent exports.** `assets/images/{icon,adaptive-icon,splash-icon,splash-icon-dark}.png` (1024²) and `public/{favicon.ico (16+32), icon-192, icon-512, icon-maskable-512, apple-touch-icon (180), og-image (1200×630)}.png` all carry a photographic brass rendering of the OLD mark. `public/index.html:~145` says they come from `scripts/build-icons.js`, which does not exist (never committed — `git log --all` has no trace). However, **both Figma sources it consumed are in the repo**: `assets/icon-source/figma-paper-frond.png` (the palm-shadow paper, 1586×992 — no mark on it) and `figma-bronze-mark.png` (the old mark in photographic bronze — useless for the new shape). `assets/images/adaptive-icon-background.png` is paper only, no mark — it stays as is.

## Proposed Change

### 1. Vector swap — `constants/ansariMark.ts`

- `ANSARI_MARK_VIEWBOX = { width: 216, height: 246 }`.
- `ANSARI_MARK_SHAPES` becomes `diamond` (path 3), `band` (path 2), `wave` (path 1), with the `d` strings copied verbatim from the issue's SVG. Renaming `star`/`arcs` → `diamond`/`wave` because the names now describe the wrong shapes; `name` is only used as a React key, and `AnsariMarkPulse`'s local variables follow.
- `ANSARI_MARK_PATHS` loses its "historical source order" quirk: it becomes `ANSARI_MARK_SHAPES.map(s => s.d)`. Its one consumer (`AnsariWordmark`) draws all paths in one fill, so order is irrelevant. `ANSARI_MARK_PATH` stays the space-joined form.
- Rewrite the doc comments that describe the old artwork (eight-point star, nested arcs, "arcs first inside one subpath string").
- `ANSARI_MARK_EMBLEM_HEIGHT` stays 32 (height is the design axis everywhere; only width grows).

**No change to `AnsariMarkPulse`'s animation logic** — it already pulses `ANSARI_MARK_SHAPES` top→bottom, and the new artwork has the same three top/middle/bottom pieces. Only the two renamed locals and its "the wave runs down the mark" comment touch.

### 2. Brass re-tune — `components/AnsariMarkBrass.tsx`

Two steps, kept separate so the review can see which numbers were mechanical and which were by eye:

1. **Mechanical rescale** by 246/142 so every offset keeps its current pixel size: `BLEED 8→14`, `SHADOW_DX 2.2→3.8`, `SHADOW_DY 2.7→4.7`, `SHADOW_BLUR 1.8→3.1`, `EDGE_OFFSET 1.7→2.9`, `HIGHLIGHT_WIDTH 1.6→2.8`, `GRAIN_FREQUENCY 0.07→0.04`. Update the "one unit is under a quarter of a pixel" comment to the new unit size (~0.13 px at 32 px).
2. **By-eye tune** against screenshots of the sidebar (32 px), auth/About (40–46 px) and phone hero (Spin), light and dark. The new mark is bolder and flatter (long straight chevron edges, big wave mass) than the delicate star/arcs, so I expect the highlight sliver and edge to read stronger on it; I'll adjust from screenshots, not guess. Any departures from the mechanical values get a one-line comment.

Same pass over `components/AnsariMarkSpin.tsx`: check whether its edge-ply constants (`EDGE_REACH`, `THICKNESS`, lines ~59–80) are in artwork units or fractions of size; rescale only if they are in units.

### 3. Raster assets — recreate `scripts/build-icons.mjs`

Rather than the issue's flat-fill fallback, I propose a middle path that keeps the established look, because the paper half of the old composite is still in the repo:

- New `scripts/build-icons.mjs` (the script `index.html` already cites, as an ES module so it can import `constants/colors.ts` values via a plain object export; the `index.html` comment is updated to the real filename). It:
  1. Builds a static SVG of the new mark using **the same brass stack as `AnsariMarkBrass`** (gradient, shadow, dark edge, masked highlight — the light palette from `constants/colors.ts`, values imported, not copied), scaled up for 1024 px.
  2. Rasterises it with `sharp` (added as a `devDependency` of the prototype only; it is already in the pnpm store transitively, but not resolvable from the prototype).
  3. Composites onto a crop of `assets/icon-source/figma-paper-frond.png` for the "mark on palm-shadow paper" sizes: `icon.png`, `icon-512.png`, `icon-192.png`, `apple-touch-icon.png`, `icon-maskable-512.png` (mark inside the 80 % maskable safe zone), `og-image.png` (1200×630, mark centred as today).
  4. Emits transparent-background `splash-icon.png`, `splash-icon-dark.png` (dark brass palette) and `adaptive-icon.png` (mark inside the 66 % adaptive safe zone) — the same composition the current files use.
  5. Emits `favicon.ico` as the "brass tile with the mark knocked out in white" treatment the `index.html` comment describes, at 16/32/48 (writes the ICO container directly — PNG-in-ICO is a 22-byte header per entry, no extra dependency). Note: the current `.ico` only carries 16+32; the comment claims 48 too. I'll emit all three so the comment becomes true.
- Committed outputs are the generated files; the script is re-runnable via `pnpm --filter ansari-expo build:icons` (new script in `package.json`).
- `adaptive-icon-background.png`, `figma-paper-frond.png` unchanged. `figma-bronze-mark.png` is the old mark — **delete it** (it can only mislead a future regeneration), unless you'd rather keep it as history.

**Designer exports preferred if available.** If a designer can supply the new mark in the photographic Figma bronze (a `figma-bronze-mark.png` equivalent for the new shape), the script's step 1–2 swaps to compositing that PNG instead of the SVG brass, and every raster regains the photographic metal. I'll structure the script so that is a one-line source switch. Please say at plan-approval whether that export exists / is coming; otherwise I proceed with the SVG-brass composite.

### 4. Docs

- `public/index.html` icon comment — correct the script filename and the `.ico` size list.
- `codev/state/pir-223_thread.md` — decisions log, committed with the PR.

## Files to Change

- `prototypes/ansari-expo/constants/ansariMark.ts` — viewBox, three paths, shape names, `ANSARI_MARK_PATHS`, comments.
- `prototypes/ansari-expo/components/AnsariMarkPulse.tsx` — rename `star`/`arcs` locals + comment; no logic change.
- `prototypes/ansari-expo/components/AnsariMarkBrass.tsx:28-86` — rescaled + eye-tuned constants, updated size comment.
- `prototypes/ansari-expo/components/AnsariMarkSpin.tsx:~59-80` — rescale edge constants only if they're in artwork units.
- `prototypes/ansari-expo/scripts/build-icons.mjs` — new, regenerates every raster.
- `prototypes/ansari-expo/package.json` — `sharp` devDependency, `build:icons` script (+ `pnpm-lock.yaml`).
- `prototypes/ansari-expo/assets/images/{icon,adaptive-icon,splash-icon,splash-icon-dark}.png` — regenerated.
- `prototypes/ansari-expo/public/{favicon.ico,icon-192.png,icon-512.png,icon-maskable-512.png,apple-touch-icon.png,og-image.png}` — regenerated.
- `prototypes/ansari-expo/assets/icon-source/figma-bronze-mark.png` — deleted (see above).
- `prototypes/ansari-expo/public/index.html:~145` — comment fixes.
- `prototypes/ansari-expo/constants/ansariMark.test.ts` — new (see Test Plan).
- `app.json`, `site.webmanifest` — no change (same filenames, same colours).

## Risks & Alternatives Considered

- **Risk: brass emboss looks wrong on the bolder silhouette.** Mitigation: mechanical rescale first, then by-eye tune from light/dark screenshots at every size it's used; screenshots attached to the PR and offered at dev-approval. This is the part that most needs your eyes.
- **Risk: ~17 % wider mark crowds the sidebar brand row / auth header / About masthead.** Mitigation: screenshot each; if any row crowds, reduce that call site's height a touch rather than squash the mark.
- **Risk: SVG-brass rasters look less rich than the old photographic bronze** (no real scratches/micro-texture). Mitigation: it matches what users see in-app (the same `AnsariMarkBrass` stack), keeps the palm-shadow paper, and the script makes swapping in a designer export a one-liner.
- **Risk: favicon legibility at 16 px** — three pieces on a tile at 16 px is tight. Mitigation: render and inspect 16/32 at 1:1; if the diamond disappears at 16 px, nudge padding rather than redraw.
- **Risk: `sharp` adds a native devDependency to the prototype.** It's dev-only, already in the lockfile transitively, and only `build:icons` uses it; nothing at app runtime changes.
- **Alternative: flat solid-fill icons on `#E7E5E4` / `#13100E`** (the issue's default). Rejected as the first choice only because the paper source survived and an SVG-brass composite keeps the established look for little extra work; it remains the fallback if you prefer flat.
- **Alternative: headless Chrome to rasterise** (renders `feTurbulence` grain exactly as web does). Rejected: heavier and less reproducible than sharp; the grain is a 5 %-opacity pass the icons don't need.
- **Alternative: keep the `star`/`arcs` names** to minimise diff. Rejected: they'd describe shapes that no longer exist.

## Test Plan

- **Unit** (`constants/ansariMark.test.ts`, vitest):
  - `ANSARI_MARK_SHAPES` has exactly 3 entries named `diamond`, `band`, `wave`, in that order.
  - Visual order holds: parse each `d`'s y-coordinates and assert each shape's min-y is below the previous shape's (diamond top < band top < wave top) — guards against a future swap re-introducing the source-order mismatch the pulse depends on.
  - All coordinates lie within the 216×246 viewBox; `ANSARI_MARK_PATH` equals the three `d`s joined.
- **Existing suite**: `pnpm --filter ansari-expo test` and typecheck green (`ThinkingLine.test.tsx` renders the pulse).
- **Script**: `pnpm --filter ansari-expo build:icons` runs clean and regenerates byte-for-byte on a second run (deterministic); `file`/`sips` confirm every output's dimensions match today's.
- **Manual (dev-approval, web via `afx dev`)**, light and dark:
  - Desktop sidebar rail emblem (32 px brass) — emboss reads as raised metal, not outlined/sticker.
  - Sign-in screen and About masthead (40–46 px brass).
  - Phone-width home hero: Spin coin renders, drags/spins, edge plies look right.
  - Ask a question: the "Searching…" line (15 px) and the generating mark (32 px) pulse diamond → band → wave; with OS reduced-motion on, mark holds still at mid-light.
  - Browser tab favicon, `/icon-192.png`, `/apple-touch-icon.png`, `/og-image.png` show the new mark.
- **Cross-platform**: iOS/Android — the brass/pulse/spin are the same react-native-svg code (grain is web-only and already gated); native splash/app icon only change via a dev-client rebuild, which I'll note in the PR rather than claim to have verified.
