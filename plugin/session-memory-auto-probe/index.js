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
  const out = { type: event.type };
  const p = event.properties || {};
  if (p.sessionID) out.sessionID = p.sessionID;
  if (p.messageID) out.messageID = p.messageID;
  if (p.callID) out.callID = p.callID;
  if (p.tool) out.tool = p.tool;
  if (p.info?.id) out.infoID = p.info.id;
  if (p.info?.role) out.role = p.info.role;
  if (p.info?.parts) out.parts = p.info.parts.map((x) => x.type);
  if (p.info?.sessionID) out.infoSessionID = p.info.sessionID;
  return out;
}

export async function server() {
  return {
    event: async (input) => {
      const type = input?.type;
      const interesting = new Set([
        'session.created',
        'message.updated',
        'message.part.updated',
        'session.error',
      ]);
      if (!interesting.has(type)) return;
      append({ source: 'event', ...summarizeEvent(input) });
    },
    'tool.execute.before': async (input, output) => {
      append({ source: 'tool.execute.before', tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: output.args ?? null });
    },
    'tool.execute.after': async (input, output) => {
      append({ source: 'tool.execute.after', tool: input.tool, sessionID: input.sessionID, callID: input.callID, title: output.title, outputPreview: typeof output.output === 'string' ? output.output.slice(0, 200) : null });
    },
  };
}

export default { id, server };
