#!/usr/bin/env bash
# install.sh — 4 模型矩阵系统安装器
# 用法: bash install.sh
set -e

CFG="$HOME/.config/opencode"
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"

echo "🔧 OpenCode 4 模型矩阵系统安装"
echo "================================"
echo "目标目录: $CFG"
echo ""

# 检查依赖
if ! command -v python3 &> /dev/null; then
    echo "❌ python3 未安装"
    exit 1
fi
if ! command -v opencode &> /dev/null && [ ! -d "$CFG" ]; then
    echo "⚠ 未检测到 opencode 命令或 ~/.config/opencode/ 目录"
    read -p "继续安装? [y/N] " yn
    [[ "$yn" != "y" ]] && exit 0
fi

# 创建目录
mkdir -p "$CFG/scripts" "$CFG/commands" "$CFG/agents"

# 备份旧版
TS=$(date +%Y%m%d-%H%M%S)
if [ -f "$CFG/scripts/apply-matrix.py" ]; then
    cp "$CFG/scripts/apply-matrix.py" "$CFG/scripts/apply-matrix.py.bak-install-$TS"
    echo "✓ 备份旧 apply-matrix.py"
fi
for agent in swarm-orchestrator swarm-backend swarm-frontend swarm-reviewer swarm-tester skill-writer; do
    if [ -f "$CFG/agents/$agent.md" ]; then
        cp "$CFG/agents/$agent.md" "$CFG/agents/$agent.md.bak-install-$TS"
    fi
done

# 安装核心文件
cp "$SCRIPT_DIR/scripts/apply-matrix.py" "$CFG/scripts/"
cp "$SCRIPT_DIR/scripts/apply-matrix.sh" "$CFG/scripts/"
chmod +x "$CFG/scripts/apply-matrix.py" "$CFG/scripts/apply-matrix.sh"

# matrix.json 只在不存在时安装（避免覆盖用户配置）
if [ ! -f "$CFG/scripts/matrix.json" ]; then
    cp "$SCRIPT_DIR/scripts/matrix.json" "$CFG/scripts/"
    echo "✓ 安装默认 matrix.json"
else
    echo "ℹ 保留已有 matrix.json"
fi

cp "$SCRIPT_DIR/commands/matrix.md" "$CFG/commands/"

# 安装 swarm agent 模板（如果不存在）
INSTALLED_AGENTS=()
for agent in swarm-orchestrator swarm-backend swarm-frontend swarm-reviewer swarm-tester skill-writer; do
    if [ ! -f "$CFG/agents/$agent.md" ]; then
        cp "$SCRIPT_DIR/agents/$agent.md" "$CFG/agents/"
        INSTALLED_AGENTS+=("$agent")
    fi
done

# 添加 alias
if ! grep -q "alias matrix=" "$HOME/.bashrc" 2>/dev/null; then
    {
        echo ""
        echo "# OpenCode 4 模型矩阵"
        echo "alias matrix='bash ~/.config/opencode/scripts/apply-matrix.sh'"
    } >> "$HOME/.bashrc"
    echo "✓ 已添加 alias 到 ~/.bashrc"
else
    echo "ℹ alias 已存在"
fi

echo ""
echo "✅ 安装完成"
echo ""
echo "已安装文件："
echo "  $CFG/scripts/apply-matrix.py"
echo "  $CFG/scripts/apply-matrix.sh"
echo "  $CFG/scripts/matrix.json"
echo "  $CFG/commands/matrix.md"
[ ${#INSTALLED_AGENTS[@]} -gt 0 ] && {
    echo "  swarm/skill agents:"
    for a in "${INSTALLED_AGENTS[@]}"; do echo "    $CFG/agents/$a.md"; done
}
echo ""
echo "下一步:"
echo "  1. source ~/.bashrc        (或新开终端)"
echo "  2. matrix --show           (查看当前矩阵)"
echo "  3. matrix --list           (查看可用模型)"
echo "  4. matrix                  (无参数 = 应用 matrix.json 当前内容)"
echo "  5. 重启 OpenCode 让矩阵生效"
echo ""
echo "💡 第一次运行前建议编辑 $CFG/scripts/matrix.json，"
echo "   把 4 个 model 字段改成你这台机器实际可用的模型 ID。"
