---
description: 设置当前 Agent 的主模型（用于生产工作）
agent: sisyphus
---

请将指定 Agent 的主模型写入 `~/.config/opencode/oh-my-opencode.json`；若 `~/.config/opencode/oh-my-openagent.json` 中存在对应 Agent 配置，也同步更新，避免双配置源漂移。

当前请求：$ARGUMENTS

## 处理逻辑

### 如果用户提供了模型名称（参数不为空）：

请执行以下步骤：

1. 解析传入的模型名称（格式：provider/model，如 `digitflow/gpt-5.4` 或 `digitflow/claude-opus-4-6`）
2. 读取 `~/.config/opencode/oh-my-opencode.json`；若存在 `~/.config/opencode/oh-my-openagent.json`，也一并读取
3. 先解析目标 Agent：优先使用用户显式指定（如 `--agent build`、`agent=build`）；否则使用当前会话 Agent；若无法可靠识别则默认 `build`
4. 同时更新以下字段（防止“设置成功但不生效”）：
   - `agents.<target>.model`
   - `agents.build.model`（兼容主对话执行代理）
5. 保存配置文件；若存在 `oh-my-openagent.json`，同步保存对应修改
6. 告诉用户配置已更新，并建议重启 OpenCode 或开启新会话以生效

注意：
- 如果传入的是简单模型名（如 `gpt-5.4`），默认使用 `digitflow` provider；建议优先传完整 `provider/model`
- 保留原有的 `variant` 和其他配置不变
- 只更新 model 字段，不改变 fallback_models
- 必须同步更新 `agents.build.model`（除非 target 本身就是 `build`），避免命令提示成功但主对话模型未切换

### 如果用户没有提供模型名称（参数为空）：

请执行以下步骤：

1. 读取配置文件：
   - `~/.config/opencode/oh-my-opencode.json`
   - `~/.config/opencode/opencode.json`
   - `~/.local/state/opencode/model.json`（若存在）

2. 确定目标 Agent：优先用户显式指定（`--agent` / `agent=`），其次当前会话 Agent，最后回退 `build`

3. 构建与 `/models` 可见结果一致的候选数据：
   - 从 `opencode.json` 的 `provider.*.models` 收集所有模型，按 provider 分组保存
   - 从 `oh-my-opencode.json` 的 `agents.*` 与 `categories.*` 中补并所有 `model` 与 `fallback_models`
   - 从 `~/.local/state/opencode/model.json` 中补并：
     - `recent[]` 的 `providerID/modelID`
     - `variant` 对象中的完整 key（`provider/model`）
   - 对来自 `~/.local/state/opencode/model.json` 的 provider 做白名单过滤：只保留当前 `opencode.json -> provider.*` 中仍存在的 provider，避免历史 provider 污染候选
   - provider 列表去重并稳定排序
   - 每个 provider 下的 model 列表去重并稳定排序
   - 额外保证：当前 agent 的 `model` 与 `fallback_models` 必须出现在候选中（防止历史模型丢失）

4. 使用 AskUserQuestion 工具分两步让用户选择模型，避免超长列表只显示前面一屏：
   - 第一步选择 provider
   - header: "选择模型提供方"
   - question: "请先选择模型提供方，然后按回车确认"
   - options: 提供所有 provider 作为选项
   - 第二步选择该 provider 下的 model
   - header: "选择主模型"
   - question: "请在所选提供方下选择主模型，然后按回车确认"
   - options: 只提供该 provider 下的 model，显示格式为纯 model 名称；写回配置时再拼成 `provider/model`
   - 如果某个 provider 只有一个 model，可直接使用该 model，无需再次询问
   - 如果该 provider 下模型很多（例如超过 15），先用 AskUserQuestion 询问一个过滤关键词（可为空），再仅展示包含该关键词的 model
   - 若过滤后为空：提示用户重试关键词，不写入配置
   - 若用户取消任一步骤：终止本次操作，不写入配置

5. 根据用户选择，同时更新：
   - `agents.<target>.model`
   - `agents.build.model`（若 `<target>` 不是 `build`）
6. 保存配置文件；若存在 `oh-my-openagent.json`，同步保存对应修改
7. 告诉用户配置已更新，并建议重启 OpenCode 或开启新会话以生效；同时说明命令采用“先选 provider、再选 model”的两步选择方式，可覆盖 `/models` 可见模型
