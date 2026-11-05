# Phase 4, iteration 1: response to review

## Codex (REQUEST_CHANGES): the database host was printed after the write

**Accepted and fixed in 9a746f1.**

`serviceKeys()` used to collect every line and return them, and `main()` printed them only after the run. So the `Auth database: hostname:port` line appeared after `runServiceKeys()` had already written. The spec asks for the host to be printed before any write.

- `ScriptDeps` now has a `print` callback, and `serviceKeys()` emits each line as it is produced. The host line is emitted before `parseArgs`, `connect()` and `runServiceKeys()`. `main()` passes `console.log` and no longer prints the buffer.
- Test: for every subcommand, the host test asserts that the first `print` call is the host line, that it comes before `connect()` (by `invocationCallOrder`; nothing can write before `connect()`), and that the printed lines equal the returned lines, in order.
- Negative test: putting the buffered behaviour back (print everything after the run) turns 6 tests red. The restored code is green (73/73), and the demo harness still passes both of its checks.

## Gemini (COMMENT)

The Gemini lane was skipped: its CLI (`agy`) exited with code 3. There is nothing to address.
