export const id = "nl-resume-bridge";

const EXACT_PHRASES = [
  "继续刚才的对话",
  "继续上次会话",
  "继续上次的会话",
  "继续刚才中止的对话",
  "继续刚才中断的对话",
  "恢复刚才的对话",
  "恢复上次会话",
  "resume previous conversation",
  "continue previous conversation",
  "resume the previous conversation",
  "continue the previous conversation",
  "resume session",
  "where were we"
];

const ZH_ACTION_RE = /(继续|恢复|接着|回到)/;
const ZH_CONTEXT_RE = /(对话|会话|聊天|刚才|上次|上一轮|之前|中止|中断)/;
const EN_ACTION_RE = /\b(continue|resume|recover|pick up|pick up where we left off|where were we)\b/;
const EN_CONTEXT_RE = /\b(conversation|session|chat|previous|last|interrupted|where we left off)\b/;
const ZH_TASK_RE = /(代码|函数|接口|实现|修复|测试|报错|问题|方案|文档|脚本|文件|模块|逻辑|需求)/;
const EN_TASK_RE = /\b(code|function|interface|implement|implementation|fix|test|bug|error|issue|plan|docs|document|script|file|module|logic|feature|api)\b/;

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[。！？!?,，.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldRewrite(text) {
  const normalized = normalize(text);
  if (!normalized) return false;
  if (normalized.startsWith("/")) return false;

  if (EXACT_PHRASES.some((phrase) => normalized === normalize(phrase))) {
    return true;
  }

  const hasZhIntent = ZH_ACTION_RE.test(normalized) && ZH_CONTEXT_RE.test(normalized);
  const hasEnIntent = EN_ACTION_RE.test(normalized) && EN_CONTEXT_RE.test(normalized);
  const hasTaskContext = ZH_TASK_RE.test(normalized) || EN_TASK_RE.test(normalized);

  if (hasTaskContext && (hasZhIntent || hasEnIntent)) {
    return false;
  }

  return hasZhIntent || hasEnIntent;
}

function collectUserText(parts) {
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ")
    .trim();
}

/**
 * OpenCode v2 插件入口。
 * v1 的 `chat.message` hook 在 v2 中对应 `ctx.session.hook("prompt", ...)`，
 * 事件对象从 (input, output) 改为单一可变事件，文本位于 `event.prompt.text`。
 */
export async function setup(ctx) {
  await ctx.session.hook("prompt", (event) => {
    const text = event?.prompt?.text;
    if (typeof text !== "string" || !text.trim()) return;
    if (!shouldRewrite(text)) return;

    event.prompt.text = "/continue-conversation";
  });
}

export default { id, setup };
