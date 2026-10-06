# pir-223 thread — new Ansari logo

## Plan phase (2026-10-06)
- All vector renderers read `constants/ansariMark.ts`; new artwork's source order is bottom→top, so shapes map diamond←path3, band←path2, wave←path1.
- Brass constants are in artwork units; new viewBox is 246 tall vs 142 → mechanical ×1.73 rescale, then eye-tune.
- `scripts/build-icons.js` never existed in git, but `assets/icon-source/figma-paper-frond.png` survives → plan proposes SVG-brass mark composited on that paper (not flat), recreating the script. Open question for plan-approval: is a designer bronze export of the new mark coming?

## Implement phase (2026-10-06)
- Architect: no designer bronze export coming → SVG-brass composite on palm-shadow paper, screenshots required at dev-approval.
- Mechanical ×246/142 rescale of the brass constants held up under an 8× by-eye check in both schemes; no further tuning.
- Emboss numbers moved to `constants/brassEmboss.ts` (plain data) so `scripts/build-icons.mjs` strikes icons with the exact in-app metal; render-neutral (pixel diff ≤ 1).
- Script loads the app's TS constants under bare Node via type stripping + a `registerHooks` stub for `react-native`. Output is byte-deterministic.
- Surprise: vitest's include list skipped `constants/`; a test there would never have run. Added the glob.
- Surprise: the prototype's `pnpm-lock.yaml` is gitignored, so only `package.json` records `sharp`.
- Open for reviewer: icons' relief is gentle at 1024 px (square-root law); an icon-only multiplier is possible but would diverge from the emblem.
- Screenshots: https://claude.ai/artifact/AEkeTRiGNFshQiHwLXBhVm
