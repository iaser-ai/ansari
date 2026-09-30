# pir-202 thread — composer tap jump / two-tap focus (mobile web)

## Plan phase
- Traced the two-tap bug past the issue's hypothesis: react-native-web 0.21.3's ScrollView
  calls dismissKeyboard() on EVERY scroll event when keyboardDismissMode='on-drag' (no drag
  check). The thread list uses 'on-drag' on web, and its onLayout scrollToEnd (fired by the
  keyboard shim's shell shrink) is a scroll → blurs the composer just tapped.
- The jump: RN-web onLayout is ResizeObserver + setTimeout(0), so one frame paints the short
  list un-scrolled, then scrollToEnd snaps (overshooting by up to the 160px atBottom slack).
- engage()'s synchronous reshape is deliberate (anti-iOS-pan) and is kept.
- Same on-drag mechanism likely affects Sidebar search (components/Sidebar.tsx:759) — flagged
  in plan as a separate issue unless the architect wants it folded in.

## Implement phase
- Architect folded in the Sidebar on-drag fix (same defect) — done in 082ac84.
- ScrollDismiss.test.tsx confirms the root cause empirically: RN-web 'on-drag' blurs a focused
  TextInput on a scroll event no finger made; 'none' does not.
- Shim: onShellResize fires after the forced reflow inside the reshape; chat screen hands back
  exactly the lost height (keepFootInView) instead of scrollToEnd a frame late. Ordering test
  negative-checked (fails when notify moves before the reflow).
- Surprise: my second `porch next` (to read implement instructions) requested dev-approval before
  any code existed; ran `porch done` after the code so build/tests checks actually executed.
- Surprise: repo `build` check fails locally in apps/api (Zod env: USUL_API_TOKEN etc.) — no .env
  in worktree or main. CI exports apps/*/.env.ci; did the same locally → forced uncached build 4/4 ✓.
  Environmental, unrelated to this diff (touches only prototypes/ansari-expo).
