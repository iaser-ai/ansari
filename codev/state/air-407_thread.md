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
