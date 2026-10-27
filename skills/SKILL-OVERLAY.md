# Skill 覆盖关系说明

本文档说明本机各 skill 目录的来源、覆盖优先级和使用场景。

## Skill 目录来源

| 目录 | 用途 | 类型 |
|------|------|------|
| `~/.opencode/skills/` | 主 skill 目录，提供给 `skill` 工具使用 | 活动 |
| `~/.config/opencode/skills/` | 个人级 skill 目录 | 活动 |
| `~/.config/opencode/superpowers/skills/` | superpowers 插件注册目录 | 活动 |
| `~/.opencode/skills-imported/` | 归档副本，仅保留原始文件 | 非活动 |
| `~/.opencode/skills-test/` | 测试夹具 | 非活动 |

## 覆盖优先级（从高到低）

按 OpenCode 官方规则：**后加载的同名 skill 会覆盖先加载的**。

优先级顺序：
1. `~/.config/opencode/superpowers/skills/` (superpowers 插件注册)
2. `~/.config/opencode/skills/` (个人级)
3. `~/.opencode/skills/` (主目录)

> 注：`skills-imported/` 和 `skills-test/` 不在加载路径中，仅作归档保留。

## 按目录分布的 Skill 清单

### ~/.opencode/skills/（32 个）

```
agentic-browser      article-extractor   brainstorming     canvas-design
context-engineering create-skill       file-organizer   generate-image
git-pushing       google-ai-mode-skill  image-enhancer    log
managing-media   moai-lang-python   openspec-apply-change
openspec-archive-change  openspec-explore  openspec-propose  prompt-optimizer
python-best-practices  python-testing-patterns  retro  session-start
skill-optimizer  smart-agent-selection  sota-suite  subagent-driven-development
swarm-planner    test-fixing  twitter-algorithm-optimizer  webapp-testing
writing-plans
```

### ~/.config/opencode/skills/（30 个）

```
agentic-browser      article-extractor   brainstorming     canvas-design
context-engineering create-skill       file-organizer   generate-image
git-pushing       google-ai-mode-skill  image-enhancer    log
managing-media   moai-lang-python   prompt-optimizer   python-best-practices
python-testing-patterns  resume-conversation  retro  session-start
skill-optimizer  smart-agent-selection  sota-suite  subagent-driven-development
swarm-planner    test-fixing  twitter-algorithm-optimizer  webapp-testing
writing-plans
```

### ~/.config/opencode/superpowers/skills/（14 个）

```
brainstorming              dispatching-parallel-agents  executing-plans
finishing-a-development-branch  receiving-code-review  requesting-code-review
subagent-driven-development  systematic-debugging  test-driven-development
using-git-worktrees      using-superpowers  verification-before-completion
writing-plans        writing-skills
```

## 同名 Skill 说明

### 已确认的正常重复（无需改动）

以下 skill 在多个目录都有副本，属于设计行为，按优先级覆盖：

| Skill 名称 | 来源目录 | 说明 |
|------------|----------|------|
| `writing-plans` | opencode/, config/, superpowers/ | superpowers 版本有 superpowers 专属流程 |
| `brainstorming` | opencode/, config/, superpowers/ | superpowers 版本有增强流程（visual companion, spec self-review, user review gate）|
| `subagent-driven-development` | opencode/, config/, superpowers/ | superpowers 版本有两阶段评审（spec compliance → code quality）|

### 仅存在于 superpowers 的独占 Skill

以下 skill 仅在 superpowers 目录中提供：

- `dispatching-parallel-agents`
- `executing-plans`
- `finishing-a-development-branch`
- `receiving-code-review`
- `requesting-code-review`
- `systematic-debugging`
- `test-driven-development`
- `using-git-worktrees`
- `using-superpowers`
- `verification-before-completion`
- `writing-skills`

### 仅存在于 config 的独占 Skill

- `resume-conversation`

## Superpowers 增强版 Skills

���下 skills 在 superpowers 目录中有明显功能增强，使用 superpowers 插件时会自动加载增强版本：

1. **brainstorming**
   - 增强：visual companion、超大需求先拆分、spec self-review、用户 review gate
   - 文档路径：`docs/superpowers/specs/`

2. **subagent-driven-development**
   - 增强：两阶段评审（spec compliance → code quality）
   - 新增：模型选择、状态处理、模板化 reviewer

3. **writing-plans**
   - superpowers 版本增加了 REQUIRED SUB-SKILL 标记

## 健康检查要点

1. 每个 skill 目录只有一个 `SKILL.md`
2. `SKILL.md` 必须含 `name` 和 `description`
3. `name` 必须与目录名一致（官方要求）
4. 同名 skill 时，后加载的会覆盖先加载的

## 故障排查

如果某个 skill 行为异常：

1. 确认是哪个目录的版本在被加载（见覆盖优先级）
2. 检查 `SKILL.md` 的 frontmatter `name` 是否与目录名一致
3. 确认 opencode.json 中是否配置了额外的 `skills.paths` 或 `skills.urls`
4. superpowers 插件是否在加载状态

---
生成时间：2026-04-23