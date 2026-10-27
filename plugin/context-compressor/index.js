/**
 * context-compressor plugin (Layer 3)
 *
 * 当 OpenCode 触发上下文压缩（compaction）时，自动从会话记忆服务
 * 拉取最近会话摘要，并注入到压缩 prompt 中，确保压缩后的上下文
 * 包含跨会话的连续记忆。
 *
 * Hooks used:
 *   - experimental.session.compacting  → 注入摘要到压缩 prompt
 *   - experimental.compaction.autocontinue → 确保压缩后自动继续
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const id = "context-compressor";

const BASE_URL = (process.env.SESSION_MEMORY_URL || "http://10.100.1.13:8000").replace(/\/$/, "");
const USER_ID = process.env.SESSION_MEMORY_USER_ID || "jimwong";
const CACHE_FILE = path.join(os.homedir(), ".cache", "session_memory", "context_cache.json");
const STATE_DIR = path.join(os.homedir(), ".cache", "session-memory");
const SESSION_MAP_FILE = path.join(STATE_DIR, "plugin-auto-sessions.json");
const LOG_FILE = path.join(STATE_DIR, "context-compressor-debug.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] [context-compressor] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
}

/**
 * 从 cache 文件读取最近会话摘要（已由 on_session_start hook 填充）
 * 返回摘要字符串数组，每项对应一个历史会话
 */
function readCachedSummaries() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const data = JSON.parse(raw);
    const sessions = data.recent_sessions || [];
    const summaries = [];
    for (const s of sessions) {
      if (s.summary && s.summary.trim()) {
        const title = s.title || s.session_id;
        const updated = s.updated_at ? s.updated_at.slice(0, 10) : "";
        summaries.push(`【历史会话摘要 - ${title} (${updated})】\n${s.summary.trim()}`);
      }
    }
    return summaries;
  } catch (e) {
    log(`readCachedSummaries failed: ${e.message}`);
    return [];
  }
}

// session-map 中 value 直接是 string（remote session id）
function getRemoteSessionId(opencodeSessionId) {
  try {
    const raw = fs.readFileSync(SESSION_MAP_FILE, "utf8");
    const map = JSON.parse(raw);
    // map 结构: { [opencodeId]: remoteSessionId (string) }
    const entry = map[opencodeSessionId];
    if (typeof entry === "string") return entry;
    return entry?.remote_session_id || null;
  } catch (_) {
    return null;
  }
}

/**
 * 同步 HTTP GET（使用 Bun 内置 fetch 的 Promise，但在 hook 中可以 await）
 */
async function fetchCurrentSummary(remoteSessionId) {
  if (!remoteSessionId) return null;
  try {
    const url = `${BASE_URL}/api/v1/sessions/${remoteSessionId}`;
    const res = await fetch(url, {
      headers: { "X-User-ID": USER_ID },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.latest_summary || null;
  } catch (e) {
    log(`fetchCurrentSummary failed: ${e.message}`);
    return null;
  }
}

/**
 * OpenCode v2 插件入口。
 *
 * v1 → v2 映射：
 *   experimental.session.compacting → ctx.session.hook("compaction", ...)
 *   experimental.compaction.autocontinue → v2 无对应 hook（压缩后自动继续已是内建行为），
 *     overflow 紧急摘要改由 compaction hook 内的上下文溢出信号触发。
 *
 * 额外补充 ctx.session.hook("context", ...)：v2 把「模型可见上下文」与「压缩」拆成两个
 * hook 种类，只注册 compaction 覆盖不到普通 agent 轮次，因此这里同时注入本地缓存摘要，
 * 保证跨会话记忆在常规对话中也在场（只读本地 cache，无远程开销）。
 */
export async function setup(ctx) {
  log("Plugin loaded (opencode v2)");

  const localContext = () => {
    const cached = readCachedSummaries();
    if (cached.length === 0) return null;
    return [
      "=== 跨会话记忆（来自会话记忆服务） ===",
      ...cached,
      "=== 跨会话记忆结束 ===",
    ].join("\n\n");
  };

  const remoteContext = async (sessionID) => {
    const parts = [];
    const cached = readCachedSummaries();
    if (cached.length > 0) {
      parts.push(
        "=== 跨会话记忆（来自会话记忆服务） ===",
        ...cached,
        "=== 跨会话记忆结束 ==="
      );
    }
    const remoteId = getRemoteSessionId(sessionID);
    const currentSummary = await fetchCurrentSummary(remoteId);
    if (currentSummary) {
      parts.push(
        "=== 当前会话已有摘要 ===",
        currentSummary,
        "=== 当前会话摘要结束 ==="
      );
    }
    if (parts.length === 0) return null;
    return (
      "\n\n以下是来自会话记忆系统的重要上下文，请在压缩时务必保留这些信息的核心内容：\n\n" +
      parts.join("\n\n")
    );
  };

  // 普通模型请求：注入本地缓存摘要
  await ctx.session.hook("context", (event) => {
    try {
      const text = localContext();
      if (!text) return;
      if (!Array.isArray(event?.system)) return;
      event.system.push({ type: "text", text });
      log("injected cached summaries into model context");
    } catch (err) {
      log(`context hook failed: ${err.message}`);
    }
  });

  // 压缩：注入缓存 + 远程摘要
  await ctx.session.hook("compaction", async (event) => {
    const sessionID = event?.sessionID ?? "unknown";
    try {
      log(`compacting triggered for session ${sessionID}`);
      const text = await remoteContext(sessionID);
      if (!text) {
        log("no summaries available, compaction proceeds without injection");
        return;
      }
      // v2 的 compaction 事件字段随版本演进，这里按可用字段尽力注入
      if (Array.isArray(event?.system)) {
        event.system.push({ type: "text", text });
        log("injected summaries into compaction system prompt");
      } else if (typeof event?.prompt === "string") {
        event.prompt = event.prompt + text;
        log("injected summaries into compaction prompt");
      } else if (Array.isArray(event?.messages)) {
        event.messages.push({ role: "user", content: text });
        log("injected summaries into compaction transcript");
      } else {
        log("compaction event has no injectable field; skipped");
      }
    } catch (err) {
      log(`compaction hook failed: ${err.message}`);
    }
  });
}

export default { id, setup };


const OVERFLOW_LOG_FILE = path.join(STATE_DIR, "overflow-events.log");
const OVERFLOW_MARKER_FILE = path.join(STATE_DIR, "last-overflow.json");

function logOverflow(msg) {
  const line = `[${new Date().toISOString()}] [OVERFLOW] ${msg}\n`;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(OVERFLOW_LOG_FILE, line);
    log(`overflow event logged: ${msg}`);
  } catch (e) {
    log(`logOverflow failed: ${e.message}`);
  }
}

function writeOverflowMarker(sessionID, modelId) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const marker = {
      timestamp: new Date().toISOString(),
      sessionID,
      modelId,
    };
    fs.writeFileSync(OVERFLOW_MARKER_FILE, JSON.stringify(marker, null, 2));
    log(`overflow marker written: ${OVERFLOW_MARKER_FILE}`);
  } catch (e) {
    log(`writeOverflowMarker failed: ${e.message}`);
  }
}

async function triggerEmergencySummary(remoteSessionId) {
  try {
    log(`triggering emergency summary for remote session ${remoteSessionId}`);
    const url = `${BASE_URL}/api/v1/sessions/${remoteSessionId}/summarize`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-ID": USER_ID,
      },
      body: JSON.stringify({ force: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      log(`emergency summary triggered successfully for ${remoteSessionId}`);
    } else {
      const text = await res.text().catch(() => "");
      log(`emergency summary failed: HTTP ${res.status} ${text}`);
    }
  } catch (e) {
    log(`triggerEmergencySummary failed: ${e.message}`);
  }
}

