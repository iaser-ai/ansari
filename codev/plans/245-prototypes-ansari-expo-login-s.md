# PIR Plan: Login / sign-up as an in-place modal, with Apple/Google options (UI only)

All paths below are relative to `prototypes/ansari-expo/`.

## Understanding

Signing in currently leaves the reader's screen. Two siblings trigger it:

- `components/AccountChrome.tsx:75` → `router.push('/login')`, `:89` → `router.push('/register')` (desktop top-right).
- `components/Sidebar.tsx:276-279` `goToLogin` → `onNavigate?.()` then `router.push('/login')`. This is the rail-footer "Log in" on desktop. On a phone the same `Sidebar` lives inside `SidebarDrawer`, where `onNavigate` closes the drawer.

Both routes (`app/login.tsx`, `app/register.tsx`) render `components/AuthForm.tsx` full-page. `AppFrame` in `app/_layout.tsx:210-235` special-cases them as `authRoute` and hides the rail, the account corner and the grain. The form's mode switch re-navigates (`AuthForm.tsx:337`, `router.replace(isRegister ? '/login' : '/register')`), and success does `router.replace('/')` (`AuthForm.tsx:124`).

The issue asks for one in-place modal that both entry points open, built on the existing `components/Sheet.tsx`. Switching modes should happen inside the modal. Apple and Google buttons sit above the email form as inert, UI-only stubs.

## Proposed Change

### 1. A module store for "is the auth sheet open, and in which mode": `lib/authSheet.ts` (new)

This mirrors `lib/messageActions.ts` exactly: a module-level value, `useSyncExternalStore`, and `openAuthSheet(mode)`, `setAuthSheetMode(mode)`, `closeAuthSheet()`, `useAuthSheet()`. A store fits better than a React context here for two reasons. First, the app already uses this pattern for a sheet that is mounted once at the root and raised from far away (`MessageActionSheet`, and the phone drawer's store). Second, it needs no provider plumbing in `_layout.tsx`, and callers outside React's tree (such as the route shims below) can call it.

Type: `type AuthMode = 'login' | 'register'`; state is `AuthMode | null`.

### 2. `components/AuthSheet.tsx` (new), mounted once in `app/_layout.tsx`

It sits next to `<MessageActionSheet />` (`_layout.tsx:338`), inside `AuthProvider`, so `useAuth()` works. It renders `<Sheet open={mode !== null} onClose={closeAuthSheet} accessibilityViewIsModal accessibilityLabel=…>`. As `MessageActionSheet` does, it keeps the last mode in local state so the sheet still has content while it animates out.

- **header** (the drag region): the brass mark (smaller, around 32), the display-serif title ("Welcome back" / "Create your account") and the one-line subtitle. It also gets a close (×) control so screen-reader and pointer users have a named way out; `Sheet`'s comments assume one lives inside the card.
- **body**, top to bottom:
  1. **Continue with Apple** (solid black pill with a white apple mark; it inverts to a white pill with a black mark in dark mode, per Apple HIG's black and white styles), then **Continue with Google** (white pill with a hairline `#747775` outline, the four-colour "G", and `#1F1F1F` label, per Google's branding guidelines; Google's dark variant is `#131314` fill with a `#8E918F` outline). Apple comes first, as the issue says. Both are full width at the same height as the existing fields (50), with the pill radius.
  2. A divider: `—— or continue with email ——` (reusing the existing `dividerRow` styling).
  3. Name row (register only), Email, Password, the inline error and the primary submit. All of this is unchanged from `AuthForm`.
  4. A low-key **Continue as guest** text button. It is demoted from a full outlined button because three social and identity buttons stacked above a fourth full-width one is a wall. Its behaviour (`loginAsGuest`) is unchanged.
  5. The mode switch ("New to Ansari? **Create an account**" / "Already have an account? **Log in**"). It calls `setAuthSheetMode(...)`, so there is no navigation and no close. Field values are kept across the switch and the error is cleared. The swap is a short cross-fade of the body (reanimated `FadeIn`/`FadeOut`, `ReduceMotion.System`), and `Sheet` re-measures its height from `onLayout`.
- **Scrolling and keyboard:** the body goes in a `ScrollView` (`keyboardShouldPersistTaps="handled"`), because the register form plus the social buttons can exceed a short phone's sheet cap (`Sheet.tsx:319-321`). On native, the sheet content is wrapped so it clears the keyboard (`KeyboardAvoidingViewCompat` around the body, or a keyboard-height bottom pad from `react-native-keyboard-controller`, whichever behaves correctly inside the `Modal`; I'll verify on iOS). On web, the shell already shrinks to the visual viewport (`hooks/useKeyboard.web.ts`), so nothing extra is needed.
- **Social `onPress`:** inert, with no network call and no `lib/auth/api.ts`. It shows a lightweight `toast('Sign in with Apple isn't available yet', { detail: 'Use your email, or continue as a guest.' })` through the existing `lib/toast`. I chose a toast over doing nothing because a dead button reads as a bug, and the toast cannot be mistaken for authenticating. `ToastStack` is mounted after the sheet in the tree, so the notice renders above the modal on web. On native a `Modal` covers it, so on native the affordance is inline instead: a muted line under the buttons that reads "Not available yet. Use your email below." I'll check which of the two actually renders and keep only that one per platform.
- **Success:** close the sheet and stay where the reader was. One exception: if the current path is a thread (`/chat/…`), it does `router.replace('/')` first. The principal change clears the query cache (`lib/auth/context.tsx:64-66`), and an anonymous or guest thread would refetch under the new account into its load-error screen. This is the same reasoning and the same move `signOut` already makes (`Sidebar.tsx:281-288`, `AccountChrome.tsx:57-61`).
- The `Field` component and form logic move from `AuthForm.tsx` into `AuthSheet.tsx` unchanged.

### 3. Brand marks: `components/BrandMarks.tsx` (new)

This holds `AppleMark` and `GoogleMark` as `react-native-svg` paths taken from each platform's published asset (Apple's logo glyph in a single `currentColor` fill; Google's four-colour "G": `#4285F4`, `#34A853`, `#FBBC05`, `#EA4335`). They are drawn, not font glyphs.

### 4. Rewire the entry points

- `AccountChrome.tsx`: "Log in" → `openAuthSheet('login')`, "Sign up" → `openAuthSheet('register')`. Update the doc comment that says "opening the real auth screen".
- `Sidebar.tsx` `goToLogin` → `onNavigate?.()` then `openAuthSheet('login')`. On a phone, `onNavigate` closes the drawer, which is itself an overlay. Opening a second modal while the first is still leaving is the case `MessageActionSheet` sidesteps with `setTimeout(action, DURATION.exit)`, so the phone path defers the open by `DURATION.exit` when `onNavigate` is present. On desktop the rail is not modal and the sheet opens immediately.

### 5. Fate of `/login` and `/register`: keep them as thin deep-link shims that open the modal over `/`

`app/login.tsx` / `app/register.tsx` become: on mount, call `openAuthSheet(mode)` and `<Redirect href="/" />`. Why:

- External links, bookmarks and any password-manager or browser history entry pointing at `/login` keep working, and they land in the same single flow.
- Keeping `AuthForm` full-page would leave a second, divergent sign-in UI with no Apple/Google buttons and different success behaviour. The issue asks to avoid exactly that inconsistent path.
- Deleting the routes would turn old links into the not-found page for no gain.

Consequences:

- Delete `components/AuthForm.tsx`; all of its live logic now lives in `AuthSheet`.
- In `app/_layout.tsx`, remove the `authRoute` special case (`:210-214`, `:233-234`), since no route renders a form any more. Keep the `<Stack.Screen name="login|register" />` entries.
- `lib/page-metadata.test.ts` lists `components/AuthForm.tsx` as a title source and asserts `'Log in · Ansari'`. A modal does not change the document's route, so it should not retitle the tab either. I'll remove that source and that assertion, and note why in the test.

## Files to Change

- `lib/authSheet.ts` (new): open/mode/close store.
- `components/AuthSheet.tsx` (new): the modal, built on `Sheet`, holding the migrated `Field`, the form logic and the social buttons.
- `components/BrandMarks.tsx` (new): `AppleMark` and `GoogleMark` SVGs.
- `components/AuthForm.tsx`: deleted.
- `components/AccountChrome.tsx:72-100`: open the sheet instead of `router.push`, plus the doc comment.
- `components/Sidebar.tsx:276-279`: `goToLogin` opens the sheet, deferred past the drawer exit on phone.
- `app/_layout.tsx:210-235, 338`: drop `authRoute`, mount `<AuthSheet />`.
- `app/login.tsx`, `app/register.tsx`: open sheet and redirect to `/`.
- `lib/page-metadata.test.ts`: drop the AuthForm title source and assertion.
- `lib/authSheet.test.ts` (new) and `components/AuthSheet.test.tsx` (new): tests (see below).

## Risks & Alternatives Considered

- **Risk: a keyboard covering the fields in a phone bottom sheet.** `Sheet` has no keyboard handling today. Mitigation: wrap the body in `KeyboardAvoidingViewCompat` or pad by keyboard height, and verify on the iOS simulator and mobile-web Safari. If this needs a change to `Sheet` itself, it would be an opt-in prop so the sources and actions sheets are untouched.
- **Risk: stacked modals on phone (drawer leaving while the sheet enters).** Mitigation: the deferred open described in §4.
- **Risk: drag-to-dismiss swallowing a gesture meant for a field.** `Sheet` only attaches the pan to the header region (`Sheet.tsx:380-389`), and the form lives in `children`, so fields are outside the drag region. Accidental dismissal loses the typed values, which is acceptable for an optional sign-in.
- **Risk: a toast hidden under a native `Modal`.** Handled by the per-platform affordance in §2.
- **Alternative: a React context provider in `_layout.tsx`.** Rejected because the module store is the app's established idiom for "one sheet at the root, raised from anywhere", and route shims can call it without hooks.
- **Alternative: keeping `/login` and `/register` full-page.** Rejected because it leaves two divergent sign-in UIs (see §5).
- **Alternative: a new modal primitive.** Rejected per the issue. `Sheet` already provides scrim, drag, dialog-on-desktop, focus trap and reduced motion.
- Out of scope, untouched: `lib/auth/context.tsx`, `lib/auth/api.ts`, any backend or env.

## Test Plan

**Unit (vitest):**
- `lib/authSheet.test.ts`: open sets the mode, `setAuthSheetMode` switches it, close clears it, and subscribers are notified.
- `components/AuthSheet.test.tsx` (jsdom through react-native-web, mocking `useAuth`, reanimated, haptics and `expo-router` as the existing component tests do):
  - Opening in `login` mode shows Email/Password and no name fields. The switch control flips to register mode and shows the name fields, and the sheet stays open with typed email preserved.
  - Apple renders before Google, and both precede the email fields in document order.
  - Pressing Apple or Google calls no `login`/`register`/`loginAsGuest` and shows the "not available yet" affordance.
  - A submit with empty fields shows the inline error. A valid submit calls `login(email, password)` and closes the sheet. A register submit with a password under 8 characters errors.
- `pnpm test` and `tsc`/lint stay green.

**Manual (dev server, `afx dev`):**
- Desktop web, on `/`: top-right "Log in" opens a centred dialog in login mode, and "Sign up" opens it in register mode. The rail-footer "Log in" opens the same dialog. Escape, the scrim and the × close it, and focus returns to the trigger.
- Inside the dialog, "Create an account" ↔ "Log in" swaps content without closing, and the URL never changes.
- Apple and Google look like their platforms' buttons in light and dark mode, and pressing them shows the "not available yet" affordance and nothing else.
- Log in with a real staging account from `/` (stays on `/`, rail shows your name) and from an open thread (returns to `/`). Continue as guest works.
- Visit `/login` and `/register` directly: you land on `/` with the sheet open in the right mode.
- Phone web (narrow window, or a phone on the LAN): open the drawer and tap "Log in". The drawer leaves, then a bottom sheet rises, can be dragged down to dismiss, and the fields stay visible with the keyboard up.
- iOS simulator: the same phone path, with fields clear of the keyboard.
