# Ansari agent skill

[`ansari/`](ansari/SKILL.md) is an [Agent Skill](https://agentskills.io) that answers questions about Islamic theology, history, ethics and practice by asking Ansari, which grounds its answers in the Quran, Hadith collections and classical scholarship. It works with Claude (web, desktop and Claude Code), GitHub Copilot, OpenAI Codex CLI, Cursor, Gemini CLI and any platform that supports the [Agent Skills specification](https://agentskills.io/specification).

The skill asks Ansari through its MCP server, `https://mcp.askansari.ai/mcp` ([`apps/mcp`](../apps/mcp/README.md)). When the assistant already has that server connected, the skill uses its `answer_islamic_question` tool; otherwise it sends one MCP `tools/call` request with `curl`. It holds no credential: the MCP server calls the Ansari API with its own key.

This directory is not part of the pnpm workspace. Nothing here is built, installed or deployed by the monorepo.

It replaces [ansari-project/ansari-skill](https://github.com/ansari-project/ansari-skill), deprecated on 2026-11-25.

## Installation

The skill is one file, `ansari/SKILL.md`, in a directory that must be named `ansari`. Every install below puts that file at `<skills directory>/ansari/SKILL.md`.

```bash
SKILL_URL=https://raw.githubusercontent.com/iaser-ai/ansari/develop/skills/ansari/SKILL.md
```

### Claude.ai / Claude Desktop

Claude.ai takes the skill as a zip upload. Build `ansari-skill.zip` (see [Building the zip](#building-the-zip)), then:

1. Open **Settings > Customize > Skills**
2. Upload `ansari-skill.zip`
3. Toggle the skill on

Without a checkout, the zip is the downloaded file in a directory named `ansari`:

```bash
mkdir ansari && curl -fsSL "$SKILL_URL" -o ansari/SKILL.md && zip -r ansari-skill.zip ansari
```

### Claude Code

```bash
# Project-level
mkdir -p .claude/skills/ansari && curl -fsSL "$SKILL_URL" -o .claude/skills/ansari/SKILL.md

# Or user-level (available in all projects)
mkdir -p ~/.claude/skills/ansari && curl -fsSL "$SKILL_URL" -o ~/.claude/skills/ansari/SKILL.md
```

### VS Code / GitHub Copilot

```bash
# Project-level (recommended)
mkdir -p .github/skills/ansari && curl -fsSL "$SKILL_URL" -o .github/skills/ansari/SKILL.md

# Or user-level
mkdir -p ~/.copilot/skills/ansari && curl -fsSL "$SKILL_URL" -o ~/.copilot/skills/ansari/SKILL.md
```

### OpenAI Codex CLI

```bash
# Project-level
mkdir -p .codex/skills/ansari && curl -fsSL "$SKILL_URL" -o .codex/skills/ansari/SKILL.md

# Or user-level
mkdir -p ~/.codex/skills/ansari && curl -fsSL "$SKILL_URL" -o ~/.codex/skills/ansari/SKILL.md
```

Restart Codex after installing. See [Codex Skills docs](https://developers.openai.com/codex/skills/).

### Cursor

```bash
mkdir -p .cursor/skills/ansari && curl -fsSL "$SKILL_URL" -o .cursor/skills/ansari/SKILL.md
```

### Gemini CLI

```bash
mkdir -p ~/.gemini/skills/ansari && curl -fsSL "$SKILL_URL" -o ~/.gemini/skills/ansari/SKILL.md
```

Enable skills in Gemini CLI: run `gemini`, type `/settings`, search for "Skills", toggle to `true`.

### OpenClaw

```bash
# User-level
mkdir -p ~/.openclaw/skills/ansari && curl -fsSL "$SKILL_URL" -o ~/.openclaw/skills/ansari/SKILL.md

# Or project-level
mkdir -p skills/ansari && curl -fsSL "$SKILL_URL" -o skills/ansari/SKILL.md
```

### Any Agent Skills-compatible platform

Put `ansari/SKILL.md` in your platform's skills directory, keeping the directory name `ansari`.

## Upgrading from ansari-project/ansari-skill

Copies installed from the old repository call an Ansari API route with no key. That route will start requiring a key, and those copies will then stop working. Replace them:

- **Claude.ai / Claude Desktop:** remove the old skill in **Settings > Customize > Skills**, then upload a new `ansari-skill.zip` built as above.
- **All other platforms:** replace `ansari/SKILL.md` in your skills directory with the new file (the commands above overwrite it).

## Building the zip

```bash
sh skills/build-zip.sh                 # writes ./ansari-skill.zip
sh skills/build-zip.sh /tmp/out.zip    # or to a path of your choice
```

The zip holds `ansari/` and `ansari/SKILL.md`, the same layout as the old repository's `ansari-skill.zip` release asset. This repository does not publish the zip as a release yet.

## How the skill calls Ansari

One HTTP request, no session: a JSON-RPC `tools/call` for `answer_islamic_question`, posted to `https://mcp.askansari.ai/mcp` with `Accept: application/json, text/event-stream` (the server answers 406 without both). The server is stateless, so no `initialize` comes first.

The response may come in either of two shapes, and the skill's parser reads both:

- **A server-sent event** (`event: message`, then a `data:` line holding the JSON-RPC reply). The skill's request carries no MCP protocol-version envelope, so the MCP SDK classifies it as a legacy request and answers it as SSE, even when the server is set to JSON responses (`MCP_RESPONSE_MODE=json`).
- **A plain JSON body.** The server sends this only for a request with the modern (2026-07-28) envelope while it is in JSON mode. The skill does not send that envelope today, but the response mode is a deployment setting and the SDK's classification can change, so the parser does not depend on either.

The question goes in through a quoted heredoc and is JSON-encoded by `python3`, so the shell never interprets it.

## Limits

These come from the MCP server ([`apps/mcp`](../apps/mcp/README.md)):

- One question per call, 1 to 4,000 characters.
- Each call has a 60-second budget.
- Every call runs a real model call on Ansari's side. The skill asks the assistant to call once per question and retry at most once.
- All MCP traffic, from this skill and from every MCP host, shares the MCP server's one Ansari API key and its rate limits.

The skill contains no secret and must never contain one.

## License

MIT. The skill came from [ansari-project/ansari-skill](https://github.com/ansari-project/ansari-skill), whose license, `Copyright (c) 2026 Ansari Project`, is kept in [`LICENSE`](LICENSE). The rest of this repository is MIT © IASER ([`../LICENSE`](../LICENSE)).
