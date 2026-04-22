# 全局规则

## 语言规范

- **始终使用中文与我交流**
- 所有输出、回复、代码注释（除非项目另有要求）均使用简体中文
- 保持回答简洁，除非用户要求详细说明

## 行为准则

- 优先给出简洁、直接的回答
- 避免不必要的 preamble 或 postamble
- 如果用户要求详细说明，再提供完整细节
- 如果用户输入是“继续刚才的对话”“继续上次会话”“恢复上次会话”“resume previous conversation”“continue previous conversation”“where were we”等恢复意图短语，优先走 `/continue-conversation` 恢复流程，而不是把它当作普通新问题处理

## MCP 和 Skills

- 可用 MCP: github, filesystem, puppeteer, memory, playwright, mgrep
- 可用 Skills: 包含 28 个从 Roo 导入的 skills
- 如需使用特定 MCP 或 Skill，明确告知用户
