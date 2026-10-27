import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const id = 'session-memory-auto-probe';

function logFile() {
  const dir = path.join(os.homedir(), '.cache', 'session-memory');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'plugin-probe.log');
}

function append(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(logFile(), line, 'utf8');
}

function summarizeEvent(event) {
  if (!event || typeof event !== 'object') return { rawType: typeof event };
  // v2 事件负载位于 event.data（v1 为 event.properties）
  const p = event.data || event.properties || {};
  const out = { type: event.type };
  if (p.sessionID) out.sessionID = p.sessionID;
  if (p.messageID) out.messageID = p.messageID;
  if (p.assistantMessageID) out.messageID = p.assistantMessageID;
  if (p.callID) out.callID = p.callID;
  if (p.id) out.callID = p.id;
  if (p.tool) out.tool = p.tool;
  if (p.info?.id) out.infoID = p.info.id;
  if (p.info?.role) out.role = p.info.role;
  if (p.info?.parts) out.parts = p.info.parts.map((x) => x.type);
  if (p.info?.sessionID) out.infoSessionID = p.info.sessionID;
  return out;
}

/**
 * OpenCode v2 插件入口。
 * v1 → v2：
 *   event hook                  → ctx.event.subscribe()
 *   tool.execute.before/after   → ctx.tool.hook("execute.before"/"execute.after")
 * 工具 hook 事件字段：event.tool / event.sessionID / event.id(原 callID) / event.input(原 args)，
 * after 事件的结果位于 event.result。
 */
export async function setup(ctx) {
  const interesting = new Set([
    'session.created',
    'message.updated',
    'message.part.updated',
    'session.error',
    'session.text.ended',
    'session.tool.success',
  ]);

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (!interesting.has(event?.type)) continue;
        append({ source: 'event', ...summarizeEvent(event) });
      }
    } catch (err) {
      append({ source: 'event.error', error: String(err) });
    }
  })();

  await ctx.tool.hook('execute.before', (event) => {
    append({
      source: 'tool.execute.before',
      tool: event.tool,
      sessionID: event.sessionID,
      callID: event.id,
      args: event.input ?? null,
    });
  });

  await ctx.tool.hook('execute.after', (event) => {
    const result = event.result ?? {};
    const text = typeof result.output?.output === 'string'
      ? result.output.output
      : (result.content?.[0]?.text ?? null);
    append({
      source: 'tool.execute.after',
      tool: event.tool,
      sessionID: event.sessionID,
      callID: event.id,
      title: result.content?.[0]?.text ?? null,
      outputPreview: typeof text === 'string' ? text.slice(0, 200) : null,
    });
  });

  return () => controller.abort();
}

export default { id, setup };
