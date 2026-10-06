# pir-223 thread — new Ansari logo

## Plan phase (2026-10-06)
- All vector renderers read `constants/ansariMark.ts`; new artwork's source order is bottom→top, so shapes map diamond←path3, band←path2, wave←path1.
- Brass constants are in artwork units; new viewBox is 246 tall vs 142 → mechanical ×1.73 rescale, then eye-tune.
- `scripts/build-icons.js` never existed in git, but `assets/icon-source/figma-paper-frond.png` survives → plan proposes SVG-brass mark composited on that paper (not flat), recreating the script. Open question for plan-approval: is a designer bronze export of the new mark coming?
