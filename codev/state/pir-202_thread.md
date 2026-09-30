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
