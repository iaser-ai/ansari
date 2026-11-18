# air-407 thread — Ansari should consider the Islamic perspective on every question (#407)

## 2026-11-17 — implement

- Issue #407 has no comments; the body is the whole direction.
- The change is the one line the owner dictated. In `apps/api/lib/ai/prompts/facilitator.ts` the line added by #405 (starting "Requests for advice or guidance on everyday life") is replaced with: "Islam is an all-encompassing way of life, so consider the Islamic perspective on every question, whatever the topic. Requests for advice or guidance on everyday life (work, family, money, personal decisions) are not outside this domain: answer what was asked, fully and practically, in light of that perspective." The four numbered lines above it and the rest of the prompt are untouched: the prompt diff is 1 line removed, 1 added.
- `apps/api/tests/facilitator-prompt.test.ts` pinned the old sentence. It now pins the new line (directly after item 4, said once) and adds a test that "where it is relevant" is gone and the "Requests for advice…" clause appears once.
- Mutation check: with the old prompt file restored from `HEAD`, 3 of the 15 tests in that file fail (the three that name the new line); with the new prompt all 15 pass.
- The only other copies of the old sentence in the repo are in `codev/state/air-403_thread.md` (a historical log, left as is) and `.builder-prompt.txt` (untracked). No docs or eval fixtures quote it.
- I did not run any model. The live replay of JLS-116, JLS-046, JLS-080 and one unrelated request is the architect's, before the pr gate.

## 2026-11-17 — pr

- `porch done` for implement passed both checks: `build` (31.0s) and `tests` (216.6s; api, auth, eval, frontend), the one full-suite run.
- PR #408 is open against `develop`, with the review in its body. Branch was 0 commits behind `origin/develop` at push.
- No CMAP: one prompt line, wording dictated by the owner. What needs checking is the model's behaviour, and that is the architect's live replay.

## 2026-11-17 — stopped for a reboot (shutdown notice from the architect, 18:08Z)

- Where I stopped: PR phase, `pr` gate requested and NOT approved. Nothing is merged. No work is in progress and nothing is uncommitted except this note.
- CI is green on `f7addf4a` (run 44120360282: api, auth, eval, frontend, gitleaks, whatsapp all pass). This note is a new commit, so CI runs again on it.
- Architect was told: "PR #408 ready for review" (delivered) and "pr gate ready for approval" (held in the mailbox at the time, id e619b6f2).
- Still open, neither mine to do: the architect's live replay of JLS-116, JLS-046, JLS-080 and one unrelated request, and the human's decision on the `pr` gate.
- On resume: run `porch status 407`. If the human's approval has been relayed, run `porch approve 407 pr --a-human-explicitly-approved-this`, then `porch next` for the merge task. If not, wait.

## 2026-11-17 — scope widened by the owner (architect's instruction, 21:19Z)

- Resumed after the reboot at the `pr` gate, branch and remote both at `f9491fc9`, nothing lost.
- The architect relayed, and the issue body (edited 21:19:48Z) now says: the heading "For questions outside Islamic knowledge domain:" and its four numbered lines must go too. The earlier "do not touch the four lines" was the architect's misreading of the owner. With the first version of this PR a Python question was still declined 3 of 3 on `gemini-4-hydrogen`.
- Prompt: the whole section (heading, four lines, the #405 line) is now the one paragraph from the issue, with one blank line before and after. Against `develop` the prompt diff is 6 lines removed, 1 added, in one hunk. Nothing else in the prompt changed.
- Test: `apps/api/tests/facilitator-prompt.test.ts` now asserts each of the five removed lines is gone (and the text of the four items without its list number), that the paragraph appears once, and that it sits between the line before the old section and the line after it with one blank line each side. 20 tests in the file, all pass.
- Mutation checks on that file: prompt as pushed in `f9491fc9` → 7 of 20 fail; blank line before the paragraph removed → 1 fails; item 3 alone left behind as a bullet → 2 fail; restored → 20 pass.
- I first added a check that the prompt never matches `/reformulat/i` and took it out again: it would fail a later, unrelated use of the word, and the line it guarded is already checked by name.
- Local run: `pnpm build` exit 0. Full suite once with `--maxWorkers=2`, exit 0: api 99 files (ran), eval 5 files (ran), auth 18 + 23 files and frontend 61 files / 789 tests (replayed from turbo's cache, their inputs did not change).
- Gate: still requested, not approved. I do not run `porch approve`; the gate is the owner's. The architect replays on staging's model once CI is green.

## 2026-11-18 — pr gate approved by the human

- CI was green on `8e496a1e` (run 44179330547, all 6 jobs). The architect replayed JLS-116, JLS-046, JLS-080 and the unrelated request on `gemini-4-hydrogen`, 3 of 3 each (the architect's report; I ran no model).
- The architect relayed (15:52Z) that the owner explicitly approved the `pr` gate for PR #408 at `8e496a1e`. Before recording it I checked: PR head `8e496a1e`, CI green, PR mergeable and clean. `develop` had 22 newer commits, all in `legacy/whatsapp` and codev docs; none touch the prompt or its test.
- Ran `porch approve 407 pr --a-human-explicitly-approved-this`. Porch pushed its two bookkeeping commits (`8d4d3951`, `6c39565d`), which change only `status.yaml`. The code the owner approved is unchanged.
- Merging PR #408 into `develop` with a merge commit (no squash) once CI is green on the new head.
