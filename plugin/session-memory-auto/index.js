import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const id = "session-memory-auto";

const BASE_URL = (process.env.SESSION_MEMORY_URL || "http://10.100.1.13:8000").replace(/\/$/, "");
const USER_ID = process.env.SESSION_MEMORY_USER_ID || "jimwong";
const HOSTNAME = os.hostname();
const STATE_DIR = path.join(os.homedir(), ".cache", "session-memory");
const STATE_FILE = path.join(STATE_DIR, "plugin-auto-sessions.json");
const MESSAGE_STATE_FILE = path.join(STATE_DIR, "plugin-auto-message-state.json");
const CONTINUATION_STATE_FILE = path.join(STATE_DIR, "plugin-auto-continuation.json");
const FAILED_QUEUE_FILE = path.join(STATE_DIR, "plugin-auto-failed-queue.json");
const DEBUG_LOG = path.join(STATE_DIR, "plugin-auto-debug.log");
const PROBE_EVENT_TYPES = new Set([
  "session.created",
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "session.error",
]);
const MESSAGE_FLUSH_DELAY_MS = 250;
const EMPTY_FLUSH_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];
const REMOTE_CONTINUATION_READ_MODE = process.env.PLUGIN_CONTINUATION_READ_MODE || "shadow"; // local | shadow | remote

const messagePartsCache = new Map();
const messageFlushTimers = new Map();
const pendingAssistantFlushInfo = new Map();
const emptyFlushAttempts = new Map();
const sessionFailureState = new Map();
const pendingStateWrites = new Map();
const stateWriteTimers = new Map();
let debugFlushTimer = null;
let debugFlushInFlight = null;
const debugBuffer = [];
const persistedMessageState = loadMessageState();
const continuationState = loadContinuationState();
const failedMessageQueue = loadFailedQueue();
let drainingFailedQueue = false;
let lastCacheCleanupTime = 0;

const MAX_FAILED_QUEUE_SIZE = 500;

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

const MAX_DEBUG_LOG_BYTES = 20 * 1024 * 1024;

async function rotateDebugLogIfNeeded() {
  // 调试日志无上限时曾膨胀到 5GB，这里做定量轮转：超阈值时保留上一份并重新开始
  try {
    const st = await fsp.stat(DEBUG_LOG);
    if (st.size <= MAX_DEBUG_LOG_BYTES) return;
    await fsp.rename(DEBUG_LOG, `${DEBUG_LOG}.1`);
  } catch (_) {
    // 文件不存在或轮转失败都忽略，不影响主流程
  }
}

function flushDebugBufferSoon() {
  if (debugFlushTimer) return;
  debugFlushTimer = setTimeout(() => {
    debugFlushTimer = null;
    if (debugBuffer.length === 0) return;
    const payload = `${debugBuffer.splice(0).join("\n")}\n`;
    debugFlushInFlight = rotateDebugLogIfNeeded()
      .catch(() => {})
      .then(() => fsp.appendFile(DEBUG_LOG, payload, "utf8"))
      .catch(() => {})
      .finally(() => {
        debugFlushInFlight = null;
        if (debugBuffer.length > 0) {
          flushDebugBufferSoon();
        }
      });
  }, 50);
}

function debug(entry) {
  ensureStateDir();
  debugBuffer.push(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
  flushDebugBufferSoon();
}

function summarizeValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > 400 ? `${value.slice(0, 400)}…[truncated:${value.length}]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 3) return "[max-depth]";
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => summarizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 20);
    return Object.fromEntries(entries.map(([key, item]) => [key, summarizeValue(item, depth + 1)]));
  }
  return String(value);
}

function summarizeEvent(event) {
  const properties = event?.properties ?? {};
  return {
    type: event?.type ?? null,
    sessionID: properties.sessionID ?? null,
    messageID: properties.messageID ?? properties.info?.id ?? properties.part?.messageID ?? null,
    partID: properties.partID ?? properties.part?.id ?? null,
    field: properties.field ?? null,
    properties: summarizeValue(properties),
  };
}

function loadJSON(filePath, fallback) {
  ensureStateDir();
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    debug({ step: "loadJSON.error", filePath, error: String(err) });
    return fallback;
  }
}

function queueStateWrite(filePath, value) {
  ensureStateDir();
  pendingStateWrites.set(filePath, JSON.stringify(value, null, 2));
  const existingTimer = stateWriteTimers.get(filePath);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    stateWriteTimers.delete(filePath);
    const payload = pendingStateWrites.get(filePath);
    if (payload == null) return;
    pendingStateWrites.delete(filePath);
    fsp.writeFile(filePath, payload, "utf8").catch((err) => {
      debug({ step: "state.write.error", filePath, error: String(err), stack: err?.stack || null });
    });
  }, 50);
  stateWriteTimers.set(filePath, timer);
}

function saveJSON(filePath, value) {
  queueStateWrite(filePath, value);
}

function loadMap() {
  return loadJSON(STATE_FILE, {});
}

function saveMap(map) {
  saveJSON(STATE_FILE, map);
}

function loadMessageState() {
  return loadJSON(MESSAGE_STATE_FILE, {});
}

function saveMessageState() {
  saveJSON(MESSAGE_STATE_FILE, persistedMessageState);
}

function loadContinuationState() {
  return loadJSON(CONTINUATION_STATE_FILE, {
    pending: null,
    lastConsumed: null,
    autoContinuedSessionIDs: [],
  });
}

function saveContinuationState() {
  saveJSON(CONTINUATION_STATE_FILE, continuationState);
}

function loadFailedQueue() {
  return loadJSON(FAILED_QUEUE_FILE, []);
}

function saveFailedQueue() {
  saveJSON(FAILED_QUEUE_FILE, failedMessageQueue);
}

function hasAutoContinuedSession(sessionID) {
  return Array.isArray(continuationState.autoContinuedSessionIDs)
    && continuationState.autoContinuedSessionIDs.includes(sessionID);
}

function shouldThrottleContinuation(sourceSessionID) {
  if (!sourceSessionID) return false;
  const ids = Array.isArray(continuationState.autoContinuedSessionIDs)
    ? continuationState.autoContinuedSessionIDs
    : [];
  const hitCount = ids.filter((id) => id === sourceSessionID).length;
  return hitCount >= 1;
}

function markAutoContinuedSession(sessionID) {
  if (!sessionID) return;
  if (!Array.isArray(continuationState.autoContinuedSessionIDs)) {
    continuationState.autoContinuedSessionIDs = [];
  }
  if (!continuationState.autoContinuedSessionIDs.includes(sessionID)) {
    continuationState.autoContinuedSessionIDs.push(sessionID);
    continuationState.autoContinuedSessionIDs = continuationState.autoContinuedSessionIDs.slice(-50);
    saveContinuationState();
  }
}

function messageStateKey(sessionID, messageID) {
  return `${sessionID}:${messageID}`;
}

function getMessageCache(messageID, sessionID = null) {
  if (!messagePartsCache.has(messageID)) {
    messagePartsCache.set(messageID, {
      sessionID,
      parts: new Map(),
      updatedAt: Date.now(),
    });
  }
  const cache = messagePartsCache.get(messageID);
  if (sessionID && !cache.sessionID) cache.sessionID = sessionID;
  cache.updatedAt = Date.now();
  return cache;
}

function updateTextPart(part) {
  if (!part?.messageID || part.type !== "text") return;
  const cache = getMessageCache(part.messageID, part.sessionID ?? null);
  const existing = cache.parts.get(part.id) || {
    id: part.id,
    text: "",
    synthetic: false,
    ignored: false,
    time: null,
  };
  cache.parts.set(part.id, {
    ...existing,
    id: part.id,
    text: typeof part.text === "string" ? part.text : existing.text,
    synthetic: Boolean(part.synthetic),
    ignored: Boolean(part.ignored),
    time: part.time ?? existing.time,
  });
  captureDanglingAssistantInfo(part);
  schedulePendingAssistantFlush(part.messageID, "text-part-updated");
}

function appendTextDelta(sessionID, messageID, partID, delta) {
  if (!messageID || !partID || typeof delta !== "string") return;
  const cache = getMessageCache(messageID, sessionID ?? null);
  const existing = cache.parts.get(partID) || {
    id: partID,
    text: "",
    synthetic: false,
    ignored: false,
    time: null,
  };
  cache.parts.set(partID, {
    ...existing,
    id: partID,
    text: `${existing.text || ""}${delta}`,
  });
  captureDanglingAssistantInfo({ messageID, sessionID, time: existing.time });
  if (delta.length > 0) {
    schedulePendingAssistantFlush(messageID, "text-delta");
  }
}

function composeMessageContent(messageID) {
  const cache = messagePartsCache.get(messageID);
  if (!cache) {
    return { content: "", partCount: 0, syntheticCount: 0, ignoredCount: 0 };
  }
  const parts = Array.from(cache.parts.values());
  const visibleParts = parts.filter((part) => !part.ignored && typeof part.text === "string" && part.text.length > 0);
  const content = visibleParts.map((part) => part.text).join("\n\n").trim();
  return {
    content,
    partCount: visibleParts.length,
    syntheticCount: visibleParts.filter((part) => part.synthetic).length,
    ignoredCount: parts.filter((part) => part.ignored).length,
  };
}

function hashMessage(role, content) {
  return crypto.createHash("sha256").update(`${role}\n${content}`).digest("hex");
}

function errorText(errorLike) {
  if (errorLike == null) return "";
  if (typeof errorLike === "string") return errorLike;
  try {
    return JSON.stringify(errorLike);
  } catch {
    return String(errorLike);
  }
}

function truncateText(value, maxLength = 800) {
  if (typeof value !== "string") return "";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…[truncated:${value.length}]`;
}

function isDirectiveNoiseText(content) {
  if (typeof content !== "string") return false;
  return content.includes("[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]")
    || content.includes("<!-- OMO_INTERNAL_INITIATOR -->")
    || content.includes("Incomplete tasks remain in your todo list.")
    || content.includes("Proceed without asking for permission")
    || content.includes("Mark each task complete when finished")
    || content.includes("Do not stop until all tasks are done")
    || content.includes("[Status:");
}

function isContinuationNoiseMessage(message) {
  if (!message || typeof message.content !== "string") return false;
  const eventName = message.metadata_json?.event || null;
  if (eventName === "session.continuation.injected" || eventName === "session.error") {
    return true;
  }
  return isDirectiveNoiseText(message.content)
    || message.content.includes("[自动续接上下文]")
    || message.content.includes("[session:context_overflow_unrecoverable]");
}

function summarizeContinuationMessage(message) {
  return {
    role: message.role,
    content: truncateText(message.content || "", 1200),
    created_at: message.created_at || null,
  };
}

function findLastUserGoal(messages) {
  const lastUser = [...messages].reverse().find((message) => (
    message.role === "user" && !isDirectiveNoiseText(message.content || "")
  ));
  return lastUser ? truncateText(lastUser.content || "", 1200) : null;
}

function buildRecentDialogue(messages) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-6)
    .map(summarizeContinuationMessage);
}

function normalizeContinuationMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && (message.role === "user" || message.role === "assistant" || message.role === "system"))
    .filter((message) => !isContinuationNoiseMessage(message))
    .map(summarizeContinuationMessage);
}

function buildContinuationInstructions(payload) {
  const recentLines = (payload.recent_messages || [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `[${message.role}] ${truncateText(message.content || "", 500)}`);
  const recentBlock = recentLines.length > 0
    ? recentLines.join("\n\n")
    : "[无可用的近期用户/助手消息，需结合旧会话记录继续。]";
  return [
    "[自动续接上下文]",
    `上一轮会话 ${payload.source_session_id} 因上下文溢出而停止，请从以下信息继续工作。`,
    payload.source_session_memory_id ? `session-memory 会话: ${payload.source_session_memory_id}` : null,
    `失败类型: ${payload.failure_code}`,
    `失败说明: ${payload.failure_message}`,
    payload.error_preview ? `错误摘要: ${truncateText(payload.error_preview, 500)}` : null,
    payload.last_user_message ? `上一条用户目标: ${truncateText(payload.last_user_message, 500)}` : null,
    "",
    "[续接要求]",
    "1. 延续上一轮任务，不要从头重新分析整个问题。",
    "2. 优先根据“上一条用户目标”和“近期对话摘录”继续推进。",
    "3. 如果当前信息仍不足，优先回读源会话最近消息，而不是要求用户重复描述。",
    "4. 先给出下一步执行动作，再继续开展实现或排查。",
    "",
    "[近期对话摘录]",
    recentBlock,
  ].filter(Boolean).join("\n");
}

async function fetchContinuationMessages(sessionMemoryID) {
  if (!sessionMemoryID) return [];
  try {
    const messages = await getJSON(`${BASE_URL}/api/v1/sessions/${encodeURIComponent(sessionMemoryID)}/messages?count=20`);
    return normalizeContinuationMessages(messages);
  } catch (err) {
    debug({ step: "continuation.messages.error", sessionMemoryID, error: String(err), stack: err?.stack || null, errorCategory: classifyRequestError(err) });
    return [];
  }
}

async function storeContinuationPayload(sessionID, classification, errorLike) {
  if (!sessionID || !classification?.code) return null;
  if (classification.code !== "context_overflow_unrecoverable" && classification.code !== "session_unhealthy_unrecoverable") {
    return null;
  }
  if (hasAutoContinuedSession(sessionID) || shouldThrottleContinuation(sessionID)) {
    debug({ step: "continuation.payload.skip.already-auto-continued", sourceSessionID: sessionID, failureCode: classification.code });
    return null;
  }
  if (continuationState.pending?.source_session_id === sessionID) {
    debug({ step: "continuation.payload.skip.duplicate_pending", sourceSessionID: sessionID, failureCode: classification.code });
    return null;
  }
  const sessionMemoryID = await ensureSession(sessionID);
  const normalizedMessages = await fetchContinuationMessages(sessionMemoryID);
  const recentMessages = buildRecentDialogue(normalizedMessages);
  const lastUserMessage = findLastUserGoal(normalizedMessages);
  const payload = {
    version: 3,
    source_session_id: sessionID,
    source_session_memory_id: sessionMemoryID,
    failure_code: classification.code,
    failure_message: classification.message,
    reason_detail: classification.reasonDetail || null,
    error_preview: truncateText(errorText(errorLike), 2000),
    last_user_message: lastUserMessage,
    recent_messages: recentMessages,
    captured_message_count: normalizedMessages.length,
    created_at: new Date().toISOString(),
  };
  continuationState.pending = payload;
  saveContinuationState();
  await mirrorContinuationState(payload);
  await postContinuationMetricEvent({
    event: "stored",
    failure_code: payload.failure_code || classification.code || "unknown",
    pending: 1,
    latest_age_seconds: 0,
  });
  debug({
    step: "continuation.payload.stored",
    sourceSessionID: sessionID,
    failureCode: classification.code,
    reasonDetail: classification.reasonDetail || null,
    messageCount: recentMessages.length,
    capturedMessageCount: normalizedMessages.length,
    hasLastUserMessage: Boolean(lastUserMessage),
  });
  return payload;
}

async function consumeContinuationPayload(targetSessionID) {
  let payload = continuationState.pending;
  if (!payload && REMOTE_CONTINUATION_READ_MODE !== "local") {
    const remotePayload = await readLatestRemoteContinuationState();
    if (
      remotePayload
      && !remotePayload.consumed_by_session_id
      && remotePayload.source_session_id
      && remotePayload.source_session_id !== targetSessionID
    ) {
      continuationState.pending = remotePayload;
      saveContinuationState();
      payload = remotePayload;
      debug({
        step: "continuation.payload.loaded.remote",
        sourceSessionID: remotePayload.source_session_id,
        targetSessionID,
      });
    }
  }
  if (!payload) {
    debug({ step: "continuation.payload.miss", targetSessionID });
    return null;
  }
  if (hasAutoContinuedSession(payload.source_session_id)) {
    debug({
      step: "continuation.payload.skip.throttled",
      targetSessionID,
      sourceSessionID: payload.source_session_id,
    });
    continuationState.pending = null;
    saveContinuationState();
    return null;
  }

  if (!targetSessionID || payload.source_session_id === targetSessionID) {
    debug({
      step: "continuation.payload.skip.same-session",
      targetSessionID,
      sourceSessionID: payload.source_session_id,
    });
    return null;
  }

  const sessionMemoryID = await ensureSession(targetSessionID);

  if (payload?.source_session_id) {
    const captured = await checkBudgetPressureAndProactivelyCapture(payload.source_session_id, sessionMemoryID);
    if (captured && continuationState.pending) {
      payload = continuationState.pending;
    }
  }

  const content = buildContinuationInstructions(payload);
  await writeSystemMessage(sessionMemoryID, content, {
    event: "session.continuation.injected",
    opencode_session_id: targetSessionID,
    continuation_source_session_id: payload.source_session_id,
    failure_code: payload.failure_code,
    carried_message_count: Array.isArray(payload.recent_messages) ? payload.recent_messages.length : 0,
    continuation_created_at: payload.created_at,
    auto_continued: true,
  });

  const consumedAt = new Date().toISOString();
  continuationState.lastConsumed = {
    ...payload,
    target_session_id: targetSessionID,
    consumed_at: consumedAt,
  };
  continuationState.pending = null;
  markAutoContinuedSession(payload.source_session_id);
  saveContinuationState();
  await markRemoteContinuationConsumed(payload.source_session_id, targetSessionID);
  await postContinuationMetricEvent({
    event: "consumed",
    failure_code: payload.failure_code || "unknown",
    pending: 0,
    latest_age_seconds: payload.created_at ? Math.max(0, Math.floor((Date.now() - new Date(payload.created_at).getTime()) / 1000)) : null,
  });
  debug({
    step: "continuation.payload.consumed",
    sourceSessionID: payload.source_session_id,
    targetSessionID,
  });
  return continuationState.lastConsumed;
}

function classifySessionFailure(errorLike) {
  const text = errorText(errorLike);
  if (!text) return null;
  if (
    text.includes("ContextOverflowError")
    && text.includes("Session too large to compact - context exceeds model limit even after stripping media")
  ) {
    return {
      code: "context_overflow_unrecoverable",
      terminal: true,
      recoverable: false,
      message: "会话上下文在压缩后仍超出模型限制，已停止自动重试。",
      reasonDetail: "context_overflow",
    };
  }
  if (
    text.includes("WebSocket stream closed before first payload")
    || text.includes("upstream stream closed before first payload")
    || text.includes("empty_stream")
  ) {
    return {
      code: "message_aborted_recoverable",
      terminal: true,
      recoverable: true,
      message: "上游流在首包前中断，本轮生成已结束，可由用户重试。",
      reasonDetail: "stream_closed_pre_payload",
    };
  }
  if (
    text.includes("WebSocket stream interrupted after first payload")
    || text.includes("WebSocket stream interrupted before response.completed")
  ) {
    return {
      code: "message_aborted_recoverable",
      terminal: true,
      recoverable: true,
      message: "上游流在生成过程中中断，本轮生成已结束，可由用户重试。",
      reasonDetail: "stream_interrupted_midflight",
    };
  }
  if (text.includes("MessageAbortedError")) {
    return {
      code: "message_aborted_recoverable",
      terminal: true,
      recoverable: true,
      message: "本次消息生成已中止，当前轮次已结束，可由用户显式重试。",
      reasonDetail: "message_aborted",
    };
  }
  if (text.includes("RecoveredStuckMessageError")) {
    return {
      code: "session_unhealthy_unrecoverable",
      terminal: true,
      recoverable: false,
      message: "检测到旧会话消息曾经悬挂且恢复后仍不可继续，已准备自动续接。",
      reasonDetail: "recovered_stuck_failed",
    };
  }
  return null;
}

function classifyBadSessionState(info) {
  if (!info || info.role !== "assistant" || !info.sessionID || !info.id) return null;
  const failure = getSessionFailure(info.sessionID);
  if (failure?.code === "session_unhealthy_unrecoverable") return failure;
  const hasTerminalState = Boolean(info.time?.completed || info.error || info.finish);
  if (hasTerminalState) return null;
  const attemptCount = emptyFlushAttempts.get(info.id) || 0;
  if (attemptCount < EMPTY_FLUSH_RETRY_DELAYS_MS.length) return null;
  return {
    code: "session_unhealthy_unrecoverable",
    terminal: true,
    recoverable: false,
    message: "检测到 assistant 消息长时间未完成且重试耗尽，已准备自动续接。",
    reasonDetail: "dangling_assistant",
  };
}

function sessionFailureKey(sessionID, code) {
  return `${sessionID}:${code}`;
}

function getSessionFailure(sessionID) {
  for (const value of sessionFailureState.values()) {
    if (value.sessionID === sessionID) return value;
  }
  return null;
}

async function finalizeSessionFailure(sessionID, classification, errorLike) {
  if (!sessionID || !classification?.code) return null;
  const key = sessionFailureKey(sessionID, classification.code);
  if (sessionFailureState.has(key)) {
    return sessionFailureState.get(key);
  }
  const state = {
    ...classification,
    sessionID,
    errorText: errorText(errorLike).slice(0, 2000),
    recordedAt: new Date().toISOString(),
  };
  sessionFailureState.set(key, state);
  const smSessionID = await ensureSession(sessionID);
  await writeSystemMessage(
    smSessionID,
    `[session:${classification.code}] ${classification.message}`,
    {
      event: "session.error",
      opencode_session_id: sessionID,
      failure_code: classification.code,
      terminal: classification.terminal,
      recoverable: classification.recoverable,
      error_preview: state.errorText,
      transitioned_at: state.recordedAt,
    },
  );
  if (classification.code === "context_overflow_unrecoverable" || classification.code === "session_unhealthy_unrecoverable") {
    await storeContinuationPayload(sessionID, classification, errorLike);
  }
  debug({
    step: "session.failure.finalized",
    sessionID,
    failureCode: classification.code,
    terminal: classification.terminal,
    recoverable: classification.recoverable,
  });
  return state;
}

function clearMessageArtifacts(messageID) {
  clearAssistantFlushState(messageID);
  messageFlushTimers.delete(messageID);
  messagePartsCache.delete(messageID);
}

function shouldFlushMessage(info) {
  if (!info?.id || !info?.sessionID) return false;
  if (info.role === "user") return true;
  if (info.role !== "assistant") return false;
  return Boolean(info.time?.completed || info.error || info.finish);
}

function scheduleMessageFlush(info, delayMs = MESSAGE_FLUSH_DELAY_MS) {
  if (!info?.id) return;
  const existingTimer = messageFlushTimers.get(info.id);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    messageFlushTimers.delete(info.id);
    persistMessageFromCache(info).catch((err) => {
      debug({ step: "message.persist.error", messageID: info.id, error: String(err), stack: err?.stack || null, errorCategory: classifyRequestError(err) });
      console.error("[session-memory-auto] message persist failed", err);
    });
  }, delayMs);
  messageFlushTimers.set(info.id, timer);
}

function schedulePendingAssistantFlush(messageID, reason) {
  const info = pendingAssistantFlushInfo.get(messageID);
  if (!info) return;
  debug({ step: "message.flush.reschedule.pending", sessionID: info.sessionID, messageID, role: info.role, reason });
  scheduleMessageFlush(info);
}

function captureDanglingAssistantInfo(part) {
  if (!part?.messageID || !part?.sessionID) return;
  if (pendingAssistantFlushInfo.has(part.messageID)) return;
  pendingAssistantFlushInfo.set(part.messageID, {
    id: part.messageID,
    sessionID: part.sessionID,
    role: "assistant",
    time: part.time || { created: Date.now() },
  });
  debug({ step: "message.flush.capture.dangling", sessionID: part.sessionID, messageID: part.messageID, role: "assistant" });
}

function scheduleEmptyFlushRetry(info) {
  if (info?.role !== "assistant" || !info.id) return false;
  pendingAssistantFlushInfo.set(info.id, info);
  const attempt = emptyFlushAttempts.get(info.id) || 0;
  const delayMs = EMPTY_FLUSH_RETRY_DELAYS_MS[attempt];
  if (delayMs == null) {
    const failure = getSessionFailure(info.sessionID);
    debug({
      step: failure ? "message.persist.finalize.empty" : "message.persist.abandon.empty",
      sessionID: info.sessionID,
      messageID: info.id,
      role: info.role,
      attempts: attempt,
      failureCode: failure?.code ?? null,
    });
    if (!failure) {
      const danglingClassification = classifyBadSessionState(info);
      if (danglingClassification) {
        finalizeSessionFailure(info.sessionID, danglingClassification, {
          name: "RecoveredStuckMessageError",
          message: "Assistant message remained unfinished after all empty flush retries.",
          messageID: info.id,
        }).catch((err) => {
          debug({ step: "session.failure.auto-continuation.error", sessionID: info.sessionID, messageID: info.id, error: String(err), stack: err?.stack || null, errorCategory: classifyRequestError(err) });
        });
      }
    }
    clearMessageArtifacts(info.id);
    return false;
  }
  emptyFlushAttempts.set(info.id, attempt + 1);
  debug({ step: "message.persist.retry.empty", sessionID: info.sessionID, messageID: info.id, role: info.role, attempt: attempt + 1, delayMs });
  scheduleMessageFlush(info, delayMs);
  return true;
}

function clearAssistantFlushState(messageID) {
  pendingAssistantFlushInfo.delete(messageID);
  emptyFlushAttempts.delete(messageID);
}

function createRequestError(method, url, status, text) {
  const err = new Error(`${method} ${url} failed: ${status ?? "network"} ${text}`.trim());
  err.request = { method, url, status, text };
  return err;
}

function classifyRequestError(err) {
  const status = err?.request?.status;
  if (status === 404) return "session_not_found";
  if (status === 429) return "rate_limited";
  if (typeof status === "number" && status >= 500) return "server_error";
  if (typeof status === "number") return "http_error";
  return "network_error";
}

function isRetryableRequestError(err) {
  const status = err?.request?.status;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;
  return status == null;
}

function retryDelayMs(attempt) {
  return [300, 1000, 2500, 5000, 8000][attempt] ?? 8000;
}

function enqueueFailedWrite(item) {
  if (failedMessageQueue.length >= MAX_FAILED_QUEUE_SIZE) {
    failedMessageQueue.shift();
    debug({ step: "failedQueue.dropped", reason: "max_size", size: failedMessageQueue.length });
  }
  failedMessageQueue.push({
    ...item,
    queuedAt: new Date().toISOString(),
    retries: 0,
  });
  saveFailedQueue();
  debug({ step: "failedQueue.enqueue", size: failedMessageQueue.length, sessionID: item.sessionID, messageID: item.messageID });
}

async function drainFailedQueue() {
  if (drainingFailedQueue) return;
  if (failedMessageQueue.length === 0) return;
  drainingFailedQueue = true;
  try {
    let processed = 0;
    let consecutiveFailures = 0;
    while (failedMessageQueue.length > 0 && processed < 20) {
      const item = failedMessageQueue[0];
      try {
        const payload = {
          role: item.role,
          content: item.content,
          metadata_json: {
            source: "session-memory-auto",
            host: HOSTNAME,
            ...(item.metadata || {}),
          },
        };
        await postJSON(`${BASE_URL}/api/v1/sessions/${item.smSessionID}/messages`, payload);
        failedMessageQueue.shift();
        saveFailedQueue();
        processed += 1;
        consecutiveFailures = 0;
        debug({ step: "failedQueue.flush.ok", remaining: failedMessageQueue.length, sessionID: item.sessionID, messageID: item.messageID });
      } catch (err) {
        item.retries = (item.retries || 0) + 1;
        consecutiveFailures += 1;
        if (item.retries >= 20) {
          debug({ step: "failedQueue.drop.maxRetry", sessionID: item.sessionID, messageID: item.messageID, error: String(err) });
          failedMessageQueue.shift();
        } else {
          debug({ step: "failedQueue.flush.retryLater", retries: item.retries, sessionID: item.sessionID, messageID: item.messageID, error: String(err) });
        }
        saveFailedQueue();
        if (consecutiveFailures >= 5) {
          debug({ step: "failedQueue.drain.pause", consecutiveFailures, remaining: failedMessageQueue.length });
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** consecutiveFailures, 32) * 1000));
      }
    }
  } finally {
    drainingFailedQueue = false;
  }
}

async function fetchWithRetry(url, init = {}, { method = "GET", retryable = true } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      debug({
        step: `${method.toLowerCase()}.response`,
        url,
        status: res.status,
        attempt: attempt + 1,
        errorCategory: res.ok ? null : classifyRequestError(createRequestError(method, url, res.status, text)),
        bodyPreview: text.slice(0, 300),
      });
      if (!res.ok) {
        throw createRequestError(method, url, res.status, text);
      }
      return text;
    } catch (err) {
      lastError = err?.request ? err : createRequestError(method, url, null, String(err));
      const errorCategory = classifyRequestError(lastError);
      const shouldRetry = retryable && attempt < 4 && isRetryableRequestError(lastError);
      debug({
        step: `${method.toLowerCase()}.retry`,
        url,
        attempt: attempt + 1,
        shouldRetry,
        status: lastError?.request?.status ?? null,
        errorCategory,
        error: String(lastError),
      });
      if (!shouldRetry) {
        throw lastError;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }
  throw lastError;
}

function isSessionNotFoundError(err) {
  const status = err?.request?.status;
  const text = String(err?.request?.text || err?.message || "").toLowerCase();
  return status === 404 || text.includes("session not found") || text.includes("notfounderror");
}

async function getJSON(url) {
  debug({ step: "getJSON.request", url });
  const text = await fetchWithRetry(url, {}, { method: "GET" });
  return JSON.parse(text);
}

async function postJSON(url, body) {
  debug({ step: "postJSON.request", url, body: summarizeValue(body) });
  const text = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, { method: "POST" });
  return JSON.parse(text);
}

async function mirrorSessionMapState(opencodeSessionID, sessionMemoryID) {
  try {
    await postJSON(`${BASE_URL}/api/v1/plugin-state/session-map`, {
      opencode_session_id: opencodeSessionID,
      session_memory_id: sessionMemoryID,
      host: HOSTNAME,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    debug({ step: "mirror.session_map.error", opencodeSessionID, sessionMemoryID, error: String(err), stack: err?.stack || null, errorCategory: classifyRequestError(err) });
  }
}

async function mirrorContinuationState(payload) {
  if (!payload?.source_session_id) return;
  try {
    await postJSON(`${BASE_URL}/api/v1/plugin-state/continuation`, {
      ...payload,
      host: HOSTNAME,
    });
    debug({
      step: "continuation.remote.stored",
      sourceSessionID: payload.source_session_id,
      failureCode: payload.failure_code,
    });
  } catch (err) {
    debug({ step: "continuation.remote.store.error", sourceSessionID: payload.source_session_id, error: String(err), stack: err?.stack || null, errorCategory: classifyRequestError(err) });
  }
}

async function readRemoteContinuationState(sourceSessionID) {
  if (!sourceSessionID) return null;
  try {
    const data = await getJSON(`${BASE_URL}/api/v1/plugin-state/continuation/${encodeURIComponent(sourceSessionID)}`);
    return data?.value || null;
  } catch (err) {
    debug({ step: "continuation.remote.read.error", sourceSessionID, error: String(err), stack: err?.stack || null, errorCategory: classifyRequestError(err) });
    return null;
  }
}

async function readSessionContextStats(smSessionID) {
  try {
    const data = await getJSON(`${BASE_URL}/api/v1/sessions/${smSessionID}/context-stats`);
    return data || null;
  } catch (err) {
    debug({ step: "context-stats.read.error", smSessionID, error: String(err), stack: err?.stack || null, errorCategory: classifyRequestError(err) });
    return null;
  }
}

async function checkBudgetPressureAndProactivelyCapture(sessionID, smSessionID) {
  if (hasAutoContinuedSession(sessionID)) {
    debug({ step: "budget.check.skip.already-continued", sessionID });
    return false;
  }
  const stats = await readSessionContextStats(smSessionID);
  if (!stats) return false;
  const state = stats.budget_state || "normal";
  const ratio = stats.budget_ratio || 0;
  if (state === "normal") {
    debug({ step: "budget.check.skip.normal", sessionID, budgetState: state, budgetRatio: ratio });
    return false;
  }
  debug({ step: "budget.check.proactive.capture", sessionID, budgetState: state, budgetRatio: ratio });
  const classification = {
    code: "context_overflow_unrecoverable",
    terminal: true,
    recoverable: false,
    message: `会话上下文压力过高（budget_state=${state}，budget_ratio=${ratio.toFixed(3)}），提前触发自动续接以防止溢出错误。`,
    reasonDetail: "budget_pressure_proactive",
  };
  await storeContinuationPayload(sessionID, classification, { budget_state: state, budget_ratio: ratio });
  return true;
}

async function readLatestRemoteContinuationState() {
  try {
    const data = await getJSON(`${BASE_URL}/api/v1/plugin-state/continuation/latest`);
    return data?.value || null;
  } catch (err) {
    debug({ step: "continuation.remote.latest.error", error: String(err), stack: err?.stack || null, errorCategory: classifyRequestError(err) });
    return null;
  }
}

async function postContinuationMetricEvent(payload) {
  try {
    await postJSON(`${BASE_URL}/api/v1/admin/metrics/continuation-event`, payload);
  } catch (err) {
    debug({ step: "continuation.metric_event.error", error: String(err), payload: summarizeValue(payload), stack: err?.stack || null, errorCategory: classifyRequestError(err) });
  }
}

async function markRemoteContinuationConsumed(sourceSessionID, targetSessionID) {
  if (!sourceSessionID || !targetSessionID) return null;
  try {
    const data = await postJSON(`${BASE_URL}/api/v1/plugin-state/continuation/${encodeURIComponent(sourceSessionID)}/consume?target_session_id=${encodeURIComponent(targetSessionID)}`, {});
    debug({ step: "continuation.remote.consumed", sourceSessionID, targetSessionID });
    return data?.value || null;
  } catch (err) {
    debug({ step: "continuation.remote.consume.error", sourceSessionID, targetSessionID, error: String(err), stack: err?.stack || null, errorCategory: classifyRequestError(err) });
    return null;
  }
}

async function mirrorMessageState(sessionID, messageID, contentHash, role) {
  try {
    await postJSON(`${BASE_URL}/api/v1/plugin-state/message-state`, {
      session_id: sessionID,
      message_id: messageID,
      content_hash: contentHash,
      role,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    debug({ step: "mirror.message_state.error", sessionID, messageID, error: String(err), stack: err?.stack || null, errorCategory: classifyRequestError(err) });
  }
}

/** 同一 opencode 会话正在进行的 ensureSession，避免并发重复创建 */
const ensureSessionInflight = new Map();

async function ensureSession(opencodeSessionID, options = {}) {
  const { forceRefresh = false } = options;
  if (!forceRefresh) {
    const cached = loadMap()[opencodeSessionID];
    if (cached) {
      debug({ step: "ensureSession.cached", opencodeSessionID, sessionMemoryID: cached });
      return cached;
    }
    const inflight = ensureSessionInflight.get(opencodeSessionID);
    if (inflight) {
      debug({ step: "ensureSession.inflight", opencodeSessionID });
      return inflight;
    }
  }
  const promise = ensureSessionImpl(opencodeSessionID, options);
  ensureSessionInflight.set(opencodeSessionID, promise);
  try {
    return await promise;
  } finally {
    ensureSessionInflight.delete(opencodeSessionID);
  }
}

async function deleteSessionRemote(sessionMemoryID) {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/sessions/${encodeURIComponent(sessionMemoryID)}`, {
      method: "DELETE",
      headers: { "X-User-ID": USER_ID },
      signal: AbortSignal.timeout(10000),
    });
    debug({ step: "ensureSession.delete_duplicate", sessionMemoryID, status: res.status });
    return res.ok;
  } catch (err) {
    debug({ step: "ensureSession.delete_duplicate.error", sessionMemoryID, error: String(err) });
    return false;
  }
}

/**
 * 并发窗口内可能为同一个 opencode 会话创建出多个记忆系统 session，
 * 这里复查并清理：保留消息最多的一个，空的重复项直接删除。
 */
async function dedupeSessionsFor(opencodeSessionID, preferredID) {
  try {
    const all = await getJSON(`${BASE_URL}/api/v1/sessions?user_id=${encodeURIComponent(USER_ID)}&limit=100`);
    const siblings = (Array.isArray(all) ? all : []).filter(
      (s) => (s?.metadata_json || {}).opencode_session_id === opencodeSessionID
    );
    if (siblings.length <= 1) return preferredID;

    const scored = [];
    for (const s of siblings) {
      let count = 0;
      try {
        const msgs = await getJSON(`${BASE_URL}/api/v1/sessions/${encodeURIComponent(s.id)}/messages?count=50`);
        if (Array.isArray(msgs)) count = msgs.length;
        else if (msgs && Array.isArray(msgs.messages)) count = msgs.messages.length;
      } catch (_) {
        count = 0;
      }
      scored.push({ id: s.id, count });
    }
    // 优先保留消息最多的；消息数相同时保留最早创建（列表靠前）的
    scored.sort((a, b) => b.count - a.count);
    const keep = scored[0].id;
    for (const item of scored.slice(1)) {
      if (item.count > 0) {
        debug({ step: "ensureSession.duplicate_kept", opencodeSessionID, sessionMemoryID: item.id, messages: item.count });
        continue;
      }
      await deleteSessionRemote(item.id);
    }
    debug({ step: "ensureSession.dedupe", opencodeSessionID, keep, candidates: scored.length });
    return keep;
  } catch (err) {
    debug({ step: "ensureSession.dedupe.error", opencodeSessionID, error: String(err) });
    return preferredID;
  }
}

async function ensureSessionImpl(opencodeSessionID, options = {}) {
  const { forceRefresh = false } = options;
  debug({ step: "ensureSession.start", opencodeSessionID, forceRefresh });
  const map = loadMap();

  const sessions = await getJSON(`${BASE_URL}/api/v1/sessions?user_id=${encodeURIComponent(USER_ID)}&limit=100`);
  const found = Array.isArray(sessions)
    ? sessions.find((s) => (s.metadata_json || {}).opencode_session_id === opencodeSessionID)
    : null;

  if (found?.id) {
    map[opencodeSessionID] = found.id;
    saveMap(map);
    await mirrorSessionMapState(opencodeSessionID, found.id);
    debug({ step: "ensureSession.foundExisting", opencodeSessionID, sessionMemoryID: found.id });
    return found.id;
  }

  const created = await postJSON(`${BASE_URL}/api/v1/sessions`, {
    user_id: USER_ID,
    title: `opencode:${opencodeSessionID}`,
    metadata_json: {
      source: "session-memory-auto",
      mode: "tool-audit",
      opencode_session_id: opencodeSessionID,
      host: HOSTNAME,
    },
  });

  const dedupedID = await dedupeSessionsFor(opencodeSessionID, created.id);
  map[opencodeSessionID] = dedupedID;
  saveMap(map);
  await mirrorSessionMapState(opencodeSessionID, dedupedID);
  debug({ step: "ensureSession.created", opencodeSessionID, sessionMemoryID: dedupedID });
  return dedupedID;
}

async function writeMessage(sessionID, role, content, metadata = {}) {
  if (isDirectiveNoiseText(content || "")) {
    debug({ step: "writeMessage.skip.directive_noise", sessionID, role, contentPreview: (content || "").slice(0, 200), metadata: summarizeValue(metadata) });
    return null;
  }
  debug({ step: "writeMessage.start", sessionID, role, contentPreview: content.slice(0, 200), metadata: summarizeValue(metadata) });
  const payload = {
    role,
    content,
    metadata_json: {
      source: "session-memory-auto",
      host: HOSTNAME,
      ...metadata,
    },
  };
  try {
    const result = await postJSON(`${BASE_URL}/api/v1/sessions/${sessionID}/messages`, payload);
    debug({ step: "writeMessage.done", sessionID, messageID: result?.id || null, role });
    return result;
  } catch (err) {
    if (!isSessionNotFoundError(err)) {
      debug({ step: "writeMessage.error", sessionID, role, error: String(err), errorCategory: classifyRequestError(err) });
      throw err;
    }
    const opencodeSessionID = metadata?.opencode_session_id;
    if (!opencodeSessionID) {
      throw err;
    }
    const map = loadMap();
    delete map[opencodeSessionID];
    saveMap(map);
    debug({ step: "writeMessage.session_rebind", sessionID, role, opencodeSessionID, errorCategory: classifyRequestError(err) });
    const reboundSessionID = await ensureSession(opencodeSessionID, { forceRefresh: true });
    const result = await postJSON(`${BASE_URL}/api/v1/sessions/${reboundSessionID}/messages`, payload);
    debug({ step: "writeMessage.done.rebound", sessionID: reboundSessionID, messageID: result?.id || null, role, previousSessionID: sessionID });
    return result;
  }
}

async function writeSystemMessage(sessionID, content, metadata = {}) {
  return writeMessage(sessionID, "system", content, metadata);
}

async function persistMessageFromCache(info) {
  const sessionID = info?.sessionID;
  const messageID = info?.id;
  const role = info?.role;
  if (!sessionID || !messageID || (role !== "user" && role !== "assistant")) {
    debug({ step: "message.persist.skip.invalid", info: summarizeValue(info) });
    return;
  }

  const { content, partCount, syntheticCount, ignoredCount } = composeMessageContent(messageID);
  if (!content) {
    debug({ step: "message.persist.skip.empty", sessionID, messageID, role, partCount, syntheticCount, ignoredCount });
    scheduleEmptyFlushRetry(info);
    return;
  }

  clearAssistantFlushState(messageID);
  const contentHash = hashMessage(role, content);
  const stateKey = messageStateKey(sessionID, messageID);
  if (persistedMessageState[stateKey]?.contentHash === contentHash) {
    debug({ step: "message.persist.skip.duplicate", sessionID, messageID, role, contentHash });
    return;
  }

  const smSessionID = await ensureSession(sessionID);
  try {
    await writeMessage(smSessionID, role, content, {
      event: "message.updated",
      opencode_session_id: sessionID,
      opencode_message_id: messageID,
      opencode_role: role,
      opencode_agent: info.agent ?? null,
      opencode_model: role === "user"
        ? {
            providerID: info.model?.providerID ?? null,
            modelID: info.model?.modelID ?? null,
            variant: info.model?.variant ?? null,
          }
        : {
            providerID: info.providerID ?? null,
            modelID: info.modelID ?? null,
            variant: info.variant ?? null,
          },
      created_at: info.time?.created ?? null,
      completed_at: info.time?.completed ?? null,
      content_hash: contentHash,
      text_part_count: partCount,
      synthetic_part_count: syntheticCount,
      ignored_part_count: ignoredCount,
    });
  } catch (err) {
    const status = err?.request?.status ?? null;
    if (status == null) {
      enqueueFailedWrite({
        sessionID,
        smSessionID,
        messageID,
        role,
        content,
        metadata: {
          event: "message.updated",
          opencode_session_id: sessionID,
          opencode_message_id: messageID,
          opencode_role: role,
          opencode_agent: info.agent ?? null,
          opencode_model: role === "user"
            ? {
                providerID: info.model?.providerID ?? null,
                modelID: info.model?.modelID ?? null,
                variant: info.model?.variant ?? null,
              }
            : {
                providerID: info.providerID ?? null,
                modelID: info.modelID ?? null,
                variant: info.variant ?? null,
              },
          created_at: info.time?.created ?? null,
          completed_at: info.time?.completed ?? null,
          content_hash: contentHash,
          text_part_count: partCount,
          synthetic_part_count: syntheticCount,
          ignored_part_count: ignoredCount,
        },
      });
      debug({ step: "message.persist.queued.network", sessionID, messageID, role });
      return;
    }
    throw err;
  }


  persistedMessageState[stateKey] = {
    contentHash,
    role,
    updatedAt: new Date().toISOString(),
  };
  saveMessageState();
  await mirrorMessageState(sessionID, messageID, contentHash, role);
  debug({ step: "message.persist.done", sessionID, messageID, role, contentHash, partCount });
}

async function handleGenericEvent(event) {
  if (!PROBE_EVENT_TYPES.has(event?.type)) return;

  debug({
    step: "event.probe",
    event: summarizeEvent(event),
  });

  const properties = event?.properties ?? {};

  if (event.type === "session.created" && properties.sessionID) {
    try {
      await ensureSession(properties.sessionID);
      await consumeContinuationPayload(properties.sessionID);
      debug({ step: "session.prewarm.done", sessionID: properties.sessionID });
    } catch (err) {
      debug({ step: "session.prewarm.error", sessionID: properties.sessionID, error: String(err), stack: err?.stack || null, errorCategory: classifyRequestError(err) });
    }
    return;
  }

  if (event.type === "session.error" && properties.sessionID) {
    const classification = classifySessionFailure(properties.error ?? properties);
    if (classification) {
      await finalizeSessionFailure(properties.sessionID, classification, properties.error ?? properties);
    }
    return;
  }

  if (event.type === "message.part.updated") {
    updateTextPart(properties.part);
    return;
  }

  if (event.type === "message.part.delta" && properties.field === "text") {
    appendTextDelta(properties.sessionID, properties.messageID, properties.partID, properties.delta);
    return;
  }

  if (event.type === "message.updated" && properties.info) {
    const info = properties.info;
    if (info.role === "assistant") {
      const classification = classifySessionFailure(info.error);
      if (classification) {
        await finalizeSessionFailure(info.sessionID, classification, info.error);
      }
    }
    if (shouldFlushMessage(info)) {
      if (info.role === "assistant") {
        pendingAssistantFlushInfo.set(info.id, info);
      }
      scheduleMessageFlush(info);
    } else {
      debug({ step: "message.flush.skip.not-ready", sessionID: info.sessionID, messageID: info.id, role: info.role });
    }
  }
}

function pruneMessageState(maxAgeDays = 7) {
  const now = Date.now();
  const cutoff = now - maxAgeDays * 86400 * 1000;
  const keysToDelete = Object.keys(persistedMessageState).filter((k) => {
    const entry = persistedMessageState[k];
    return entry?.updatedAt ? new Date(entry.updatedAt).getTime() < cutoff : false;
  });
  for (const k of keysToDelete) {
    delete persistedMessageState[k];
  }
  if (keysToDelete.length > 0) {
    debug({ step: "message_state.pruned", count: keysToDelete.length });
  }
}

function cleanupCaches() {
  const now = Date.now();
  const cutoff = now - 3600 * 1000;
  let expiredCount = 0;

  for (const [messageID, cache] of messagePartsCache.entries()) {
    if (cache?.updatedAt && cache.updatedAt < cutoff) {
      messagePartsCache.delete(messageID);
      expiredCount++;
    }
  }

  for (const [messageID, info] of pendingAssistantFlushInfo.entries()) {
    if (info?._lastAccess && info._lastAccess < cutoff) {
      pendingAssistantFlushInfo.delete(messageID);
      expiredCount++;
    }
  }

  for (const [key, state] of sessionFailureState.entries()) {
    if (state?.recordedAt) {
      const recordedTime = new Date(state.recordedAt).getTime();
      if (recordedTime < cutoff) {
        sessionFailureState.delete(key);
        expiredCount++;
      }
    }
  }

  if (expiredCount > 0) {
    debug({ step: "caches.cleaned", expiredCount });
  }
}

function maybePruneAndCleanup() {
  const now = Date.now();
  if (now - lastCacheCleanupTime < 3600 * 1000) return;
  lastCacheCleanupTime = now;
  pruneMessageState();
  cleanupCaches();
}

// ── OpenCode v2 适配层 ─────────────────────────────────────────────
//
// v1 → v2 的破坏性变更（本插件适配所需的两处）：
//   1) 事件负载位置：event.properties (v1) → event.data (v2)
//   2) 事件类型全面重命名：
//        v1 message.updated            → v2 session.step.ended / session.execution.succeeded
//        v1 message.part.delta         → v2 session.text.delta
//        v1 message.part.updated       → v2 session.text.ended
//        v1 session.idle/error        → v2 session.execution.succeeded / *.failed
//
// 适配策略：把 v2 事件在入口处还原成 v1 的 { type, properties } 形状，
// 复用原有 handleGenericEvent / 落库 / 去重逻辑，零改动核心流程。
//
// 工具执行 hook：
//        v1 "tool.execute.before"(input, output) → v2 ctx.tool.hook("execute.before", event)
//        event.tool / event.sessionID / event.id(原 callID) / event.input(原 args)
//        after 事件的结果位于 event.result（output / content / metadata）

const V2_EVENT_MAP = {
  // v2 事件类型 → 还原出的 v1 事件类型
  "session.text.delta": "message.part.delta",
  "session.text.ended": "message.part.updated",
  "session.execution.succeeded": "message.updated",
};

/** sessionID → 该会话下待落库的 assistant 消息 ID 集合 */
const pendingAssistantMessages = new Map();

function trackAssistantMessage(sessionID, messageID) {
  if (!sessionID || !messageID) return;
  let set = pendingAssistantMessages.get(sessionID);
  if (!set) {
    set = new Set();
    pendingAssistantMessages.set(sessionID, set);
  }
  set.add(messageID);
}

function takePendingAssistantMessages(sessionID) {
  const set = pendingAssistantMessages.get(sessionID);
  if (!set || set.size === 0) return [];
  pendingAssistantMessages.delete(sessionID);
  return Array.from(set);
}

/**
 * CLI 方式提交的 prompt 会被 v2 存成带引号的 JSON 字符串（如 "echo hi"），
 * 落库前剥掉这层包裹，避免记忆内容带上多余引号。
 */
function normalizePromptText(text) {
  if (typeof text !== "string") return text;
  const trimmed = text.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return text;
  const inner = trimmed.slice(1, -1);
  if (!inner.includes('"')) return inner;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
  } catch (_) {
    // 不是合法 JSON 字符串就保持原样
  }
  return text;
}

export async function setup(ctx) {
  const controller = new AbortController();

  // 只有真正承载会话的服务端进程负责落库。
  // CLI / TUI 进程同样会加载插件并订阅同一批事件，若两端都写，
  // 同一个 opencode 会话会在记忆系统里生成两份重复的 session 与消息。
  const argv = process.argv.slice(2);
  const isServerProcess =
    argv.includes("serve") ||
    argv.some((arg) => arg.startsWith("serve=")) ||
    argv.includes("--standalone");
  if (!isServerProcess) {
    debug({ step: "setup.skip_non_server", argv: argv.slice(0, 4) });
    return;
  }
  debug({ step: "setup.server_mode", argv: argv.slice(0, 4) });

  /** 把还原出的 v1 事件交给原有处理链路 */
  const emit = async (type, properties) => {
    try {
      await drainFailedQueue();
      maybePruneAndCleanup();
      await handleGenericEvent({ type, properties });
    } catch (err) {
      debug({
        step: "event.probe.error",
        error: String(err),
        stack: err?.stack || null,
        errorCategory: classifyRequestError(err),
      });
      console.error("[session-memory-auto] event probe failed", err);
    }
  };

  /** assistant 消息收尾：还原 v1 的 message.updated(info) 以触发落库 */
  const flushAssistantMessages = async (sessionID) => {
    for (const messageID of takePendingAssistantMessages(sessionID)) {
      await emit("message.updated", {
        info: {
          id: messageID,
          sessionID,
          role: "assistant",
          time: { completed: Date.now() },
        },
      });
    }
  };

  // ── 事件流 ──────────────────────────────────────────────────────
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const type = event?.type;
        const data = event?.data ?? {};
        const sessionID = data.sessionID;

        switch (type) {
          case "session.created":
            await emit("session.created", { sessionID });
            break;

          case "session.text.started":
            trackAssistantMessage(sessionID, data.assistantMessageID);
            break;

          case "session.text.delta":
            trackAssistantMessage(sessionID, data.assistantMessageID);
            await emit("message.part.delta", {
              sessionID,
              messageID: data.assistantMessageID,
              partID: `text-${data.ordinal}`,
              field: "text",
              delta: data.delta,
            });
            break;

          case "session.text.ended":
            trackAssistantMessage(sessionID, data.assistantMessageID);
            // 完整文本覆盖增量累加的结果，保证落库内容与最终输出一致
            await emit("message.part.updated", {
              part: {
                id: `text-${data.ordinal}`,
                messageID: data.assistantMessageID,
                sessionID,
                type: "text",
                text: data.text,
              },
            });
            break;

          case "session.execution.succeeded":
            await flushAssistantMessages(sessionID);
            break;

          default:
            // 会话失败类事件：v2 未公开稳定的 session.error，改为按名字匹配
            if (typeof type === "string" && /failed|error/i.test(type) && sessionID) {
              await emit("session.error", {
                sessionID,
                error: data.error ?? data,
              });
              await flushAssistantMessages(sessionID);
            }
            break;
        }
      }
    } catch (err) {
      debug({ step: "event.subscribe.error", error: String(err), stack: err?.stack || null });
      console.error("[session-memory-auto] event subscription failed", err);
    }
  })();

  // ── 用户消息：v2 的 prompt hook 是用户文本的唯一可靠来源 ──────────
  try {
    await ctx.session.hook("prompt", async (event) => {
      const text = normalizePromptText(event?.prompt?.text);
      const sessionID = event?.sessionID;
      if (typeof text !== "string" || !text.trim() || !sessionID) return;

      const messageID = event.messageID || `user-${Date.now()}`;
      try {
        await emit("message.part.updated", {
          part: { id: messageID, messageID, sessionID, type: "text", text },
        });
        await emit("message.updated", {
          info: {
            id: messageID,
            sessionID,
            role: "user",
            time: { created: Date.now() },
          },
        });
      } catch (err) {
        debug({ step: "prompt.persist.error", sessionID, messageID, error: String(err) });
      }
    });
  } catch (err) {
    debug({ step: "prompt.hook.error", error: String(err) });
  }

  // ── 工具执行审计 ────────────────────────────────────────────────
  await ctx.tool.hook("execute.before", async (event) => {
    try {
      await drainFailedQueue();
      const input = {
        tool: event.tool,
        sessionID: event.sessionID,
        callID: event.id,
        args: event.input ?? null,
      };
      const output = { args: event.input ?? null };
      debug({ step: "tool.before.event", input: summarizeValue(input), output: summarizeValue(output) });
      const smSessionID = await ensureSession(input.sessionID);
      await writeSystemMessage(smSessionID, `[tool:start] ${input.tool}`, {
        event: "tool.execute.before",
        opencode_session_id: input.sessionID,
        tool: input.tool,
        call_id: input.callID,
        args: output.args,
      });
    } catch (err) {
      debug({
        step: "tool.before.error",
        error: String(err),
        stack: err?.stack || null,
        errorCategory: classifyRequestError(err),
      });
      console.error("[session-memory-auto] tool.execute.before failed", err);
    }
  });

  await ctx.tool.hook("execute.after", async (event) => {
    try {
      await drainFailedQueue();
      const result = event.result ?? {};
      const input = {
        tool: event.tool,
        sessionID: event.sessionID,
        callID: event.id,
        args: event.input ?? null,
      };
      const output = {
        title: result.content?.[0]?.text ?? null,
        output: typeof result.output?.output === "string" ? result.output.output : null,
        metadata: result.metadata ?? null,
      };
      debug({ step: "tool.after.event", input: summarizeValue(input), output: summarizeValue(output) });
      const smSessionID = await ensureSession(input.sessionID);
      await writeSystemMessage(smSessionID, `[tool:end] ${input.tool}`, {
        event: "tool.execute.after",
        opencode_session_id: input.sessionID,
        tool: input.tool,
        call_id: input.callID,
        args: input.args,
        title: output.title,
        output_preview: typeof output.output === "string" ? output.output.slice(0, 500) : null,
        metadata: output.metadata,
      });
    } catch (err) {
      debug({
        step: "tool.after.error",
        error: String(err),
        stack: err?.stack || null,
        errorCategory: classifyRequestError(err),
      });
      console.error("[session-memory-auto] tool.execute.after failed", err);
    }
  });

  return () => controller.abort();
}

export default { id, setup };
