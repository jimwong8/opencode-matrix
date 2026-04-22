---
name: retro
description: >
  Post-task reflection: captures what worked, what failed, and new learnings to memory files.
  Use when the user says "retro", "reflect", "what did we learn", or "/retro".
  Reads session activity log, analyzes the conversation, and selectively updates
  error-patterns.md, patterns.md, and debugging.md. Designed to feel fast, not ceremonial.
---

# Retro — Post-Work Reflection

Analyze this session's work and capture useful learnings. Only write to files when there's something genuinely new — don't pad.

## Step 1: Gather Data

1. Read `~/.claude/cache/session-activity.log` if it exists — shows git commits and pushes from this session
2. Review the conversation history: what files were changed, what errors occurred, what approaches were tried, what worked vs failed
3. Note any tools that failed, workarounds discovered, or non-obvious solutions

## Step 2: Analyze

Categorize findings into:

- **Errors**: New error patterns not already in error-patterns.md (tool failures, environment issues, API errors)
- **Patterns**: New workflow approaches that proved effective (file strategies, tool combinations, architectural decisions)
- **Debugging**: If debugging occurred — symptoms, root causes, and fixes discovered

For each category, check the existing file to avoid duplicating what's already captured.

## Step 3: Update Memory Files (Selectively)

All memory files live in the configured memory directory (from agent-os.config.json).

### error-patterns.md

Only add entries for NEW error patterns. Follow the existing format exactly:
```markdown
### [Short descriptive title]
**What happened:** [Specific error message or scenario]
**Rule:** [What to do instead, stated as a directive]
```

Place under the appropriate existing section (Tool Errors, MCP / API Errors, Workflow Patterns, Platform-Specific).

### patterns.md

Only add entries for genuinely useful new patterns. Format:
```markdown
### [Pattern Name]
**Context:** [When this pattern applies]
**Approach:** [What to do]
**Why it works:** [Brief explanation]
```

Place under the appropriate section (File Operations, Architecture Decisions, Session Management, Debugging Approaches).

### debugging.md

Only add entries if actual debugging occurred this session. Format:
```markdown
### [Symptom description]
**Root Cause:** [What actually caused it]
**Fix:** [What resolved it]
**Prevention:** [How to avoid it next time]
```

Place under the appropriate section (Tool & Environment Issues, Code Issues, Integration Issues).

## Step 4: Offer Session Note (Optional)

Ask the user: "Want me to save a session note to the vault?" If yes, create a note in `<vaultPath>/Sessions/YYYY-MM-DD-retro.md`.

## Output Format

```
Retro Summary

Work Done:
- [brief bullets of what happened this session]

Captured:
- error-patterns.md: [Added N patterns / No new patterns]
- patterns.md: [Added N patterns / No new patterns]
- debugging.md: [Added N entries / No debugging this session]

Activity Log: [N commits, N pushes / No activity logged]

Save session note to vault? (y/n)
```

## Rules
- Read each memory file BEFORE writing to check for duplicates
- Don't add trivial or one-off errors — only patterns likely to recur
- Don't modify existing entries unless they're clearly wrong
- Keep entries concise — one or two sentences per field
- If nothing was learned, say so honestly: "Clean session, no new learnings"
- Clear the activity log after processing: delete `~/.claude/cache/session-activity.log`
