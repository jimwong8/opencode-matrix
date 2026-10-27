"""OpenCode Hook - Session Memory 集成（轻量兜底层）"""

import json
import logging
import os
from pathlib import Path
from urllib import request as urllib_request

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

HOOK_CAPTURE_MESSAGES = os.environ.get("SESSION_MEMORY_HOOK_CAPTURE_MESSAGES", "false").lower() in {
    "1",
    "true",
    "yes",
    "on",
}

SESSION_MEMORY_URL = os.environ.get("SESSION_MEMORY_URL", "http://10.100.1.13:8000")
CONTEXT_CACHE_PATH = Path("~/.cache/session_memory/context_cache.json").expanduser()
RECENT_SESSIONS_COUNT = 3  # 拉取最近 N 个会话的摘要


def _http_get(url: str, timeout: float = 10.0):
    """同步 HTTP GET，返回解析后的 JSON 或 None。"""
    try:
        with urllib_request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except Exception as exc:
        logger.debug("HTTP GET 失败 %s: %s", url, exc)
        return None


def _http_post(url: str, data: dict = None, timeout: float = 180.0):
    """同步 HTTP POST，返回解析后的 JSON 或 None。摘要生成可能较慢，默认 180s 超时。"""
    try:
        body = json.dumps(data or {}).encode()
        req = urllib_request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        with urllib_request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except Exception as exc:
        logger.debug("HTTP POST 失败 %s: %s", url, exc)
        return None


def _trigger_summarize_background(session_uuid: str) -> None:
    """在独立线程后台触发会话摘要生成（不阻塞主流程）。"""
    import threading

    def _do():
        base = SESSION_MEMORY_URL.rstrip("/")
        result = _http_post(f"{base}/api/v1/sessions/{session_uuid}/summarize", timeout=180.0)
        if result:
            logger.info("会话摘要已生成: %s", session_uuid)
        else:
            logger.warning("会话摘要生成失败或超时: %s", session_uuid)

    t = threading.Thread(target=_do, daemon=True, name=f"summarize-{session_uuid[:8]}")
    t.start()
    logger.info("后台摘要任务已启动: %s", session_uuid)


def _fetch_recent_context() -> dict:
    """从会话记忆服务拉取最近会话摘要，返回结构化 context 字典。"""
    base = SESSION_MEMORY_URL.rstrip("/")
    sessions_data = _http_get(f"{base}/api/v1/sessions/recent?limit={RECENT_SESSIONS_COUNT}")
    if not sessions_data:
        return {}

    recent_sessions = []
    for s in sessions_data[:RECENT_SESSIONS_COUNT]:
        sid = s.get("id")
        title = s.get("title", "untitled")
        updated_at = (s.get("updated_at") or "")[:19]
        msg_count = s.get("message_count", 0)

        # 跳过消息极少的会话
        if msg_count < 3:
            continue

        # 拉取该会话的详情（含摘要）
        detail = _http_get(f"{base}/api/v1/sessions/{sid}")
        summary_text = ""
        if detail:
            summaries = detail.get("summaries") or []
            if summaries:
                # 取最新摘要
                latest = sorted(summaries, key=lambda x: x.get("created_at", ""), reverse=True)[0]
                summary_text = latest.get("content", "").strip()

        recent_sessions.append({
            "session_id": sid,
            "title": title,
            "updated_at": updated_at,
            "message_count": msg_count,
            "summary": summary_text,
        })

    if not recent_sessions:
        return {}

    return {
        "fetched_at": __import__("datetime").datetime.now().isoformat(),
        "source": "session_memory_hook",
        "recent_sessions": recent_sessions,
    }


async def on_session_start(context: dict):
    """会话开始时确保远端会话存在，并预缓存最近会话摘要供 session-start skill 使用。"""
    try:
        from session_memory_client import get_client

        client = get_client()
        session_id = context.get("session_id", "unknown")
        title = context.get("title") or f"opencode:{session_id}"
        await client.get_or_create_external_session(
            external_session_id=session_id,
            title=title,
            metadata={
                "project_path": context.get("project_path", ""),
                "start_time": context.get("timestamp", ""),
                "source": "hook.session_start",
            },
        )
        logger.info("会话已就绪: %s", session_id)

        synced = await client.sync_offline_queue()
        if synced > 0:
            logger.info("已同步 %s 条离线数据", synced)

    except Exception as exc:
        logger.error("会话开始Hook失败: %s", exc)

    # 独立拉取最近会话摘要并写入 cache（失败不影响主流程）
    try:
        ctx = _fetch_recent_context()
        if ctx:
            CONTEXT_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            CONTEXT_CACHE_PATH.write_text(json.dumps(ctx, ensure_ascii=False, indent=2))
            logger.info("已缓存 %d 个会话摘要到 %s", len(ctx.get("recent_sessions", [])), CONTEXT_CACHE_PATH)
    except Exception as exc:
        logger.warning("缓存会话摘要失败（不影响主功能）: %s", exc)


async def on_message(context: dict):
    """默认不记录普通消息，避免与主 plugin 双写。"""
    if not HOOK_CAPTURE_MESSAGES:
        logger.debug("消息 Hook 已跳过，避免与 session-memory-auto 插件双写")
        return

    try:
        from session_memory_client import get_client

        client = get_client()
        session_id = context.get("session_id", "unknown")
        role = context.get("role", "user")
        content = context.get("content", "")

        await client.add_message(
            session_id=session_id,
            role=role,
            content=content,
            metadata={
                "timestamp": context.get("timestamp", ""),
                "model": context.get("model", ""),
                "source": "hook.message",
            },
        )

        logger.info("消息已记录: %s - %s", session_id, role)

    except Exception as exc:
        logger.error("消息Hook失败: %s", exc)


async def on_session_end(context: dict):
    """会话结束时同步离线数据，并后台触发摘要生成。"""
    # 1. 同步离线消息
    try:
        from session_memory_client import get_client

        client = get_client()
        synced = await client.sync_offline_queue()
        if synced > 0:
            logger.info("会话结束时同步了 %s 条离线数据", synced)

        await client.close()
        logger.info("会话已结束，客户端已关闭")

    except Exception as exc:
        logger.error("会话结束Hook失败: %s", exc)

    # 2. 查找本会话对应的远端 session_uuid，触发摘要（不阻塞）
    try:
        oc_session_id = context.get("session_id", "")
        if oc_session_id:
            base = SESSION_MEMORY_URL.rstrip("/")
            # 通过 session-map 查询远端 uuid
            mapping = _http_get(f"{base}/api/v1/plugin-state/session-map/{oc_session_id}")
            remote_uuid = None
            if mapping:
                remote_uuid = mapping.get("remote_session_id") or mapping.get("session_id")
            if not remote_uuid:
                # fallback: 从 recent 列表按 opencode_session_id 匹配
                sessions = _http_get(f"{base}/api/v1/sessions/recent?limit=5") or []
                for s in sessions:
                    meta = s.get("metadata_json") or {}
                    if meta.get("opencode_session_id") == oc_session_id:
                        remote_uuid = s.get("id")
                        break
            if remote_uuid:
                _trigger_summarize_background(remote_uuid)
            else:
                logger.warning("无法找到会话 %s 的远端 UUID，跳过摘要触发", oc_session_id)
    except Exception as exc:
        logger.warning("会话结束摘要触发失败（不影响主功能）: %s", exc)


HOOKS = {
    "session_start": on_session_start,
    "message": on_message,
    "session_end": on_session_end,
}
