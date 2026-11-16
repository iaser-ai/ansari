# pir-400 thread

## Plan (2026-11-16)

Issue #400: thread history is unbounded. Scope fixed by the owner's second comment on the issue:
warn at 150,000 tokens, block at 200,000, plain message when a prompt is too large for a model,
all four entry points, no new route, status or response shape. I read the issue comments before
starting; no Railway variables, credentials or production logs were read.

Plan: `codev/plans/400-thread-history-is-unbounded-lo.md`.

### What I found that changes the design

- The stored `input_tokens` cannot be the measure. It is summed over every model call of a turn
  (`agent.ts:532-545`), so a tool-heavy answer stores several times the thread's size. The plan
  proposes an estimate from the text about to be sent (UTF-8 bytes / 4) for every thread. This
  departs from the signal the issue suggests and is flagged for the plan gate.
- The web app and WhatsApp both use `POST /threads/{id}/chat`; the legacy mobile app uses
  `POST /threads/{id}`. The web app and WhatsApp never show an error frame's message, so a block
  sent down the error path would be invisible to most users.
- The web app re-reads the thread after `done` and offers a retry when it ends on an unanswered
  question. So the warning and the block have to be saved as part of the conversation, not only
  streamed.
- WhatsApp users cannot start a conversation; their one thread is replaced after 3 idle hours.
  The plan proposes separate wording for `source = whatsapp` threads.
- A limit check inside `runFacilitator` would need a new config getter in about 20 test files
  that mock `config` partially. The plan enforces at the routes and pins coverage with a
  source-scan test instead.

### Open

- 4 bytes per token rests on #399's evidence only (4.2 and 4.7 MB threads refused at 1,048,576
  tokens). The plan carries a calibration query and a count query for the architect to run.
- The Inkling prompt-too-large wording reaches the facilitator only after PR #401 merges; rebase
  onto `develop` then.
- Message wording is a proposal for the owner.
