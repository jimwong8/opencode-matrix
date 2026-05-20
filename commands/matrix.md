---
description: 显示或更换 4 模型角色矩阵（架构师/构建者/工匠/侦察兵）
---
请使用 bash 工具运行用户提供的矩阵切换命令，并把输出原样展示给用户。

可用命令汇总：
- `bash ~/.config/opencode/scripts/apply-matrix.sh --show` — 显示当前矩阵
- `bash ~/.config/opencode/scripts/apply-matrix.sh --list` — 列出可用模型（按 provider 分组）
- `bash ~/.config/opencode/scripts/apply-matrix.sh --interactive` — 交互式更换
- `bash ~/.config/opencode/scripts/apply-matrix.sh --architect <model>` — 单独换架构师模型
- `bash ~/.config/opencode/scripts/apply-matrix.sh --builder <model> --builder-variant=high` — 换构建者并设 variant
- `bash ~/.config/opencode/scripts/apply-matrix.sh --rollback` — 回滚到最近备份
- `bash ~/.config/opencode/scripts/apply-matrix.sh` — 无参数重新应用当前 matrix.json

用户输入: $ARGUMENTS

解析规则：
- 如果 $ARGUMENTS 为空 或 是 "show"，运行 `--show`
- 如果是 "list"，运行 `--list`
- 如果是 "rollback"，运行 `--rollback`
- 如果是 "i" 或 "interactive"，运行 `--interactive`
- 否则把 $ARGUMENTS 直接作为参数传入：`bash ~/.config/opencode/scripts/apply-matrix.sh $ARGUMENTS`

应用矩阵后必须提醒用户重启 OpenCode 才能生效。
