---
name: session-start
description: >
  Smart session boot: loads project context, recent handoffs, and warnings.
  Use when the user says "session start", "catch me up", "where were we", or "/session-start".
  Reads pre-gathered context from cache (populated by SessionStart hook) and supplements
  with vault reads for a comprehensive briefing.
---

# Session Start

Load context and present a concise project briefing. Be fast — this should feel instant, not ceremonial.

## Step 1: Read Pre-gathered Context

Read `~/.claude/cache/session-context.json` (written by session-context-preloader hook).

If the file exists, extract:
- `detectedProject` — the project matched from cwd
- `vaultProjectPath` — where to find vault docs
- `recentSessions` — previews of last 3 session notes

If the file is missing or unreadable, fall back to manual detection:
- Check the current working directory against the Project-Codebase Mapping in CLAUDE.md (always in system prompt)

If no project matches (e.g., home dir), present a general briefing instead.

## Step 2: Read Project Context

If a project was detected, read the vault README at the path from `agent-os.config.json`:
`<vaultPath>/<vaultProjectPath>/README.md`

Extract:
- Current state / status
- Recent decisions
- Known issues

## Step 3: Recent Sessions

If cache had session previews, use those. Otherwise, use the Glob tool to find the 2 most recent files in `<vaultPath>/Sessions/` and read the first 20 lines of each.

Look for sessions related to the detected project specifically.

## Step 4: Check Warnings

Read `error-patterns.md` from the configured memory directory:
- If the detected project has known gotchas, mention them briefly
- Check for any environment-specific warnings relevant to the current context

## Output Format

```
Session Context Loaded

Project: [name]
Last Session: [date] - [topic from most recent relevant session]

Current State:
- [key bullets from README — max 3-4 lines]

Blockers: [from project README/STATUS, or "None"]
Warnings: [relevant error-patterns, or omit section]

What's the focus today?
```

If no project detected:
```
Session Context Loaded (General)

Recent Sessions:
- [date] - [topic]
- [date] - [topic]

No project detected from current directory.
What are we working on?
```

## Rules
- Keep output concise — this is a briefing, not a report
- Don't read files that don't exist — check gracefully
- If a CODEBASE.md exists in the vault project folder, mention it's available
- All paths come from agent-os.config.json — never hardcode user-specific paths
