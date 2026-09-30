# pir-204 thread — compact retrieval trace into a source-category row

## 2026-09-30 — plan
- Investigated: backend emits tool_call{name} / tool_result{tool,query,resultCount} per call; every call gets a result (budget-skips emit resultCount 0). Multiple rounds can re-search a category.
- Decision: keep per-query `traceReducer` (its invariants are the hard part) and add a pure `sourceProgress()` derivation → fixed 4-category row (Qur'an · Hadith · Tafsir · Fiqh), idle 0.35 / searching breathing / done 1.0; label "Searching" → "Reading".
- Open copy questions flagged for reviewer: "Fiqh" for Mawsuah; "Reading" vs "Searched".

## 2026-09-30 — implement
- Plan approved with 'Fiqh' / 'Reading'. Note: porch recorded dev-approval gate-requested right after plan approval, before any code (double `porch next`); flagged to architect.
- Done: `sourceProgress()` + tests; ThinkingLine fixed row (per-word Animated.Text, opacity idle/breathe/done, a11y summary label); component test via react-native-web; arch.md paragraph.
- Could not eyeball in a browser (Chrome extension not connected; live run needs staging login). Web bundle compiles; human check at dev-approval.
