# pir-204 thread — compact retrieval trace into a source-category row

## 2026-09-30 — plan
- Investigated: backend emits tool_call{name} / tool_result{tool,query,resultCount} per call; every call gets a result (budget-skips emit resultCount 0). Multiple rounds can re-search a category.
- Decision: keep per-query `traceReducer` (its invariants are the hard part) and add a pure `sourceProgress()` derivation → fixed 4-category row (Qur'an · Hadith · Tafsir · Fiqh), idle 0.35 / searching breathing / done 1.0; label "Searching" → "Reading".
- Open copy questions flagged for reviewer: "Fiqh" for Mawsuah; "Reading" vs "Searched".
