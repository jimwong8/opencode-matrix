---
name: resume-conversation
description: >
  Use when a conversation was interrupted, the user says "continue the previous conversation",
  "resume the session", "where were we", or they reopen OpenCode and need a fast recovery summary.
  Finds the most relevant recent session, filters out noisy subagent sessions, and produces a concise
  recovery card with next steps before work resumes.
---

# Resume Conversation

Recover quickly after an interrupted OpenCode conversation. This skill is for **conversation recovery**, not general project briefing.

## Goal

Given the current working directory, identify the most likely session the user wants, summarize only the actionable state, and make the next step obvious.

## When to Use

Use this skill when:
- the user says “继续刚才中止的对话”, “继续上次的会话”, “resume”, “pick up where we left off”, “where were we”
- a CLI/TUI session closed unexpectedly
- there are many recent sessions and the user needs help choosing the right one

Do **not** use this skill when the user only wants general project context. For that, use `session-start`.

## Recovery Workflow

### Step 1: Find likely sessions

1. Call `session_list` for the current project path.
2. Prefer sessions whose title is meaningful and recent.
3. De-prioritize noisy sessions such as:
   - titles starting with `Greeting`
   - titles starting with `New session`
   - obvious subagent sessions
4. If a current-directory session clearly stands out, pick it.
5. If not, keep the best 3 candidates.

### Step 2: Read the best session

1. Call `session_read` on the chosen session with enough messages to recover intent.
2. Always set `include_todos=true` when available so unfinished work is surfaced.
3. Extract only:
   - the user’s last concrete goal
   - what was already discovered or changed
   - unfinished work / blockers
   - the most sensible next step
4. If the best session is ambiguous, read 2-3 candidates and compare.

### Step 3: Produce a recovery card

You MUST finish with exactly one of the following:
- a `Recovery Summary` block when recovery succeeds
- a `RECOVERY_FAILED: <reason>` line when recovery cannot be completed confidently

Use this format:

```text
Recovery Summary

Likely Session: <session id> - <title>
Project/Path: <path>

Last Goal:
- <1-2 bullets>

What Was Done:
- <1-3 bullets>

Open Items:
- <1-3 bullets>

Suggested Next Step:
- <one concrete next action>
```

### Step 4: If confidence is low

If multiple sessions are plausible, show a short candidate list instead of pretending certainty:

```text
Possible Sessions:
1. <id> - <title> - <why it matches>
2. <id> - <title> - <why it matches>
3. <id> - <title> - <why it matches>
```

Then recommend the best one first.

## Rules

- Prefer **main conversation sessions** over subagent noise.
- Prefer the **current project path** over global recency.
- Do not dump raw transcript unless the user asks.
- Keep the output concise and action-oriented.
- Never stop after listing sessions or reading transcripts; always end with `Recovery Summary` or `RECOVERY_FAILED`.
- If there is a known todo list or unfinished implementation, surface that explicitly.
- If no relevant session exists, say so clearly and fall back to `session-start` style project context.

## Heuristics

Use these signals to rank sessions:
- same project path
- recent update time
- meaningful title
- evidence of direct user work rather than helper/subagent chatter
- unfinished todos or interrupted implementation

Use these signals to de-rank sessions:
- generic greeting sessions
- one-off test sessions
- subagent-only sessions
- sessions with no actionable content

## Good Output Example

```text
Recovery Summary

Likely Session: ses_abc123 - 修复对话恢复问题
Project/Path: /home/jimwong/zhongzhuan

Last Goal:
- 修复 OpenCode 在意外中止后难以恢复的问题

What Was Done:
- 已定位 session list / continue / session-start 的现状
- 已确认真正缺口是自动恢复摘要，而不是底层存储

Open Items:
- 新增恢复入口
- 验证它能优先命中主会话而不是子代理会话

Suggested Next Step:
- 实现一个独立的恢复命令并做一次端到端验证
```
