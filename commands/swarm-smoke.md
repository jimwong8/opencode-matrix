---
description: Run a standard multi-wave swarm smoke test across backend, frontend, tests, and review
agent: swarm-orchestrator
---
Use the `swarm-planner` skill to run a multi-wave swarm smoke test.

Requirements:
- Produce a dependency-aware plan in `.opencode/swarm/plan.json` from `.opencode/swarm/plan.template.json`
- Include at least one backend task, one frontend task, one test task, and a final reviewer task
- Keep task statuses and summaries updated in `plan.json`
- Prefer running backend and frontend work in the same wave when they do not touch the same files
- Run relevant verification before marking the work complete

Smoke test request:
$ARGUMENTS
