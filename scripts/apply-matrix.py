#!/usr/bin/env python3
"""
apply-matrix.py — 4 模型矩阵应用器

读取 matrix.json，渲染成完整的 oh-my-opencode.json (含 fallback 链)。

用法:
  python3 apply-matrix.py                                # 应用 matrix.json 当前内容
  python3 apply-matrix.py --architect <model>            # 临时改架构师模型
  python3 apply-matrix.py --builder <model> --variant=high  # 改构建者并加 variant
  python3 apply-matrix.py --interactive                  # 交互式选择
  python3 apply-matrix.py --list                         # 列出可用模型
  python3 apply-matrix.py --show                         # 仅显示当前矩阵
  python3 apply-matrix.py --rollback                     # 回滚到最近备份
  python3 apply-matrix.py --swap OLD NEW                 # 用 NEW 替换 OLD，自动重排 4 角色
  python3 apply-matrix.py --add NEW                      # 加入 NEW 到候选池，自动选最佳 4 个
  python3 apply-matrix.py --optimize                     # 仅基于当前 4 个模型重新最优分配
  python3 apply-matrix.py --score MODEL                  # 显示某模型在 4 角色上的评分
"""
import argparse
import itertools
import json
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

CFG_DIR = Path.home() / ".config" / "opencode"
MATRIX_PATH = CFG_DIR / "scripts" / "matrix.json"
TARGET_PATHS = [
    CFG_DIR / "oh-my-opencode.json",
    CFG_DIR / "oh-my-openagent.json",
]
PROVIDER_CACHE = Path.home() / ".cache" / "oh-my-opencode" / "provider-models.json"

# 本地 agent 文件（不归 oh-my-openagent 管，需要直接改 frontmatter）
LOCAL_AGENTS_DIR = CFG_DIR / "agents"
LOCAL_AGENT_FILES = {
    "swarm-orchestrator": "swarm-orchestrator.md",
    "swarm-backend": "swarm-backend.md",
    "swarm-frontend": "swarm-frontend.md",
    "swarm-tester": "swarm-tester.md",
    "swarm-reviewer": "swarm-reviewer.md",
    "skill-writer": "skill-writer.md",
}

ROLE_EMOJI = {
    "architect": "🧠",
    "builder": "⚒️",
    "crafter": "🎨",
    "scout": "🔍",
}

# 已知顶级模型的手动评分加成（绕过缓存元数据不完整的问题）
# 格式: { "provider/model": {"role": bonus_points} } 或 { "provider/model": {"all": bonus} }
KNOWN_MODEL_BOOSTS = {
    # AtlasCloud Owl: 实际是高端模型，但缓存元数据不全
    "atlascloud/owl": {"architect": 60, "builder": 30, "crafter": 25, "scout": 5},
    # Claude 系列（顶级推理）
    "xstx/claude-opus-4-7": {"architect": 50, "builder": 40, "crafter": 35, "scout": 10},
    "xstx/claude-opus-4-7-thinking": {"architect": 60, "builder": 35, "crafter": 30, "scout": 0},
    "novai/claude-opus-4-7-thinking": {"architect": 60, "builder": 35, "crafter": 30, "scout": 0},
    "novai/claude-opus-4-7": {"architect": 50, "builder": 40, "crafter": 35, "scout": 10},
    "novai/claude-sonnet-4-6": {"architect": 35, "builder": 35, "crafter": 45, "scout": 25},
    "novai/claude-haiku-4-5": {"architect": 15, "builder": 20, "crafter": 25, "scout": 50},
    # GPT-5 系列
    "novai/gpt-5.5": {"architect": 50, "builder": 45, "crafter": 35, "scout": 15},
    "novai/gpt-5.4": {"architect": 40, "builder": 40, "crafter": 30, "scout": 20},
    "digitflow/gpt-5.5": {"architect": 50, "builder": 45, "crafter": 35, "scout": 15},
    "digitflow/gpt-5.4": {"architect": 40, "builder": 40, "crafter": 30, "scout": 20},
    # Gemini
    "novai/gemini-3.1-pro": {"architect": 35, "builder": 30, "crafter": 50, "scout": 20},
    "novai/gemini-3-pro": {"architect": 30, "builder": 25, "crafter": 45, "scout": 25},
    # 已对接的免费 opencode 模型微调
    "opencode/minimax-m2.5-free": {"builder": 15, "architect": 5},  # 长上下文+编码强
    "opencode/nemotron-3-super-free": {"crafter": 10, "architect": 5},  # 推理+多模态
    "opencode/deepseek-v4-flash-free": {"scout": 15, "builder": 5},  # 快速+广 variant
}

# 角色对模型特性的权重矩阵
# 维度: reasoning, context, toolcall, vision, speed_inv_cost, family_bonus
ROLE_WEIGHTS = {
    "architect": {  # 推理 + 上下文为主
        "reasoning": 4.0,
        "context": 2.0,
        "toolcall": 1.5,
        "vision": 0.0,
        "cheap": 0.5,
        "fast": 0.5,
        "family_pref": ["claude-opus", "gpt-5", "owl", "deepseek", "kimi", "claude-sonnet"],
    },
    "builder": {  # 编码 + 长上下文 + 工具调用
        "reasoning": 2.5,
        "context": 3.0,
        "toolcall": 3.0,
        "vision": 0.0,
        "cheap": 1.0,
        "fast": 0.5,
        "family_pref": ["claude-opus", "minimax", "gpt-5", "deepseek", "owl", "kimi", "qwen"],
    },
    "crafter": {  # 多模态 + 创作 + 平衡
        "reasoning": 1.5,
        "context": 1.0,
        "toolcall": 2.0,
        "vision": 3.0,
        "cheap": 1.0,
        "fast": 1.0,
        "family_pref": ["claude-sonnet", "nemotron", "gemini", "gpt-5", "claude-haiku"],
    },
    "scout": {  # 快 + 便宜
        "reasoning": 0.5,
        "context": 1.0,
        "toolcall": 2.0,
        "vision": 0.0,
        "cheap": 3.0,
        "fast": 4.0,
        "family_pref": ["deepseek", "claude-haiku", "minimax", "qwen", "gpt-oss", "llama", "gemma"],
    },
}


def load_model_db():
    """读取 provider-models.json，返回 {provider/id: model_meta}"""
    if not PROVIDER_CACHE.exists():
        return {}
    data = json.loads(PROVIDER_CACHE.read_text())
    db = {}
    for provider, models in data.get("models", {}).items():
        for m in models:
            mid = m.get("id", "")
            full = f"{provider}/{mid}"
            db[full] = m
    return db


def detect_family(model_id, meta):
    """识别模型家族标签（用于 family_pref 加成）"""
    family = (meta.get("family") or "").lower()
    name = (meta.get("name") or "").lower()
    mid = model_id.lower()
    candidates = [family, name, mid]
    text = " ".join(candidates)

    families = []
    for tag in [
        "claude-opus", "claude-sonnet", "claude-haiku",
        "gpt-5", "gpt-oss", "gpt-4",
        "deepseek", "minimax", "kimi", "owl", "nemotron",
        "gemini", "qwen", "llama", "gemma", "grok",
    ]:
        if tag in text:
            families.append(tag)
    return families


def score_model_for_role(model_id, meta, role):
    """对某个模型在某角色上打分 (0-100)"""
    if not meta:
        return 0.0
    w = ROLE_WEIGHTS[role]
    caps = meta.get("capabilities", {})
    cost = meta.get("cost", {})
    limit = meta.get("limit", {})

    score = 0.0

    # reasoning (有 reasoning=true 加大量分)
    if caps.get("reasoning"):
        score += w["reasoning"] * 10
    elif "thinking" in (meta.get("name", "") or "").lower():
        score += w["reasoning"] * 8

    # context window (归一化到 200K = 满分)
    ctx = limit.get("context", 0) or 0
    ctx_score = min(ctx / 200000, 5.0)  # cap at 5x
    score += w["context"] * ctx_score * 2

    # toolcall
    if caps.get("toolcall"):
        score += w["toolcall"] * 5

    # vision (image input)
    if caps.get("input", {}).get("image"):
        score += w["vision"] * 5

    # cheap (免费/低价加分)
    in_price = cost.get("input", 0) or 0
    out_price = cost.get("output", 0) or 0
    avg_price = (in_price + out_price) / 2
    if avg_price == 0:
        score += w["cheap"] * 8  # 免费！
    elif avg_price < 1:
        score += w["cheap"] * 5
    elif avg_price < 5:
        score += w["cheap"] * 2

    # fast (Flash/Haiku/小模型/速度产品)
    name_lower = (meta.get("name", "") or model_id).lower()
    if any(t in name_lower for t in ["flash", "haiku", "mini", "fast", "turbo", "lite", "8b", "9b", "scout"]):
        score += w["fast"] * 5

    # family preference
    families = detect_family(model_id, meta)
    pref = w["family_pref"]
    for i, fam in enumerate(pref):
        if fam in families:
            # 越靠前的偏好加分越多
            score += (len(pref) - i) * 2
            break

    # provider 偏好（opencode 免费池稳定，加点分）
    provider = model_id.split("/")[0]
    if provider == "opencode":
        score += 2  # 已对接、免费、稳定

    # status active 才算
    if meta.get("status") != "active":
        score *= 0.3

    # 应用手动评分加成（处理元数据不完整的顶级模型）
    boost = KNOWN_MODEL_BOOSTS.get(model_id, {})
    if "all" in boost:
        score += boost["all"]
    if role in boost:
        score += boost[role]

    return round(score, 2)


def explain_score(model_id, meta, role):
    """详细解释评分构成（debug 用）"""
    score = score_model_for_role(model_id, meta, role)
    if not meta:
        return f"{model_id}: 0 (no metadata)"
    caps = meta.get("capabilities", {})
    bits = []
    if caps.get("reasoning"):
        bits.append("reasoning")
    if caps.get("toolcall"):
        bits.append("toolcall")
    if caps.get("input", {}).get("image"):
        bits.append("vision")
    cost = meta.get("cost", {})
    p = (cost.get("input", 0) + cost.get("output", 0)) / 2
    bits.append(f"price=${p}")
    bits.append(f"ctx={meta.get('limit', {}).get('context', 0)}")
    bits.append(f"family={detect_family(model_id, meta)}")
    return f"{role}={score:.1f} [{', '.join(bits)}]"


def score_model_all_roles(model_id, db):
    """返回该模型在 4 个角色上的评分字典"""
    meta = db.get(model_id, {})
    return {role: score_model_for_role(model_id, meta, role) for role in ROLE_WEIGHTS}


def best_assignment(model_pool, db):
    """对 4 个模型枚举所有 4! = 24 种排列，返回总分最高的角色分配
    返回 {role: model_id}, total_score
    """
    if len(model_pool) != 4:
        raise ValueError(f"必须传入恰好 4 个模型，收到 {len(model_pool)}")

    best = None
    best_score = -1
    roles = ["architect", "builder", "crafter", "scout"]
    for perm in itertools.permutations(model_pool):
        total = 0
        for role, model in zip(roles, perm):
            meta = db.get(model, {})
            total += score_model_for_role(model, meta, role)
        if total > best_score:
            best_score = total
            best = dict(zip(roles, perm))
    return best, best_score


def auto_pick_variant(model_id, db, role):
    """根据角色复杂度自动挑 variant（如果模型支持）"""
    meta = db.get(model_id, {})
    variants = meta.get("variants", {})
    if not variants:
        return None
    # 高复杂度角色用 high；其他用 medium；scout 用 medium 兜底
    pref_map = {
        "architect": ["max", "high", "medium"],
        "builder": ["high", "medium"],
        "crafter": ["high", "medium"],
        "scout": ["medium", "low"],
    }
    for v in pref_map.get(role, []):
        if v in variants:
            return v
    return None


def load_matrix():
    return json.loads(MATRIX_PATH.read_text(encoding="utf-8"))


def save_matrix(m):
    MATRIX_PATH.write_text(
        json.dumps(m, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def list_available_models():
    """从 oh-my-opencode 缓存读取可用模型列表，按 provider 分组"""
    if not PROVIDER_CACHE.exists():
        print("⚠ 缓存不存在，需先在 OpenCode 中至少打开过一次")
        return {}
    data = json.loads(PROVIDER_CACHE.read_text())
    out = {}
    for provider, models in data.get("models", {}).items():
        ids = []
        for m in models:
            mid = m.get("id", "")
            variants = list(m.get("variants", {}).keys())
            ids.append((mid, variants))
        if ids:
            out[provider] = ids
    return out


def render_role_block(role_name, role_def, fallback_chain, all_roles):
    """渲染单个 agent/category 的配置块"""
    block = {"model": role_def["model"]}
    if role_def.get("variant"):
        block["variant"] = role_def["variant"]
    block["fallback_models"] = [all_roles[r]["model"] for r in fallback_chain]
    return block


def render_full_config(matrix):
    """把 matrix.json 渲染成完整 oh-my-opencode.json 结构"""
    roles = matrix["roles"]
    fallback_chains = matrix["fallback_chains"]

    config = {
        "$schema": "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/master/assets/oh-my-opencode.schema.json",
        "model_fallback": True,
        "runtime_fallback": {"enabled": True},
        "_matrix": {
            "name": "4-Model Role-Specialized Panel",
            "version": matrix.get("version", "1.0"),
            "updated_at": datetime.now().strftime("%Y-%m-%d"),
            "roles": {
                rn: {
                    "model": rd["model"],
                    "variant": rd.get("variant"),
                    "responsibility": rd.get("responsibility", ""),
                }
                for rn, rd in roles.items()
            },
        },
        "agents": {},
        "categories": {},
    }

    for agent, role_name in matrix["agent_to_role"].items():
        config["agents"][agent] = render_role_block(
            role_name, roles[role_name], fallback_chains[role_name], roles
        )
    for cat, role_name in matrix["category_to_role"].items():
        config["categories"][cat] = render_role_block(
            role_name, roles[role_name], fallback_chains[role_name], roles
        )
    return config


def backup_current():
    """备份当前生效的两个配置"""
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    backups = []
    for p in TARGET_PATHS:
        if p.exists():
            bak = p.with_suffix(f".json.bak-matrix-{ts}")
            shutil.copy2(p, bak)
            backups.append(bak)
    return backups


def find_latest_backup():
    """找到最新的 matrix 备份"""
    candidates = sorted(
        CFG_DIR.glob("oh-my-opencode.json.bak-matrix-*"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def update_local_agent_frontmatter(matrix, *, dry_run=False):
    """把矩阵中的模型分配同步到 ~/.config/opencode/agents/*.md 的 frontmatter

    这一步是必要的，因为 oh-my-openagent 不管你本地自建的 swarm-* agent，
    必须直接在 .md 的 frontmatter 里写死 model 字段才能让 OpenCode 路由生效。

    variant 会被展开为对应 provider 的原生字段（reasoningEffort / thinking 等），
    通过 OpenCode 的 "Additional options" 机制透传给 provider。

    返回更新过的文件列表。
    """
    agent_to_role = matrix.get("agent_to_role", {})
    roles = matrix["roles"]
    db = load_model_db()
    updated = []

    for agent_name, filename in LOCAL_AGENT_FILES.items():
        path = LOCAL_AGENTS_DIR / filename
        if not path.exists():
            continue
        role_name = agent_to_role.get(agent_name)
        if not role_name:
            continue
        role = roles.get(role_name, {})
        model = role.get("model")
        variant = role.get("variant")
        if not model:
            continue
        # 把 variant 展开为 provider 原生字段
        variant_fields = expand_variant_to_provider_fields(model, variant, db)
        new_content = upsert_frontmatter_model(
            path.read_text(encoding="utf-8"), model, variant_fields
        )
        if new_content is None:
            continue  # 无变化
        if not dry_run:
            path.write_text(new_content, encoding="utf-8")
        updated.append(path.name)
    return updated


def expand_variant_to_provider_fields(model_id, variant, db):
    """把 variant 名称展开为 provider 的原生字段字典

    例: nemotron-3-super-free + variant=high → {"reasoningEffort": "high"}
        claude-opus-4-1 + variant=high → {"thinking": {...}}
        无 variant → {}
    """
    if not variant:
        return {}
    meta = db.get(model_id, {})
    variants = meta.get("variants", {})
    if variant in variants:
        return dict(variants[variant])
    # 兜底：原样写 variant 字段（兼容老配置）
    return {"variant": variant}


def upsert_frontmatter_model(content, model, variant_fields):
    """在 markdown 文件的 YAML frontmatter 中插入/更新 model 字段及 variant 展开字段。

    规则:
    - 替换或新增 model: 行
    - 删除遗留的 variant 行
    - 删除并重写 reasoningEffort / thinking 等 variant 展开字段
    - 在 description 行之后插入新字段（保持有序）

    返回新的 content；如无变化返回 None
    """
    # variant 可能展开成的字段名（避免重复写入）
    VARIANT_KEYS = {"variant", "reasoningEffort", "thinking", "reasoning", "textVerbosity"}

    lines = content.splitlines(keepends=True)
    if not lines or not lines[0].startswith("---"):
        return None

    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].startswith("---"):
            end_idx = i
            break
    if end_idx is None:
        return None

    fm = lines[1:end_idx]
    rest = lines[end_idx:]

    new_fm = []
    has_model = False
    skip_until_unindent = False
    for line in fm:
        stripped = line.rstrip("\n")
        # 跳过缩进行（属于上一个被删除的多行字段，如 thinking: 后面的子字段）
        if skip_until_unindent:
            if line.startswith((" ", "\t")):
                continue
            skip_until_unindent = False

        # 处理 model
        if stripped.startswith("model:"):
            new_fm.append(f"model: {model}\n")
            has_model = True
            continue

        # 删除遗留的 variant 展开字段
        first_token = stripped.split(":", 1)[0].strip()
        if first_token in VARIANT_KEYS:
            # 如果下一行是缩进的（多行值），一起跳过
            skip_until_unindent = True
            continue

        new_fm.append(line)

    if not has_model:
        # 在 description 行后插入 model
        out = []
        inserted = False
        for line in new_fm:
            out.append(line)
            if (not inserted) and line.startswith("description:"):
                out.append(f"model: {model}\n")
                inserted = True
        if not inserted:
            out = [f"model: {model}\n"] + new_fm
        new_fm = out

    # 在 model: 行之后插入 variant 展开字段
    if variant_fields:
        out = []
        for line in new_fm:
            out.append(line)
            if line.startswith("model:"):
                # 把每个字段写成 yaml 单行（支持嵌套字典走 inline json）
                for k, v in variant_fields.items():
                    if isinstance(v, dict):
                        # 嵌套字典：走多行 yaml
                        out.append(f"{k}:\n")
                        for sub_k, sub_v in v.items():
                            out.append(f"  {sub_k}: {json.dumps(sub_v) if not isinstance(sub_v, str) else sub_v}\n")
                    else:
                        out.append(f"{k}: {v}\n")
        new_fm = out

    new_content = lines[0] + "".join(new_fm) + "".join(rest)
    return new_content if new_content != content else None


def apply(matrix, *, dry_run=False):
    config = render_full_config(matrix)
    if dry_run:
        print(json.dumps(config, indent=2, ensure_ascii=False))
        print("\n--- 本地 agent frontmatter 变更预览 ---")
        update_local_agent_frontmatter(matrix, dry_run=True)
        return
    backups = backup_current()
    payload = json.dumps(config, indent=2, ensure_ascii=False) + "\n"
    for p in TARGET_PATHS:
        p.write_text(payload, encoding="utf-8")
    save_matrix(matrix)  # 持久化 matrix.json

    # 关键：同步本地 swarm-* agent 文件的 frontmatter
    updated_agents = update_local_agent_frontmatter(matrix, dry_run=False)

    print(f"✓ 已写入: {', '.join(str(p.name) for p in TARGET_PATHS)}")
    if updated_agents:
        print(f"✓ 已同步本地 agent frontmatter: {', '.join(updated_agents)}")
    if backups:
        print(f"✓ 备份: {', '.join(str(b.name) for b in backups)}")
    print_matrix(matrix)
    print("\n💡 重启 OpenCode 让新矩阵生效")


def print_matrix(matrix):
    print("\n=== 当前 4 模型矩阵 ===")
    for rn, rd in matrix["roles"].items():
        emoji = ROLE_EMOJI.get(rn, "•")
        variant = f" [variant={rd['variant']}]" if rd.get("variant") else ""
        print(f"  {emoji} {rn:10s} → {rd['model']}{variant}")
        print(f"     {rd.get('responsibility', '')}")


def show():
    """显示真实生效的矩阵（从 oh-my-opencode.json 反推，纯只读不同步）"""
    target = TARGET_PATHS[0]
    if not target.exists():
        # 兜底：读 matrix.json
        matrix = load_matrix()
        print_matrix(matrix)
        return
    cfg = json.loads(target.read_text(encoding="utf-8"))
    meta = cfg.get("_matrix", {}).get("roles", {})
    if not meta:
        # 老配置没有 _matrix 区块，从 agents 反推
        agents = cfg.get("agents", {})
        meta = {
            "architect": {
                "model": agents.get("swarm-orchestrator", {}).get("model", "?"),
                "variant": agents.get("swarm-orchestrator", {}).get("variant"),
                "responsibility": "(由 swarm-orchestrator 推断)",
            },
            "builder": {
                "model": agents.get("swarm-backend", {}).get("model", "?"),
                "variant": agents.get("swarm-backend", {}).get("variant"),
                "responsibility": "(由 swarm-backend 推断)",
            },
            "crafter": {
                "model": agents.get("swarm-frontend", {}).get("model", "?"),
                "variant": agents.get("swarm-frontend", {}).get("variant"),
                "responsibility": "(由 swarm-frontend 推断)",
            },
            "scout": {
                "model": agents.get("swarm-tester", {}).get("model", "?"),
                "variant": agents.get("swarm-tester", {}).get("variant"),
                "responsibility": "(由 swarm-tester 推断)",
            },
        }
    print_matrix({"roles": meta})

    # 检测但不自动覆写：仅提示 drift（让用户决定是否要 apply）
    cur = load_matrix()
    drift_items = []
    for rn in ("architect", "builder", "crafter", "scout"):
        if rn in meta:
            real_model = meta[rn].get("model")
            real_variant = meta[rn].get("variant")
            if cur["roles"][rn].get("model") != real_model:
                drift_items.append(f"{rn}.model: matrix.json={cur['roles'][rn].get('model')} vs 生效={real_model}")
            if cur["roles"][rn].get("variant") != real_variant:
                drift_items.append(f"{rn}.variant: matrix.json={cur['roles'][rn].get('variant')} vs 生效={real_variant}")
    if drift_items:
        print("\n  ⚠ matrix.json 与实际生效配置不一致:")
        for d in drift_items:
            print(f"     - {d}")
        print("     运行 `matrix` (无参数) 重新应用 matrix.json，或手动编辑后 apply。")


def cmd_list():
    models = list_available_models()
    if not models:
        return
    for provider, ids in sorted(models.items()):
        print(f"\n--- {provider} ({len(ids)} models) ---")
        for mid, variants in ids[:30]:
            v = f" variants={variants}" if variants else ""
            print(f"  {provider}/{mid}{v}")
        if len(ids) > 30:
            print(f"  ... +{len(ids) - 30} more")


def cmd_rollback():
    bak = find_latest_backup()
    if not bak:
        print("❌ 没找到 matrix 备份")
        sys.exit(1)
    print(f"将回滚: {bak.name}")
    confirm = input("确认? [y/N] ").strip().lower()
    if confirm != "y":
        print("已取消")
        return
    rolled_back = False
    for p in TARGET_PATHS:
        ts = bak.name.split("bak-matrix-")[-1]
        twin = p.parent / f"{p.name}.bak-matrix-{ts}"
        if twin.exists():
            shutil.copy2(twin, p)
            print(f"✓ 已回滚 {p.name}")
            rolled_back = True
        elif p.name.startswith("oh-my-opencode"):
            shutil.copy2(bak, p)
            print(f"✓ 已回滚 {p.name}")
            rolled_back = True
    # 同步 matrix.json 以保持下次操作基于真实状态
    if rolled_back:
        cfg = json.loads(TARGET_PATHS[0].read_text(encoding="utf-8"))
        meta = cfg.get("_matrix", {}).get("roles", {})
        if meta:
            cur = load_matrix()
            for rn in ("architect", "builder", "crafter", "scout"):
                if rn in meta:
                    cur["roles"][rn]["model"] = meta[rn].get("model")
                    cur["roles"][rn]["variant"] = meta[rn].get("variant")
            save_matrix(cur)
            print("✓ matrix.json 已同步")
        print("\n💡 重启 OpenCode 让回滚生效")


def interactive_pick(role_name, current):
    print(f"\n{ROLE_EMOJI.get(role_name)} {role_name} 当前: {current['model']}")
    new_model = input("  新模型 (留空保持不变): ").strip()
    if not new_model:
        return current
    new_variant = input(
        f"  variant (low/medium/high/max，留空=无): "
    ).strip() or None
    return {**current, "model": new_model, "variant": new_variant}


def cmd_interactive(matrix):
    print("=== 交互式更换矩阵模型 ===")
    print("(留空=不改；按 Ctrl+C 取消)")
    try:
        for rn in ("architect", "builder", "crafter", "scout"):
            matrix["roles"][rn] = interactive_pick(rn, matrix["roles"][rn])
    except KeyboardInterrupt:
        print("\n已取消")
        sys.exit(0)
    apply(matrix)


def cmd_score(model_id):
    """显示一个模型在 4 个角色上的评分细节"""
    db = load_model_db()
    meta = db.get(model_id)
    if not meta:
        # 尝试模糊匹配
        candidates = [k for k in db if model_id.lower() in k.lower()]
        if len(candidates) == 1:
            model_id = candidates[0]
            meta = db[model_id]
            print(f"(模糊匹配到: {model_id})")
        elif len(candidates) > 1:
            print(f"❌ 模糊匹配多个，请指定:")
            for c in candidates[:10]:
                print(f"  {c}")
            return
        else:
            print(f"❌ 未在缓存中找到 {model_id}")
            return
    print(f"\n=== {model_id} 角色适配评分 ===")
    print(f"family: {detect_family(model_id, meta)}")
    print(f"capabilities: {meta.get('capabilities', {})}")
    print(f"context: {meta.get('limit', {}).get('context', '?')}")
    cost = meta.get("cost", {})
    print(f"cost: input=${cost.get('input', 0)} output=${cost.get('output', 0)}")
    print(f"variants: {list(meta.get('variants', {}).keys())}")
    print()
    for role in ["architect", "builder", "crafter", "scout"]:
        s = score_model_for_role(model_id, meta, role)
        bar = "█" * int(s / 5)
        print(f"  {ROLE_EMOJI[role]} {role:10s} {s:6.1f}  {bar}")


def cmd_optimize(matrix):
    """对当前 4 个模型重新计算最优分配"""
    db = load_model_db()
    pool = [matrix["roles"][r]["model"] for r in ("architect", "builder", "crafter", "scout")]
    if len(set(pool)) < 4:
        print(f"⚠ 当前矩阵有重复模型，去重后: {set(pool)}")
        return
    print("\n=== 当前候选池 ===")
    print_pool_scores(pool, db)
    best, total = best_assignment(pool, db)
    print(f"\n=== 最优分配 (总分 {total:.1f}) ===")
    for role, model in best.items():
        variant = auto_pick_variant(model, db, role)
        v_str = f" [variant={variant}]" if variant else ""
        print(f"  {ROLE_EMOJI[role]} {role:10s} ← {model}{v_str}")
    confirm = input("\n应用此分配? [Y/n] ").strip().lower()
    if confirm and confirm != "y":
        print("已取消")
        return
    for role, model in best.items():
        matrix["roles"][role]["model"] = model
        matrix["roles"][role]["variant"] = auto_pick_variant(model, db, role)
    apply(matrix)


def cmd_swap(matrix, old_model, new_model):
    """用 NEW 替换 OLD，并对剩下 + NEW 的 4 个模型自动重排"""
    db = load_model_db()
    if new_model not in db:
        # 模糊匹配
        candidates = [k for k in db if new_model.lower() in k.lower()]
        if len(candidates) == 1:
            new_model = candidates[0]
            print(f"(NEW 模糊匹配到: {new_model})")
        elif len(candidates) > 1:
            print(f"❌ NEW 模糊匹配多个:")
            for c in candidates[:10]:
                print(f"  {c}")
            sys.exit(1)
        else:
            print(f"❌ 未找到 NEW 模型 {new_model}")
            sys.exit(1)
    pool = [matrix["roles"][r]["model"] for r in ("architect", "builder", "crafter", "scout")]
    if old_model not in pool:
        # 模糊匹配 old
        m = [p for p in pool if old_model.lower() in p.lower()]
        if len(m) == 1:
            old_model = m[0]
            print(f"(OLD 模糊匹配到: {old_model})")
        else:
            print(f"❌ OLD {old_model} 不在当前矩阵 {pool}")
            sys.exit(1)
    if new_model in pool:
        print(f"❌ NEW {new_model} 已在矩阵中")
        sys.exit(1)
    new_pool = [new_model if p == old_model else p for p in pool]
    print(f"\n替换: {old_model} → {new_model}")
    print("\n=== 新候选池 ===")
    print_pool_scores(new_pool, db)
    best, total = best_assignment(new_pool, db)
    print(f"\n=== 自动重排结果 (总分 {total:.1f}) ===")
    for role, model in best.items():
        variant = auto_pick_variant(model, db, role)
        v_str = f" [variant={variant}]" if variant else ""
        old = matrix["roles"][role]["model"]
        change = "" if old == model else f"  ⟵ 原 {old}"
        print(f"  {ROLE_EMOJI[role]} {role:10s} ← {model}{v_str}{change}")
    confirm = input("\n应用此分配? [Y/n] ").strip().lower()
    if confirm and confirm != "y":
        print("已取消")
        return
    for role, model in best.items():
        matrix["roles"][role]["model"] = model
        matrix["roles"][role]["variant"] = auto_pick_variant(model, db, role)
    apply(matrix)


def cmd_add(matrix, new_model):
    """加 NEW 到候选池，从 5 选 4 找最优组合"""
    db = load_model_db()
    if new_model not in db:
        candidates = [k for k in db if new_model.lower() in k.lower()]
        if len(candidates) == 1:
            new_model = candidates[0]
        elif candidates:
            print(f"❌ 模糊匹配多个:")
            for c in candidates[:10]:
                print(f"  {c}")
            sys.exit(1)
        else:
            print(f"❌ 未找到 {new_model}")
            sys.exit(1)
    cur = [matrix["roles"][r]["model"] for r in ("architect", "builder", "crafter", "scout")]
    if new_model in cur:
        print(f"⚠ {new_model} 已在矩阵中，转为 --optimize")
        cmd_optimize(matrix)
        return
    pool5 = cur + [new_model]
    print(f"\n候选池 (5 选 4): {pool5}")
    # 枚举 5 选 4 (= 5 种) × 4! 排列
    best = None
    best_score = -1
    best_drop = None
    for drop in pool5:
        sub = [m for m in pool5 if m != drop]
        assign, score = best_assignment(sub, db)
        if score > best_score:
            best_score = score
            best = assign
            best_drop = drop
    print(f"\n最优方案 (淘汰 {best_drop}, 总分 {best_score:.1f}):")
    for role, model in best.items():
        variant = auto_pick_variant(model, db, role)
        v_str = f" [variant={variant}]" if variant else ""
        old = matrix["roles"][role]["model"]
        change = "" if old == model else f"  ⟵ 原 {old}"
        print(f"  {ROLE_EMOJI[role]} {role:10s} ← {model}{v_str}{change}")
    confirm = input("\n应用? [Y/n] ").strip().lower()
    if confirm and confirm != "y":
        return
    for role, model in best.items():
        matrix["roles"][role]["model"] = model
        matrix["roles"][role]["variant"] = auto_pick_variant(model, db, role)
    apply(matrix)


def print_pool_scores(pool, db):
    """打印候选池中每个模型在 4 角色上的评分矩阵"""
    print(f"  {'model':40s}  {'arch':>6s} {'build':>6s} {'craft':>6s} {'scout':>6s}")
    print(f"  {'-'*40}  {'-'*6} {'-'*6} {'-'*6} {'-'*6}")
    for m in pool:
        meta = db.get(m, {})
        scores = score_model_all_roles(m, db)
        print(f"  {m:40s}  {scores['architect']:6.1f} {scores['builder']:6.1f} {scores['crafter']:6.1f} {scores['scout']:6.1f}")


def main():
    ap = argparse.ArgumentParser(description="4 模型矩阵切换工具")
    ap.add_argument("--architect", help="设置 architect 角色模型")
    ap.add_argument("--builder", help="设置 builder 角色模型")
    ap.add_argument("--crafter", help="设置 crafter 角色模型")
    ap.add_argument("--scout", help="设置 scout 角色模型")
    ap.add_argument("--variant", help="给上一个 --<role> 设置 variant")
    ap.add_argument("--architect-variant", default=None)
    ap.add_argument("--builder-variant", default=None)
    ap.add_argument("--crafter-variant", default=None)
    ap.add_argument("--scout-variant", default=None)
    ap.add_argument("--interactive", "-i", action="store_true", help="交互式选择")
    ap.add_argument("--list", "-l", action="store_true", help="列出可用模型")
    ap.add_argument("--show", "-s", action="store_true", help="显示当前矩阵")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写文件")
    ap.add_argument("--rollback", action="store_true", help="回滚到最近备份")
    ap.add_argument("--swap", nargs=2, metavar=("OLD", "NEW"),
                    help="把矩阵里的 OLD 模型替换为 NEW，并自动给 4 角色重排")
    ap.add_argument("--add", metavar="NEW",
                    help="把 NEW 加入候选池，从 5 选 4 找最优组合")
    ap.add_argument("--optimize", action="store_true",
                    help="对当前 4 个模型重新计算最优角色分配")
    ap.add_argument("--score", metavar="MODEL",
                    help="显示某模型在 4 角色上的评分细节")
    args = ap.parse_args()

    if args.list:
        cmd_list()
        return
    if args.show:
        show()
        return
    if args.rollback:
        cmd_rollback()
        return
    if args.score:
        cmd_score(args.score)
        return

    matrix = load_matrix()

    if args.optimize:
        cmd_optimize(matrix)
        return
    if args.swap:
        cmd_swap(matrix, args.swap[0], args.swap[1])
        return
    if args.add:
        cmd_add(matrix, args.add)
        return
    if args.interactive:
        cmd_interactive(matrix)
        return

    changed = False
    for role in ("architect", "builder", "crafter", "scout"):
        new_model = getattr(args, role)
        if new_model:
            matrix["roles"][role]["model"] = new_model
            changed = True
        v = getattr(args, f"{role}_variant")
        if v is not None:
            matrix["roles"][role]["variant"] = v if v else None
            changed = True

    if not changed and not args.dry_run:
        # 无参数 = 重新应用当前 matrix.json
        print("ℹ 无参数，重新应用 matrix.json 当前内容")
    apply(matrix, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
