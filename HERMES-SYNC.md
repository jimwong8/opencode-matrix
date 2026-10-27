# Hermes → OpenCode 同步说明

最后同步：2026-10-27 14:50

## 重新同步

```bash
python3 ~/.hermes/cache/scratch/opencode/sync_hermes_to_opencode.py --dry-run   # 看计划
python3 ~/.hermes/cache/scratch/opencode/sync_hermes_to_opencode.py --apply     # 执行
python3 ~/.hermes/cache/scratch/opencode/probe_mcp.py                           # 验活 17 个 MCP
```

脚本幂等：已存在的软链和 MCP 条目会跳过。改 opencode.json 前自动备份为
`.bak-sync-<时间戳>`。

## Skills（162 个，软链）

- 源：`~/.hermes/skills`（123 个）+ `~/.hermes/skills-external/seagull-91`（39 个）
- 目标：`~/.config/opencode/skills/<名字>`，绝对软链指回 Hermes 原目录
- 好处：Hermes 侧改 SKILL.md，OpenCode 下次会话直接看到新内容，无需再同步
- 代价：162 个 skill 的 name+description 常驻系统提示，约 +2 万 tokens/请求
- 注意：删掉 Hermes 侧目录会留下失效软链，重跑脚本会告警但不会自动清理，
  需手动 `rm ~/.config/opencode/skills/<名字>`

OpenCode 实际扫描的 skill 目录（实测）：`~/.agents/skills`、`~/.config/opencode/skills`、
`~/.claude/skills`、`~/.opencode/skills`、`~/.config/opencode/superpowers/skills`。

## MCP（5 → 17）

新增 12 个：multi-agent-collab, ghidra, rea, anysearch, context7, cua-windows,
grep_app, pg_llmgateway, pg_session_memory, wechat, obscura, codegraph。

全部通过 initialize 握手验证（`probe_mcp.py`，17/17 OK）。

- Hermes 里 `memory`、`puppeteer` 是 disabled，OpenCode 侧保持原有 enabled 不动
- `anysearch` 的 token 不写在脚本里：脚本从 `$ANYSEARCH_API_KEY` 或
  `~/.hermes/config.yaml` 正则提取
- 3 个走 SSH 的（cua-windows→10.100.1.221、pg_llmgateway→10.100.1.17、
  pg_session_memory→10.100.1.13）已验证 ssh 免密可达；远端不可用时会拖慢启动

## 插件（无法直接搬，只做映射）

Hermes 插件是 Python + Hermes 专属 hook API（`plugin.yaml` / `memory_provider` /
`post_tool_call`），OpenCode 插件是 JS/TS 的另一套 API，没有自动转换路径。

| Hermes 插件 | OpenCode 对应 | 说明 |
|---|---|---|
| session-memory | `plugin/session-memory-auto`, `-probe` | OpenCode 侧已有独立实现 |
| superpowers | `~/.config/opencode/superpowers` | 两边都有，14 个 skill 已加载 |
| herdr-agent-state | `plugins/herdr-agent-state.js` | OpenCode 用 herdr 官方集成 v13，比 Python 版更好 |
| context 压缩（diagnostic-engine） | `plugin/context-compressor` | 机制不同（OpenCode 是插件，Hermes 是 context engine）|
| reflexion | 无 | 依赖 Hermes `post_tool_call` hook + `~/.hermes/reflexion` |
| holographic / hindsight | 无 | 依赖 Hermes memory_provider 接口，Python 实现 |
| spotify | 无 | Hermes 内置工具集，OpenCode 无对应工具面 |
| model-matrix | 无 | Hermes 里也已 disabled（`skills_disabled/model-matrix`）|
| hermes-achievements | 无 | Hermes 运行时状态扫描，与 OpenCode 无关 |

硬搬这些插件需要把 hook 逻辑用 TS 重写并逐个调试，成本远高于收益，暂不做。
