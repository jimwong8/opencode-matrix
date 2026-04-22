---
name: swarm-planner
description: Break a request into dependency-aware parallel waves for backend, frontend, test, and review agents
---
## Purpose
Turn a user request into a plan that a swarm orchestrator can execute with specialist agents.

## Planning Rules
- Build a dependency-aware DAG, then present it as ordered waves.
- Tasks in the same wave must not modify the same file.
- Prefer explicit file targets when they can be inferred.
- Keep tasks small enough for a single subagent to finish independently.
- Put testing after implementation unless the request is test-only.
- Put review in the final wave.
- Base task context on files that are confirmed to exist; do not assume standard repo files or directories are present.

## Agent Mapping
- `swarm-backend`: APIs, services, persistence, backend bug fixes, backend refactors
- `swarm-frontend`: UI, components, styling, client behavior, accessibility
- `swarm-tester`: unit tests, integration tests, regression tests
- `swarm-reviewer`: final review and risk scan

## Output Shape
Write the plan as JSON with this structure:

```json
{
  "goal": "short user goal",
  "estimated_waves": 3,
  "waves": [
    {
      "wave": 1,
      "parallel": true,
      "tasks": [
        {
          "id": "be-001",
          "agent": "swarm-backend",
          "title": "implement API endpoint",
          "description": "clear description of the task",
          "context": "nearby files or patterns to follow",
          "files_to_modify": ["src/example.ts"],
          "depends_on": [],
          "status": "pending"
        }
      ]
    }
  ]
}
```

## Heuristics
- Split frontend and backend into the same wave when they can proceed independently.
- Move shared-file work into separate waves.
- Add a dedicated test task for meaningful behavior changes.
- Keep `context` short and concrete so the orchestrator can pass minimal prompt context to each subagent.
