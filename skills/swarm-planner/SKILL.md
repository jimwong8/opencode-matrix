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

## Coding Standards

**每个生成的 plan.json 必须包含 `coding_standards` 字段**，位于 `summary` 和 `waves` 之间。该字段定义所有子代理（swarm-backend、swarm-frontend、swarm-tester）生成代码时必须遵守的编码约束。

### 模板结构

```json
"coding_standards": {
  "type_annotations": {
    "required": true,
    "description": "所有函数/方法必须有完整的类型标注（参数+返回值）；类必须有 docstring"
  },
  "consistent_language": {
    "required": true,
    "description": "错误消息、文档字符串、注释语言统一，与相邻模块保持一致，禁止中英文混用"
  },
  "safe_functions": {
    "required": true,
    "description": "JSON 输出必须用 json.dumps() 等安全方法，禁止 f-string 拼接；HTML 输出需考虑转义（如 html.escape）"
  }
}
```

### 规则说明

| 规则 | 强制级别 | 说明 |
|------|--------|------|
| **type_annotations** | 必须 | 所有函数/方法必须有参数类型和返回类型标注；类必须有 docstring 说明用途 |
| **consistent_language** | 必须 | 错误消息、docstring、注释必须与上下文语言一致；禁止在同一文件中混用中英文 |
| **safe_functions** | 必须 | JSON 输出必须使用 `json.dumps()`，禁止 f-string 拼接；HTML 输出必须转义特殊字符 |

### 实现要点

- 规划代理（swarm-planner）**必须**在生成的每个 `plan.json` 中包含 `coding_standards` 对象
- 编排器（swarm-orchestrator）在分发任务给子代理时，**必须**将 `coding_standards` 作为上下文传递给每个子代理
- 审查代理（swarm-reviewer）在最终审查时，**必须**检查所有代码是否符合 `coding_standards` 中定义的三条规则
- 未遵守编码标准的任务应标记为不通过，需要返工
