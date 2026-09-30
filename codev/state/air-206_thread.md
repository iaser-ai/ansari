# air-206 — composer edge blurry on desktop web (#206)

- Cause: no desktop-only branch existed. The web composer wore a border rim sized in fractions of a device pixel (`max(0.5, 1/DPR)`). At 1x/fractional zoom it became a whole-or-fractional CSS px of translucent white over the page, with the wash clipped to a second inner curve — two antialiased curves at the pill ends = halo. On a 3x phone it was ~invisible. Desktop also had a desktop-gated sheen + lighter blur on the clear home composer.
- Fix: web draws no border. Top highlight = `inset 0 1px 0 composerLip` (new per-mode token: dark 0.06, light 0.7); focus ring = `0 0 0 1px inputRimFocus` box-shadow, fading in with the existing lift. Desktop gates removed → one web recipe. Native (iOS blur, Android, Liquid Glass) unchanged.
- Shadow string extracted to `lib/composer-shadow.ts` (worklet) so it is unit-testable in node.
- Focus: browsers treat text fields as `:focus-visible` on pointer focus too, so "only on :focus-visible" == "on focus" for a textarea; kept the existing `focused` state.
- Verified: headless Chrome screenshots at DPR 1 and 1.25, light and dark — no outline, clean pill ends. Not verified: Safari/Firefox, 110%, non-headless Retina.
