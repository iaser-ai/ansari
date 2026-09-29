# Legacy web frontend — deployed to askansari.ai, outside the pnpm workspace

Snapshot of [`ansari-project/ansari-frontend`](https://github.com/ansari-project/ansari-frontend)
at `multisage` @ `ad72bc60d9a3`. Stack: Expo 52.0.38 / React 18.3.1 / RN 0.76.7.

Reference material for the merge of the two frontend tracks (`develop` and
`multisage`), which diverged at `7f73947` in March 2025 and were never merged
back. **Nothing in this directory is built by turbo or resolved by pnpm.**
`pnpm-workspace.yaml` globs `apps/*` and `packages/*`; `legacy/*` matches
neither, which is the only thing keeping this tree out of the build. Do not
move it under `apps/` without reading issue #150 first.

## Agent instructions for this repository live at the root

Read `/CLAUDE.md` and `/codev/` at the repository root, **not** anything in
this directory. The nested `codev/`, `.claude/`, `.architect-role.md` and CI workflows that
shipped with this snapshot were removed, and the original `CLAUDE.md` /
`AGENTS.md` replaced by this file, precisely because they would otherwise be
read as authoritative here and they are not.

## Deviations from the upstream snapshot

Verified byte-identical at import to `ad72bc60d9a3` except:

- `package.json` `name` is `ansari-frontend-web-legacy`, not the upstream `ansari-chat-app`.
  Both tracks used the same name; keeping them distinct avoids re-arming a
  duplicate-name collision if this tree is ever globbed back into the workspace.
- `package-lock.json`: the root `name` fields follow the rename (2 lines), from a
  local install after import. No resolution changes.
- `yarn.lock`: re-resolved by that install. Upstream's lockfile was stale against
  its own `package.json` (no entries for `@playwright/test@^1.63.0` or
  `serve@^14.2.6`); it now matches, with transitive bumps to `ajv`, `minimatch`
  and `serve-handler`.
- Removed: `.github/`, `codev/`, `.claude/`, `.architect-role.md`, `.codev/`.
- `.vscode/` (3 files) is ignored by the root `.gitignore` and is absent here.

`package-lock.json` and `yarn.lock` are kept deliberately: they are the only
record of this track's intended dependency pins, which the merge will need.
The `packageManager` pin and any npm-syntax `overrides` are inert outside the
workspace and were left untouched.

## Local fixes on top of the snapshot

askansari.ai now builds from this tree, so it carries fixes that upstream does not have.
When the two frontend tracks are merged (#150), do NOT resolve these files by taking
upstream, because that silently reverts the fix:

- #164, follow a streaming answer and the jump-to-latest button:
  - `src/components/chat/MessageList.tsx`
  - `src/components/chat/ChatContainer.tsx`
  - `src/components/svg/ScrollToBottomIcon.tsx`
  - `e2e/chat-scroll.spec.ts`
  - `playwright.config.ts`
  - `.gitignore`
- #182, the composer stays put while a streamed answer is followed. On the live chat the message list is its
  own scroller, sized by the layout rather than by its content (`flexBasis: 0` on web), so the composer and
  footer no longer sit in the page's scroll flow:
  - `src/components/chat/MessageList.tsx`
  - `e2e/chat-scroll.spec.ts`

To recover the exact upstream tree:
```
git -C <clone-of-ansari-frontend> archive ad72bc60d9a3 | tar -x -C <dest>
```
