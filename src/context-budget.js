// 上下文预算（Q15 收编进皮层）。
//
// 三件事，全部是“只减不加”的纯变换：
//   ① trimHistory       历史消息滑窗：保留最近 N 条，更早的可删消息压成一行摘要；
//   ② trimToolDescriptions 工具描述瘦身：只清空白/空行，不删工具、不改语义；
//   ③ trimToolResult    工具结果截断：只截文本，parts 数组（图片/视频）不碰。
//
// 纪律（与插件时代一致）：
//   · system / 最后一条 / tool 角色 / 带 tool_calls 的 assistant 永不删；
//   · 任何异常由调用方 try/catch 吞掉，省 token 失败绝不能影响对话；
//   · 不改变请求结构，不新增字段，不做生成式摘要（摘要只截取原文）。
//
// 为什么放独立模块而不是塞进 llm.js/orchestrator：
//   三个函数都是纯逻辑，独立模块可单测、可被两个调用点共享；llm.js 只管
//   “请求体长什么样”，orchestrator 只管“什么时候调”，边界清楚。
import { getConfig } from './config.js';

export const DEFAULTS = Object.freeze({
  enabled: true,
  historyMode: 'window',        // off | window | aggressive
  keepRecentMessages: 14,
  maxDigestChars: 600,
  trimToolDescriptions: true,
  maxToolResultChars: 4000,
  verbose: false
});

/** 当前配置（config.contextBudget；缺省/异常回落 DEFAULTS）。 */
export function getBudgetConfig() {
  try {
    const raw = getConfig()?.contextBudget || {};
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
};

/** 取一条消息的可读文本（只读；content 可能是 string 或 parts 数组）。 */
function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text).join('\n');
  }
  return '';
}

/**
 * 是否可安全删除。OpenAI 兼容端点要求 assistant 的 tool_calls 后必须紧跟
 * 对应 tool 消息；删一半会 400。这里保守到“宁可少省”：
 * system / 末条 / tool / 带 tool_calls 的 assistant 都不删。
 */
function isDeletable(msg, index, total) {
  if (!msg || typeof msg !== 'object') return false;
  if (index >= total - 1) return false;
  const role = msg.role;
  if (role === 'system') return false;
  if (role === 'tool') return false;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return false;
  return role === 'user' || role === 'assistant';
}

/**
 * 历史裁剪（原地修改 messages）。保留最近 keep 条，更早的可删消息压成一行摘要；
 * 摘要省不下字符时退化为“只删不摘要”；仍省不下就什么都不做。
 */
export function trimHistory(messages, conf = getBudgetConfig()) {
  if (!conf?.enabled) return;
  const mode = String(conf.historyMode || 'window');
  if (mode === 'off') return;
  if (!Array.isArray(messages) || messages.length <= 2) return;

  const keep = clampInt(conf.keepRecentMessages, 4, 60, DEFAULTS.keepRecentMessages);
  if (messages.length <= keep + 2) return;

  const cutIndex = messages.length - keep;
  const head = messages.slice(0, cutIndex);
  const deletable = [];
  const mustKeep = [];
  head.forEach((m, i) => {
    if (isDeletable(m, i, messages.length)) deletable.push(i);
    else mustKeep.push(m);
  });
  if (!deletable.length) return;

  const beforeChars = head.reduce((n, m) => n + textOf(m).length, 0);
  const budget = clampInt(conf.maxDigestChars, 100, 4000, DEFAULTS.maxDigestChars);
  let digest = '';
  if (mode === 'aggressive') {
    digest = `【较早对话已压缩】省略了 ${deletable.length} 条更早的消息。`;
  } else {
    const perLine = Math.max(20, Math.floor(budget / Math.max(1, deletable.length)));
    const lines = [];
    for (const i of deletable) {
      const m = head[i];
      const t = textOf(m).replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const who = m.role === 'assistant' ? '机器人' : '对方';
      lines.push(`${who}: ${t.length > perLine ? `${t.slice(0, perLine)}…` : t}`);
    }
    digest = lines.length
      ? `【较早对话摘要】${lines.join(' / ')}`
      : `【较早对话已压缩】省略了 ${deletable.length} 条更早的消息。`;
  }
  if (digest.length > budget) digest = `${digest.slice(0, budget)}…`;

  const rebuilt = [...mustKeep, { role: 'user', content: digest }, ...messages.slice(cutIndex)];
  const afterChars = rebuilt.reduce((n, m) => n + textOf(m).length, 0);
  if (afterChars < beforeChars) {
    messages.length = 0;
    messages.push(...rebuilt);
    return;
  }

  // 摘要本身占字符：省不下来就只删不摘要（至少减少条数）。
  const fallback = [...mustKeep, ...messages.slice(cutIndex)];
  const fbBefore = messages.reduce((n, m) => n + textOf(m).length, 0);
  const fbAfter = fallback.reduce((n, m) => n + textOf(m).length, 0);
  if (fbAfter < fbBefore) {
    messages.length = 0;
    messages.push(...fallback);
  }
}

/**
 * 工具描述瘦身（原地修改 body.tools）。只清空白/空行/空列表项；
 * 不删工具、不改写语义。没有 tools 或未开启时是空操作。
 */
export function trimToolDescriptions(body, conf = getBudgetConfig()) {
  if (!conf?.enabled || !conf?.trimToolDescriptions) return;
  const tools = body?.tools;
  if (!Array.isArray(tools) || !tools.length) return;
  for (const t of tools) {
    const fn = t?.function;
    if (!fn || typeof fn.description !== 'string') continue;
    const before = fn.description;
    const after = before
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .replace(/^\s*[-*]\s*$/gm, '')
      .trim();
    if (after && after.length < before.length) fn.description = after;
  }
}

/**
 * 工具结果截断（原地修改 result.content）。只截文本；parts 数组不碰。
 * 截断处写明省略了多少字符，让模型知道信息不完整。
 */
export function trimToolResult(result, conf = getBudgetConfig()) {
  if (!conf?.enabled) return;
  if (!result || typeof result !== 'object') return;
  if (Array.isArray(result.content)) return;
  if (typeof result.content !== 'string') return;
  const limit = clampInt(conf.maxToolResultChars, 500, 40000, DEFAULTS.maxToolResultChars);
  if (result.content.length <= limit) return;
  const omitted = result.content.length - limit;
  result.content = `${result.content.slice(0, limit)}\n…（结果过长，已省略 ${omitted} 字符）`;
}
