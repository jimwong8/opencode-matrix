import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const id = "session-memory-auto";

const BASE_URL = process.env.SESSION_MEMORY_URL || "http://10.100.1.17:8000";
const USER_ID = process.env.SESSION_MEMORY_USER_ID || "jimwong";
const HOSTNAME = os.hostname();
const STATE_DIR = path.join(os.homedir(), ".cache", "session-memory");
const STATE_FILE = path.join(STATE_DIR, "plugin-auto-sessions.json");
const MESSAGE_STATE_FILE = path.join(STATE_DIR, "plugin-auto-message-state.json");
const DEBUG_LOG = path.join(STATE_DIR, "plugin-auto-debug.log");
const PROBE_EVENT_TYPES = new Set([
  "session.created",
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "session.error",
]);
const MESSAGE_FLUSH_DELAY_MS = 250;

const messagePartsCache = new Map();
const messageFlushTimers = new Map();
const persistedMessageState = loadMessageState();

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function debug(entry) {
  ensureStateDir();
  fs.appendFileSync(
    DEBUG_LOG,
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    "utf8",
  );
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

function saveJSON(filePath, value) {
  ensureStateDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
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

function shouldFlushMessage(info) {
  if (!info?.id || !info?.sessionID) return false;
  if (info.role === "user") return true;
  if (info.role !== "assistant") return false;
  return Boolean(info.time?.completed || info.error || info.finish);
}

function scheduleMessageFlush(info) {
  if (!info?.id) return;
  const existingTimer = messageFlushTimers.get(info.id);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    messageFlushTimers.delete(info.id);
    persistMessageFromCache(info).catch((err) => {
      debug({ step: "message.persist.error", messageID: info.id, error: String(err), stack: err?.stack || null });
      console.error("[session-memory-auto] message persist failed", err);
    });
  }, MESSAGE_FLUSH_DELAY_MS);
  messageFlushTimers.set(info.id, timer);
}

async function getJSON(url) {
  debug({ step: "getJSON.request", url });
  const res = await fetch(url);
  const text = await res.text();
  debug({ step: "getJSON.response", url, status: res.status, bodyPreview: text.slice(0, 300) });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

async function postJSON(url, body) {
  debug({ step: "postJSON.request", url, body: summarizeValue(body) });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  debug({ step: "postJSON.response", url, status: res.status, bodyPreview: text.slice(0, 300) });
  if (!res.ok) throw new Error(`POST ${url} failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

async function ensureSession(opencodeSessionID) {
  debug({ step: "ensureSession.start", opencodeSessionID });
  const map = loadMap();
  if (map[opencodeSessionID]) {
    debug({ step: "ensureSession.cached", opencodeSessionID, sessionMemoryID: map[opencodeSessionID] });
    return map[opencodeSessionID];
  }

  const sessions = await getJSON(`${BASE_URL}/api/v1/sessions?user_id=${encodeURIComponent(USER_ID)}&limit=100`);
  const found = Array.isArray(sessions)
    ? sessions.find((s) => (s.metadata_json || {}).opencode_session_id === opencodeSessionID)
    : null;

  if (found?.id) {
    map[opencodeSessionID] = found.id;
    saveMap(map);
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

  map[opencodeSessionID] = created.id;
  saveMap(map);
  debug({ step: "ensureSession.created", opencodeSessionID, sessionMemoryID: created.id });
  return created.id;
}

async function writeMessage(sessionID, role, content, metadata = {}) {
  debug({ step: "writeMessage.start", sessionID, role, contentPreview: content.slice(0, 200), metadata: summarizeValue(metadata) });
  const result = await postJSON(`${BASE_URL}/api/v1/sessions/${sessionID}/messages`, {
    role,
    content,
    metadata_json: {
      source: "session-memory-auto",
      host: HOSTNAME,
      ...metadata,
    },
  });
  debug({ step: "writeMessage.done", sessionID, messageID: result?.id || null, role });
  return result;
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
    debug({ step: "message.persist.skip.empty", sessionID, messageID, role });
    return;
  }

  const contentHash = hashMessage(role, content);
  const stateKey = messageStateKey(sessionID, messageID);
  if (persistedMessageState[stateKey]?.contentHash === contentHash) {
    debug({ step: "message.persist.skip.duplicate", sessionID, messageID, role, contentHash });
    return;
  }

  const smSessionID = await ensureSession(sessionID);
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

  persistedMessageState[stateKey] = {
    contentHash,
    role,
    updatedAt: new Date().toISOString(),
  };
  saveMessageState();
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
      debug({ step: "session.prewarm.done", sessionID: properties.sessionID });
    } catch (err) {
      debug({ step: "session.prewarm.error", sessionID: properties.sessionID, error: String(err), stack: err?.stack || null });
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
    if (shouldFlushMessage(info)) {
      scheduleMessageFlush(info);
    } else {
      debug({ step: "message.flush.skip.not-ready", sessionID: info.sessionID, messageID: info.id, role: info.role });
    }
  }
}

export async function server() {
  return {
    event: async ({ event }) => {
      try {
        await handleGenericEvent(event);
      } catch (err) {
        debug({ step: "event.probe.error", error: String(err), stack: err?.stack || null });
        console.error("[session-memory-auto] event probe failed", err);
      }
    },
    "tool.execute.before": async (input, output) => {
      try {
        debug({ step: "tool.before.event", input: summarizeValue(input), output: summarizeValue(output) });
        const smSessionID = await ensureSession(input.sessionID);
        await writeSystemMessage(
          smSessionID,
          `[tool:start] ${input.tool}`,
          {
            event: "tool.execute.before",
            opencode_session_id: input.sessionID,
            tool: input.tool,
            call_id: input.callID,
            args: output.args ?? null,
          },
        );
      } catch (err) {
        debug({ step: "tool.before.error", error: String(err), stack: err?.stack || null });
        console.error("[session-memory-auto] tool.execute.before failed", err);
      }
    },
    "tool.execute.after": async (input, output) => {
      try {
        debug({ step: "tool.after.event", input: summarizeValue(input), output: summarizeValue(output) });
        const smSessionID = await ensureSession(input.sessionID);
        await writeSystemMessage(
          smSessionID,
          `[tool:end] ${input.tool}`,
          {
            event: "tool.execute.after",
            opencode_session_id: input.sessionID,
            tool: input.tool,
            call_id: input.callID,
            args: input.args ?? null,
            title: output.title,
            output_preview: typeof output.output === "string" ? output.output.slice(0, 500) : null,
            metadata: output.metadata ?? null,
          },
        );
      } catch (err) {
        debug({ step: "tool.after.error", error: String(err), stack: err?.stack || null });
        console.error("[session-memory-auto] tool.execute.after failed", err);
      }
    },
  };
}

export default { id, server };
