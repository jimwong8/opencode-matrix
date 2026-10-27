"""Session Memory 客户端 SDK - 带 active session 状态与离线重放"""

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional
from urllib import error, parse, request

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = os.environ.get("SESSION_MEMORY_URL", "http://10.100.1.13:8000")
_DEFAULT_USER_ID = os.environ.get("SESSION_MEMORY_USER_ID", "jimwong")
_DEFAULT_TIMEOUT = float(os.environ.get("SESSION_MEMORY_TIMEOUT", "60"))
_MAX_OFFLINE_QUEUE = int(os.environ.get("SESSION_MEMORY_MAX_OFFLINE_QUEUE", "1000"))
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
_RETRYABLE_CATEGORIES = {"rate_limited", "server_error", "network_error"}
_COOLDOWN_SECONDS = {
    "rate_limited": 60,
    "server_error": 30,
    "network_error": 15,
}
_MAX_ATTEMPTS = {
    "rate_limited": 10,
    "server_error": 8,
    "network_error": 8,
    "session_not_found": 1,
    "http_error": 2,
    "unexpected_error": 2,
}


class SessionMemoryHTTPError(RuntimeError):
    """HTTP 层错误，保留状态码和响应体以便上层做分级处理。"""

    def __init__(self, url: str, status: Optional[int], body: str):
        self.url = url
        self.status = status
        self.body = body
        super().__init__(f"HTTP {status or 'unknown'} {url}: {body[:300]}")


class SessionMemoryClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        user_id: Optional[str] = None,
        timeout: Optional[float] = None,
        offline_dir: Optional[str] = None,
    ):
        self.base_url = (base_url or _DEFAULT_BASE_URL).rstrip("/")
        self.user_id = user_id or _DEFAULT_USER_ID
        self.timeout = timeout if timeout is not None else _DEFAULT_TIMEOUT
        self.offline_dir = Path(
            offline_dir
            or os.environ.get("SESSION_MEMORY_OFFLINE_DIR", "~/.cache/session_memory/offline")
        ).expanduser()
        self.offline_dir.mkdir(parents=True, exist_ok=True)
        self.state_file = self.offline_dir.parent / "active_session.json"
        self.queue_file = self.offline_dir / "message_queue.jsonl"

    @staticmethod
    def _classify_error(exc: Exception) -> str:
        if isinstance(exc, SessionMemoryHTTPError):
            if exc.status == 404:
                return "session_not_found"
            if exc.status == 429:
                return "rate_limited"
            if isinstance(exc.status, int) and exc.status >= 500:
                return "server_error"
            if exc.status is None:
                return "network_error"
            return "http_error"
        return "unexpected_error"

    @staticmethod
    def _is_retryable_category(category: str, session_ref: str) -> bool:
        if category in _RETRYABLE_CATEGORIES:
            return True
        if category == "session_not_found" and not SessionMemoryClient._is_remote_session_id(session_ref):
            return True
        return False

    @staticmethod
    def _max_attempts_for(category: str) -> int:
        return _MAX_ATTEMPTS.get(category, 2)

    @staticmethod
    def _cooldown_for(category: str) -> int:
        return _COOLDOWN_SECONDS.get(category, 0)

    @staticmethod
    def _next_retry_at(category: str) -> Optional[str]:
        seconds = SessionMemoryClient._cooldown_for(category)
        if seconds <= 0:
            return None
        return (datetime.now() + timedelta(seconds=seconds)).isoformat()

    @staticmethod
    def _should_attempt_now(entry: dict[str, Any]) -> bool:
        retry_at = entry.get("next_retry_at")
        if not retry_at:
            return True
        try:
            return datetime.now() >= datetime.fromisoformat(retry_at)
        except ValueError:
            return True

    async def _post_json(self, url: str, payload: dict[str, Any]) -> Any:
        def _do() -> Any:
            data = json.dumps(payload).encode("utf-8")
            req = request.Request(url, data=data, headers={"Content-Type": "application/json"})
            try:
                with request.urlopen(req, timeout=self.timeout) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except error.HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")
                raise SessionMemoryHTTPError(url, exc.code, body) from exc
            except error.URLError as exc:
                raise SessionMemoryHTTPError(url, None, str(exc.reason)) from exc

        return await asyncio.to_thread(_do)

    async def _get_json(self, url: str, params: Optional[dict[str, Any]] = None) -> Any:
        def _do() -> Any:
            full = url
            if params:
                query = parse.urlencode({k: v for k, v in params.items() if v is not None})
                full = f"{url}?{query}" if query else url
            try:
                with request.urlopen(full, timeout=self.timeout) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except error.HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")
                raise SessionMemoryHTTPError(full, exc.code, body) from exc
            except error.URLError as exc:
                raise SessionMemoryHTTPError(full, None, str(exc.reason)) from exc

        return await asyncio.to_thread(_do)

    @staticmethod
    def _is_remote_session_id(session_id: str) -> bool:
        return bool(_UUID_RE.match(session_id))

    def _append_offline_entry(self, entry: dict[str, Any]) -> None:
        self.offline_dir.mkdir(parents=True, exist_ok=True)
        entries = self._read_offline_entries()
        entries.append(entry)
        dropped = 0
        if len(entries) > _MAX_OFFLINE_QUEUE:
            dropped = len(entries) - _MAX_OFFLINE_QUEUE
            entries = entries[-_MAX_OFFLINE_QUEUE:]
        self._rewrite_offline_entries(entries)
        if dropped > 0:
            logger.warning("离线队列超过上限，已丢弃最旧的 %s 条记录", dropped)

    def _read_offline_entries(self) -> list[dict[str, Any]]:
        if not self.queue_file.exists():
            return []
        entries: list[dict[str, Any]] = []
        for line in self.queue_file.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                logger.warning("跳过损坏的离线队列记录")
        return entries

    def _rewrite_offline_entries(self, entries: list[dict[str, Any]]) -> None:
        if not entries:
            if self.queue_file.exists():
                self.queue_file.unlink()
            return
        payload = "\n".join(json.dumps(item, ensure_ascii=False) for item in entries) + "\n"
        self.queue_file.write_text(payload, encoding="utf-8")

    def get_offline_queue_summary(self) -> dict[str, Any]:
        entries = self._read_offline_entries()
        categories: dict[str, int] = {}
        manual = 0
        cooling = 0
        for entry in entries:
            category = entry.get("error_category", "unknown")
            categories[category] = categories.get(category, 0) + 1
            if entry.get("next_action") == "manual_intervention":
                manual += 1
            if entry.get("next_action") == "cooldown":
                cooling += 1
        return {
            "count": len(entries),
            "categories": categories,
            "manual_intervention": manual,
            "cooldown": cooling,
            "path": str(self.queue_file),
        }

    def _queue_message(
        self,
        session_ref: str,
        role: str,
        content: str,
        metadata: Optional[dict[str, Any]],
        *,
        error_message: str,
        error_category: str,
    ) -> dict[str, Any]:
        retryable = self._is_retryable_category(error_category, session_ref)
        next_retry_at = self._next_retry_at(error_category) if retryable else None
        entry = {
            "kind": "add_message",
            "session_ref": session_ref,
            "role": role,
            "content": content,
            "metadata": metadata or {},
            "queued_at": datetime.now().isoformat(),
            "first_queued_at": datetime.now().isoformat(),
            "last_error": error_message,
            "error_category": error_category,
            "attempt_count": 0,
            "retryable": retryable,
            "next_retry_at": next_retry_at,
            "next_action": "cooldown" if retryable and next_retry_at else ("retry" if retryable else "manual_intervention"),
        }
        self._append_offline_entry(entry)
        summary = self.get_offline_queue_summary()
        logger.warning(
            "消息已转入离线队列: category=%s retryable=%s next_action=%s queue_count=%s session_ref=%s",
            error_category,
            retryable,
            entry["next_action"],
            summary["count"],
            session_ref,
        )
        return {
            "queued": True,
            "reason": error_message,
            "error_category": error_category,
            "retryable": retryable,
            "next_action": entry["next_action"],
            "queue_count": summary["count"],
        }

    def set_active_session(self, session_id: str, title: Optional[str] = None) -> dict[str, Any]:
        data = {
            "session_id": session_id,
            "title": title,
            "updated_at": datetime.now().isoformat(),
        }
        self.state_file.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return data

    def get_active_session(self) -> Optional[dict[str, Any]]:
        if not self.state_file.exists():
            return None
        try:
            return json.loads(self.state_file.read_text(encoding="utf-8"))
        except Exception:
            return None

    async def create_session(
        self, session_id: str, metadata: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        payload = {
            "user_id": self.user_id,
            "title": metadata.get("title", session_id) if metadata else session_id,
            "metadata_json": {"session_id": session_id, **(metadata or {})},
        }
        result = await self._post_json(f"{self.base_url}/api/v1/sessions", payload)
        if isinstance(result, dict) and result.get("id"):
            self.set_active_session(result["id"], result.get("title"))
        return result

    async def find_session_by_external_id(self, external_session_id: str) -> Optional[dict[str, Any]]:
        sessions = await self._get_json(
            f"{self.base_url}/api/v1/sessions", {"user_id": self.user_id, "limit": 100}
        )
        if isinstance(sessions, list):
            for item in sessions:
                metadata = item.get("metadata_json") or {}
                if (
                    metadata.get("opencode_session_id") == external_session_id
                    or metadata.get("session_id") == external_session_id
                ):
                    return item
        return None

    async def get_or_create_external_session(
        self,
        external_session_id: str,
        title: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        existing = await self.find_session_by_external_id(external_session_id)
        if existing:
            self.set_active_session(existing["id"], existing.get("title"))
            return existing
        extra = {"opencode_session_id": external_session_id, **(metadata or {})}
        return await self.create_session(
            external_session_id, {"title": title or external_session_id, **extra}
        )

    async def _resolve_remote_session_id(self, session_id: Optional[str]) -> str:
        if not session_id:
            active = self.get_active_session()
            if not active:
                raise RuntimeError("没有 active session，请先创建或设置一个会话")
            return active["session_id"]
        if self._is_remote_session_id(session_id):
            return session_id
        session = await self.get_or_create_external_session(session_id)
        return session["id"]

    async def _post_message_once(
        self,
        session_ref: str,
        role: str,
        content: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        remote_session_id = await self._resolve_remote_session_id(session_ref)
        payload = {"role": role, "content": content, "metadata_json": metadata or {}}
        return await self._post_json(
            f"{self.base_url}/api/v1/sessions/{remote_session_id}/messages", payload
        )

    async def add_message(
        self,
        session_id: Optional[str],
        role: str,
        content: str,
        metadata: Optional[dict[str, Any]] = None,
        *,
        allow_queue_on_failure: bool = True,
    ) -> dict[str, Any]:
        session_ref = session_id or self.get_active_session_id()
        try:
            return await self._post_message_once(session_ref, role, content, metadata)
        except SessionMemoryHTTPError as exc:
            should_rebind = exc.status == 404 and bool(session_ref) and not self._is_remote_session_id(session_ref)
            if should_rebind:
                try:
                    rebound = await self.get_or_create_external_session(session_ref)
                    return await self._post_json(
                        f"{self.base_url}/api/v1/sessions/{rebound['id']}/messages",
                        {"role": role, "content": content, "metadata_json": metadata or {}},
                    )
                except SessionMemoryHTTPError as rebound_exc:
                    if not allow_queue_on_failure:
                        raise rebound_exc
                    return self._queue_message(
                        session_ref,
                        role,
                        content,
                        metadata,
                        error_message=str(rebound_exc),
                        error_category=self._classify_error(rebound_exc),
                    )
            if not allow_queue_on_failure:
                raise
            return self._queue_message(
                session_ref,
                role,
                content,
                metadata,
                error_message=str(exc),
                error_category=self._classify_error(exc),
            )
        except Exception as exc:
            if not allow_queue_on_failure:
                raise
            return self._queue_message(
                session_ref,
                role,
                content,
                metadata,
                error_message=str(exc),
                error_category=self._classify_error(exc),
            )

    def get_active_session_id(self) -> str:
        active = self.get_active_session()
        if not active:
            raise RuntimeError("没有 active session，请先创建或设置一个会话")
        return active["session_id"]

    async def get_context(self, session_id: Optional[str]) -> dict[str, Any]:
        remote_session_id = await self._resolve_remote_session_id(session_id)
        return await self._get_json(f"{self.base_url}/api/v1/sessions/{remote_session_id}")

    async def sync_offline_queue(self) -> int:
        entries = self._read_offline_entries()
        if not entries:
            return 0

        logger.info("开始同步离线队列: count=%s path=%s", len(entries), self.queue_file)
        remaining: list[dict[str, Any]] = []
        synced = 0
        skipped = 0
        for entry in entries:
            if entry.get("kind") != "add_message":
                remaining.append(entry)
                continue

            if not entry.get("retryable", True):
                skipped += 1
                remaining.append(entry)
                continue

            if not self._should_attempt_now(entry):
                skipped += 1
                remaining.append(entry)
                continue

            try:
                await self.add_message(
                    entry.get("session_ref"),
                    entry.get("role", "user"),
                    entry.get("content", ""),
                    entry.get("metadata") or {},
                    allow_queue_on_failure=False,
                )
                synced += 1
            except Exception as exc:
                category = self._classify_error(exc)
                attempts = int(entry.get("attempt_count", 0)) + 1
                retryable = self._is_retryable_category(category, entry.get("session_ref", ""))
                max_attempts = self._max_attempts_for(category)
                exhausted = attempts >= max_attempts
                entry["last_error"] = str(exc)
                entry["last_attempt_at"] = datetime.now().isoformat()
                entry["attempt_count"] = attempts
                entry["error_category"] = category
                entry["retryable"] = retryable and not exhausted
                entry["next_retry_at"] = self._next_retry_at(category) if (retryable and not exhausted) else None
                entry["next_action"] = (
                    "cooldown"
                    if entry["retryable"] and entry["next_retry_at"]
                    else ("retry" if entry["retryable"] else "manual_intervention")
                )
                remaining.append(entry)

        self._rewrite_offline_entries(remaining)
        summary = self.get_offline_queue_summary()
        logger.info(
            "离线队列同步完成: synced=%s skipped=%s remaining=%s categories=%s manual=%s cooldown=%s",
            synced,
            skipped,
            len(remaining),
            summary["categories"],
            summary["manual_intervention"],
            summary["cooldown"],
        )
        return synced

    async def close(self) -> None:
        return None


_client: Optional[SessionMemoryClient] = None


def get_client() -> SessionMemoryClient:
    global _client
    if _client is None:
        _client = SessionMemoryClient()
    return _client
