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

## Step 1: Read Session Memory Cache (PRIMARY — do this first)

Read `~/.cache/session_memory/context_cache.json` (written by the session_memory hook on every session start).

If the file exists and `recent_sessions` is non-empty, extract for each entry:
- `session_id` — unique ID
- `updated_at` — last active time
- `message_count` — size of conversation
- `summary` — AI-generated summary of what happened (may be empty string if not yet generated)

This is your PRIMARY source for "what was I working on before". Show these sessions **before** any other context.

If the file is missing or empty, skip to Step 2.

## Step 2: Read Pre-gathered Context

Read `~/.claude/cache/session-context.json` (written by session-context-preloader hook).

If the file exists, extract:
- `detectedProject` — the project matched from cwd
- `vaultProjectPath` — where to find vault docs
- `recentSessions` — previews of last 3 session notes

If the file is missing or unreadable, fall back to manual detection:
- Check the current working directory against the Project-Codebase Mapping in CLAUDE.md (always in system prompt)

If no project matches (e.g., home dir), present a general briefing instead.

## Step 3: Read Project Context

If a project was detected, read the vault README at the path from `agent-os.config.json`:
`<vaultPath>/<vaultProjectPath>/README.md`

Extract:
- Current state / status
- Recent decisions
- Known issues

## Step 4: Recent Sessions (fallback)

If neither cache had useful session info, use the Glob tool to find the 2 most recent files in `<vaultPath>/Sessions/` and read the first 20 lines of each.

## Step 5: Check Warnings

Read `error-patterns.md` from the configured memory directory:
- If the detected project has known gotchas, mention them briefly
- Check for any environment-specific warnings relevant to the current context

## Output Format

```
Session Context Loaded

上次工作记录:
- [updated_at] [message_count条消息] — [summary 前150字，若无摘要则显示"(摘要生成中)"]
- [updated_at] [message_count条消息] — [summary 前150字]

Project: [name or "未检测到项目"]
Blockers: [from project README/STATUS, or "None"]
Warnings: [relevant error-patterns, or omit section]

继续上次工作，还是开始新任务？
```

If session memory cache is empty AND no project detected:
```
Session Context Loaded

无上次会话记录（服务可能未响应）。
What are we working on?
```

## Rules
- 上次工作记录 section 必须最先输出，这是核心价值
- summary 为空时显示 "(摘要生成中)" 而不是跳过该条
- Keep output concise — this is a briefing, not a report
- Don't read files that don't exist — check gracefully
- If a CODEBASE.md exists in the vault project folder, mention it's available
- All paths come from agent-os.config.json — never hardcode user-specific paths
