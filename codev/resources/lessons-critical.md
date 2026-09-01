# lessons-critical.md — Always-On Engineering Wisdom (HOT tier)

<!-- HOT tier: capped lessons + a bounded map of lessons-learned.md. Always injected into
every porch phase prompt and into CLAUDE.md/AGENTS.md. CAP: <=10 lessons, <=12 map topics,
<=35 lines. To add a lesson, DEMOTE a weaker one into lessons-learned.md (displacement).
MAINTAIN polices the cap and keeps the map in sync with lessons-learned.md's sections.
STARTER: a few universal lessons are seeded; add your project's as you learn them. -->

## Critical lessons (consult before deciding)
- Check for existing work (PRs, git history) before building from scratch.
- "It compiled" / "tests pass" is not "it works" — verify the real user path before calling it done.
- When stuck (2 failed hypotheses or ~30 min), get an outside perspective instead of guessing.
- Test transactional/atomic behavior against a real DB (pglite), not mocks — a helper that ignores its `tx` executor passes every mocked test but commits nothing atomically.
- Never log a raw driver/DB error object — it can embed user content (email, query params, password hash). Log only `{name, code}`.
- Prefer failures that are loud over checks that are quiet — when a check can pass by not running (unresolved config, warm cache, empty glob, undeclared env, a filter matching no package), prove it fails when it should AND stops failing when restored.
- A verification pattern is code, and untested code is not evidence — negative-test every scan against a known-bad line and a known-good near-miss, then report hit counts rather than a verdict.
- Fix a documentation defect everywhere, not just where you are already editing — a partial fix turns one wrong doc into several that disagree, which is worse than the original error.
- Before attributing a production symptom to code you are reading, confirm the revision production actually runs — prod can be hundreds of commits behind your branch, with the bug already fixed or differently shaped there.
- A `vi.mock` factory that lacks a newly added export throws at the call site; if that site is inside a try/catch (a streaming route's error path), the suite stays green while the failure is swallowed — after adding an export a route calls, grep every factory mock of that module.

## Map of lessons-learned.md (consult when…)
- Auth hardening (spec 4) — consult when working on sessions/tokens, revocation races, anti-oracle responses, or drizzle/pg error handling.
- Gemini history fidelity (issue #70) — consult when persisting replayed payloads, cutting streams mid-loop, or changing the messages schema used by pglite test DDL.
- Tool-call persistence (spec 73) — consult when adding message columns, persisting on error paths, mocking modules routes import, or numbering migrations after a concurrent merge.
- Monorepo migration & verification discipline (spec 48) — consult when verifying build/cache/env changes, writing scan patterns, or fixing docs across a monorepo.
