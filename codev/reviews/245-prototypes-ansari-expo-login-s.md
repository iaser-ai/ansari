# PIR Review: Sign in as an in-place sheet, with Apple/Google options (UI only)

Fixes #245

## Summary

In `prototypes/ansari-expo`, signing in no longer navigates to a full-page `/login` or `/register` form. It is now one sheet raised over whatever screen the reader is on: a bottom sheet on a phone and a centred dialog on desktop, built on the existing `Sheet`. The desktop account corner, the rail's footer and the old routes all open it. "Log in" ↔ "Sign up" switches in place. Apple and Google buttons lead the card (Apple first) in each platform's own button style with real SVG marks. They are inert UI and say "not available yet" inline; nothing in `lib/auth` changed. Testing in a real Mobile Safari (iOS Simulator) found two bugs that headless Chrome had hidden: the sheet ran under Safari's toolbar, and a focused field stayed under the keyboard. Both came from the same cause and are fixed by a new opt-in `Sheet` prop, `fitToShell`.

## Files Changed

- `codev/plans/245-prototypes-ansari-expo-login-s.md` (+107 / -0)
- `codev/resources/arch-critical.md` (+1 / -1)
- `codev/resources/arch.md` (+2 / -0)
- `codev/resources/lessons-critical.md` (+1 / -1)
- `codev/resources/lessons-learned.md` (+10 / -0)
- `codev/state/pir-245_thread.md` (+8 / -0)
- `prototypes/ansari-expo/README.md` (+8 / -5)
- `prototypes/ansari-expo/app/_layout.tsx` (+7 / -7)
- `prototypes/ansari-expo/app/login.tsx` (+13 / -3)
- `prototypes/ansari-expo/app/register.tsx` (+11 / -3)
- `prototypes/ansari-expo/components/AccountChrome.tsx` (+6 / -5)
- `prototypes/ansari-expo/components/AuthForm.tsx` (+0 / -480, deleted)
- `prototypes/ansari-expo/components/AuthSheet.test.tsx` (+206 / -0)
- `prototypes/ansari-expo/components/AuthSheet.tsx` (+666 / -0)
- `prototypes/ansari-expo/components/BrandMarks.tsx` (+57 / -0)
- `prototypes/ansari-expo/components/Sheet.tsx` (+40 / -2)
- `prototypes/ansari-expo/components/Sidebar.tsx` (+11 / -2)
- `prototypes/ansari-expo/hooks/useShellFrame.ts` (+64 / -0)
- `prototypes/ansari-expo/hooks/useShellFrame.test.ts` (+101 / -0)
- `prototypes/ansari-expo/lib/authSheet.test.ts` (+46 / -0)
- `prototypes/ansari-expo/lib/authSheet.ts` (+54 / -0)
- `prototypes/ansari-expo/lib/page-metadata.test.ts` (+3 / -3)

## Commits

- `7c4c0ae` [PIR #245] Plan draft
- `235afed` [PIR #245] Plan revised: bottom sheet on phone, defer post-sign-in routing
- `834e2f7` [PIR #245] feat: sign in as an in-place sheet with Apple/Google options (UI only)
- `4617fea` [PIR #245] fix: auth sheet stands in the web shell (above Safari's toolbar and the keyboard)
- `5006164` [PIR #245] thread: simulator verification notes
- `e80ff57` [PIR #245] Review + retrospective
- (this commit) [PIR #245] Address consultation: README, useShellFrame tests

## Test Results

- `pnpm typecheck` (prototype): ✓ pass
- `pnpm test` (prototype): ✓ 549 pass. 23 are new: `components/AuthSheet.test.tsx` (11), `hooks/useShellFrame.test.ts` (7) and `lib/authSheet.test.ts` (5). Breaking the hook's `transitionend` listener fails the matching test, as it should. `lib/page-metadata.test.ts` no longer scans the deleted `AuthForm` title.
- Porch `build` / `tests` checks: ✓
- **Desktop web (headless Chrome over CDP):** the dialog in light and dark mode; both corner links and the rail's "Log in" open it; the mode switch keeps the URL unchanged; Escape closes it and focus moves into the card; `/login` and `/register` land on `/` with the sheet open.
- **Mobile Safari (iOS 18.4 Simulator, iPhone 16, software keyboard, real taps via idb):**
  - At rest, the sheet stops above the toolbar.
  - Focusing Email: the card stands on the keyboard with its header kept, and the field is scrolled into view.
  - Typing works, and dismissing the keyboard restores the card's full height.
  - Dragging from the grabber dismisses the sheet.
  - Drawer → "Log in": the drawer leaves, then the sheet rises.
  - The register face needs a short scroll to reach "continue as a guest" on an iPhone 16; the login face fits.
- **Native iOS: NOT verified.** The prototype aborts at launch in both Expo Go 54.0.6 and a local dev build (a worklet throws on the UI thread). It does exactly the same at the merge-base `7faa031`, so the crash predates this PR, but `KeyboardFoot` (the native keyboard lift) has never run on a device. The dev-approval human review covered the earlier commit (`834e2f7`); `4617fea` landed after that approval and was approved to proceed afterwards.

## Architecture Updates

- **COLD** `codev/resources/arch.md`, under "Prototype chat display": a new **Sign-in sheet (issue #245)** paragraph. It covers the store-driven root sheet, the routes as redirect shims, the deferred post-sign-in routing, and the cross-cutting fact behind `fitToShell`: react-native-web portals a `Modal` into a fixed layer sized to the layout viewport, so it ignores everything that sizes `body` (`100dvh`, the keyboard shortening).
- **HOT** `codev/resources/arch-critical.md`: no new fact (the cap is respected). The existing "Prototype chat display" map line now also says to consult arch.md when touching the sign-in sheet or any web `Modal`/`Sheet` holding fields.

## Lessons Learned Updates

- **COLD** `codev/resources/lessons-learned.md`: a new **Sign-in sheet — prototype (issue #245)** section. It covers:
  - verifying mobile web in the iOS Simulator with idb rather than headless Chrome, with the exact setup;
  - a web `Modal` sitting outside the shell;
  - the #204 `CI=1` stale-Metro trap, which recurred (it was already written down, and not read first) and cost about an hour, plus Safari's own bundle cache;
  - proving the base launches before blaming the PR for a native crash, along with the signing/entitlement and `RCT_jsLocation` recipes;
  - `expo prebuild` silently editing `app.json` and `package.json`.
- **HOT** `codev/resources/lessons-critical.md`: the hot map is at its 12-topic cap, so the #202 map line was extended to cover #245 ("verifying anything on mobile web…", "a dev server seems to ignore your edits") rather than adding a 13th topic.

## Consultation (3-way, single pass)

- **Gemini: COMMENT, skipped.** The `agy` CLI isn't installed on this machine, so no review happened.
- **Codex: COMMENT, no blocking issues.** It noted two small departures from the plan (below).
- **Claude: COMMENT, no blocking issues.** Addressed in this PR:
  - `prototypes/ansari-expo/README.md` still named the deleted `AuthForm.tsx` and described sign-in as a page. Fixed in all three places.
  - Nothing automated exercised `useShellFrame`. Added `hooks/useShellFrame.test.ts` (7 jsdom tests, negative-tested).
  - Not addressed: the real `Sheet` with `fitToShell` still has no automated test; `Sheet` had none before this PR. It is covered by the simulator pass above.
- **Plan drift both reviewers noted (kept, non-blocking):**
  - The mode switch sits above "continue as a guest", where the plan listed guest first.
  - Switching faces fades in only the title and name row, rather than cross-fading the whole body. A full-body `FadeOut` would overlap two forms inside a sheet whose height re-measures.

## Things to Look At During PR Review

- **`components/Sheet.tsx` changed (opt-in).** `fitToShell` touches the shared primitive. With the prop off, `useShellFrame` returns `null` and `Sheet` behaves exactly as before, so the sources and message-action sheets are unchanged. They probably have the same "under Safari's toolbar" issue; that is untested and left as a possible follow-up rather than widened here.
- **`useShellFrame` reads `document.body`'s rect.** It relies on the app's shell contract (`body` is `position: fixed`, `100dvh`, reshaped by `useKeyboard.web.ts`). If that contract changes, this hook has to change with it.
- **Scroll-into-view after the reshape** (`Sheet.tsx`) calls `scrollIntoView({ block: 'center' })` on the focused element if it is inside the card. It only runs while `fitToShell` is on and the shell frame changes.
- **iOS "Use Strong Password?" panel.** On the register password field (`autoComplete="new-password"`), Safari raises this system panel. It is taller than the keyboard, so the page pans under it. Dismissing it restores the layout. This is system UI and the old full-page form had the same trigger.
- **Design calls to sanity-check:**
  - "Continue as guest" is demoted to a text link.
  - The provider "not available yet" note is inline, not a toast, because toasts render under the `Modal`.
  - In light mode the black Apple pill sits above the near-black primary "Log in" button, so two dark buttons compete a little.
- **Post-sign-in routing is deliberately deferred.** It is the reviewer's decision at plan review. The sheet only closes. Signing in from an open anonymous/guest thread therefore leaves that thread mounted while the query cache clears; `signOut` avoids the same thing by going home first.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-245 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-245`. If edits don't show up, make sure Metro was not started with `CI=1`.
- **What to verify**:
  - Desktop: "Log in" / "Sign up" (top right) and the rail's "Log in" open the same dialog; "Create an account" ↔ "Log in" switches in place; Escape, the scrim and × close it.
  - Apple and Google look like their platforms' buttons in light and dark mode, and only show the "not available yet" note when pressed.
  - Sign in from `/`: the sheet closes, you stay on `/`, and the rail shows your name. "Continue as a guest" works.
  - Visit `/login` and `/register` directly: you land on `/` with the sheet open on the right face.
  - Phone (or iOS Simulator Safari): drawer → "Log in" raises a bottom sheet above the toolbar; tapping a field keeps it visible above the keyboard; dragging the grabber dismisses the sheet.
