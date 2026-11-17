# air-403 — scope refusals on hydrogen; per-role message length cap on /api/v1/chat/completions

## 2026-11-16 — implement

- **Prompt.** Only the four numbered items under "For questions outside Islamic knowledge domain" changed in `apps/api/lib/ai/prompts/facilitator.ts`; the heading and item 4 are untouched. Items 1 and 2 used to tell the model to explain that it is specialized in Islamic topics and to suggest reformulating. They now forbid refusing on scope and forbid asking the user to reformulate, and ask for a real answer to everyday advice questions with the Islamic perspective where relevant. Item 3 still acknowledges the limits of expertise, but after helping. The exact wording is quoted in the PR body for the owner to approve at the pr gate.
- **Not verified by me: whether the new wording stops the refusals on hydrogen.** I ran no model. The architect replays JLS-046 and JLS-116 on this branch.
- **Prompt sha.** Nothing in the repo pins it. `apps/eval/run.ts` hashes the prompt at run time and writes it into the results file. The two reports under `codev/experiments/393-model-eval-harness/results/` record the old sha as history and are left alone. A run after this merge will show a new sha, so its numbers are not comparable with those two without saying so.
- **Length cap.** `MAX_MESSAGE_CHARS = { system: 8000, user: 8000, assistant: 32000 }`, checked per message. The 400 reads `messages.1.content: this assistant message is 32001 characters long; the limit for assistant messages is 32000`. Status, `type` and `code` (`invalid_body`) are unchanged.
- **Surprise: why staging said only "Invalid input".** zod 4 installs its English messages as a side effect of being imported (`config(en())` in `zod/v4/classic/external.js`), and its package.json says `sideEffects: false`. The production bundle drops that call, so every zod message without wording of its own is "Invalid input" on a deployed server. Unit tests never see this because they run unbundled. Reproduced on a local `next build` + `next start` with `NODE_ENV=production` and dummy env: a bad role, an empty `messages` array and `temperature: 9` all answered "Invalid input".
- **Fix for this route only.** The route passes `z.locales.en().localeError` to its `safeParse`. After a rebuild the same three requests answer `Invalid option: expected one of "system"|"user"|"assistant"`, `Too small: expected array to have >=1 items`, `Too big: expected number to be <=2`. A unit test removes the library default and asserts the route still names the problem; it fails without the explicit messages.
- **Left for the owner: the same defect on every other route.** Twelve v2 route files, 13 call sites (login, register, refresh, threads, chat, feedback, password reset, app-check, mcp-complete) return zod issue messages to clients, and `lib/config.ts` prints them for a bad env var. Wherever a schema has no explicit message, production says "Invalid input". A one-line global fix (`z.config(z.locales.en())` in `lib/config.ts`) would change the error text those routes send to the mobile app, and that contract is frozen without the owner's approval, so I did not make it. Sent to the architect.
- **Consistency with #400 (`builder/pir-400`, unmerged).** #400 refuses a request at 200,000 estimated tokens (UTF-8 bytes / 4), after the per-message check. One message at the new cap is at most 96,000 bytes, about 24,000 tokens, so no single accepted message can trip it. A request of 40 messages at the caps can: 20 assistant messages of 32,000 ASCII characters plus 20 user messages of 8,000 is 800,000 bytes, exactly the block threshold. That request gets #400's `context_length_exceeded`, which is the intended answer for it. The two branches touch different parts of `route.ts`; my tests sit before the "model routing" block so they do not collide with #400's, which are appended at the end of the file.

## 2026-11-17 01:14Z — holding

- The architect asked for no build, typecheck or test run until about 01:28Z, because pir-400 is re-running its porch checks and failed once from machine load. Code is committed. What remains: `porch done 403` (its build and full-suite checks are the one full run), then the PR. Waiting for the architect's all-clear before starting it.

## 2026-11-17 01:30Z — first porch run refused, waiting for a second window

- The architect cleared one capped run at 01:25Z. `porch done 403`: `build` passed; `tests` failed after 287 s.
- api 1354 passed (94 files, 3 skipped), auth 635 passed, eval 145 passed. Frontend 763 passed, 11 failed, all in `hooks/useKeyboard.web.test.ts` (`window.localStorage` undefined). This branch does not touch the frontend.
- Cause: my shell's Node is 26.3.1 and the repo pins 22 (`.nvmrc`). It is the known Node 26 failure recorded in the bugfix-383, air-397 and bugfix-399 threads. I should have launched the check as bugfix-399 did, through `fnm exec --using=22`; Node 22.22.0 is installed.
- Not retried. The architect is scheduling runs between builders and allowed one. Asked for a second window.

## 2026-11-17 01:33Z — second porch run refused on a random frontend flake

- Second window granted at 01:30Z; the architect also made the shared checks force Node 22. Ran `fnm exec --using=22 porch done 403`: `build` passed; `tests` failed after 134 s.
- api 1354, auth 635, eval 145 passed. Frontend 773 passed, 1 failed. `useKeyboard.web.test.ts` passes under Node 22.
- The failure: `lib/auth/guest.test.ts > makeGuestPassword > the production generator always clears the bar with room to spare`, `expected 4 to be greater than or equal to 5`.
- Read as a random flake, from the code only. The test draws 500 passwords and wants a score of 5 or more. A generated password scores 6 unless it matches a common pattern (minus 2), and `/^123/` is one. A 14-character password from the 74-character set starts with `123` about 3 times in a million, so about 1 run in 650 fails (my estimate, not measured). A score of 4 still clears the register route's minimum of 3, so no guest registration fails.
- Not retried, not edited. Sent the output to the architect and asked for a third window.

## 2026-11-17 01:45Z — the guest-password flake: measured, then fixed in this PR

- The architect said not to rerun: confirm the cause by measurement, fix it in this PR so the property holds by construction, do not weaken the assertion.
- **Measured.** One Node 22 process drew 10,000,000 passwords from the real `makeGuestPassword` and scored them with the real `checkPasswordStrength` (`packages/auth/src/password.ts`). 9,999,976 scored 6; 24 scored 4. All 24 started with `123`; no other pattern matched and none was unexplained. That is 2.4 per million draws, so the 500-draw test fails about once in 830 runs. My earlier figure from reading the code (3 per million, 1 in 650) was close but high.
- **Fixed.** `apps/frontend/lib/auth/guest.ts`: a candidate matching one of the four penalised patterns is drawn again, up to 100 times, then the function throws. The pattern list is a copy of the backend's; the frontend cannot import `@ansari/auth` (it pulls in bcrypt and pg). The 500-draw assertion is unchanged.
- **Tests.** A `draw` option forces a candidate: a real `123…` output from the measurement is skipped, as is one for each of the other three patterns, and 100 penalised draws in a row throw. All five fail with the redraw removed.
- Not re-measured after the fix: another 10,000,000 draws would cost four and a half CPU-minutes and the forced-draw tests cover the logic.
