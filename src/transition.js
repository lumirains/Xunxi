// 跨轮思考注入（P16 · 2026-11-20）——只读派生模块。
//
// 目的：她每一轮都是全新的 API 调用；上一条已结束会话的【深度思考】如果能带进下一轮，
// 思考会接得上（不是复读，而是“刚才想到哪儿了”）。旧 cross-turn 插件（Q15 已禁用、
// 已归档）把“草稿/刚发过”追加到 system 末尾；本模块是它的重写版，刻意不同：
//   · 数据源 = 上一条已结束 session 的 assistant content（前缀【深度思考】）；
//     orchestrator 已把 response.reasoning 写进 session.messages，无需另存一份；
//   · 落点 = user prompt 尾部易变区（orchestrator → buildUserPrompt 的 transitionText），
//     绝不进 system，避免每轮改变 system 字节、废掉前缀缓存；
//   · 只读：不写任何状态，不建表，不碰 kv 'transition' 旧数据；
//   · 任何异常/无数据/过期都返回空串，绝不阻断对话。
//
// 边界：TTL 与长度由 config.transition 控制；中文思考只能提示词级尽力而为
// （厂商是否遵守 reasoning 语言不在本项目控制面内）。

import { getConfig } from './config.js';

const THINK_PREFIX = '【深度思考】';
const DEFAULT_TTL_MIN = 90;
const DEFAULT_MAX_CHARS = 500;
const MIN_TTL_MIN = 5;
const MAX_TTL_MIN = 1440;
const MIN_MAX_CHARS = 120;
const MAX_MAX_CHARS = 2000;

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

/**
 * 从 session 索引里挑“上一条已结束会话”。
 * 纯函数（index 数组注入），供测试直接驱动。
 *
 * 条件：同一 chatKey、非当前 session、非 running/waiting、结束时间在 TTL 内。
 * 索引已按 startedAt 降序；这里再按 endedAt||startedAt 排一次，保证取真正最近的一条。
 *
 * @param {{index?: Array<object>, chatKey?: string, currentSessionId?: string, now?: number, ttlMin?: number}} p
 * @returns {object|null}
 */
export function pickLastSession({
  index = [],
  chatKey = 'main',
  currentSessionId = '',
  now = Date.now(),
  ttlMin = DEFAULT_TTL_MIN
} = {}) {
  const ttl = clampInt(ttlMin, MIN_TTL_MIN, MAX_TTL_MIN, DEFAULT_TTL_MIN);
  const ttlMs = ttl * 60000;
  const key = String(chatKey ?? 'main');
  const cur = String(currentSessionId ?? '');
  const tsOf = (s) => Number(s?.endedAt) || Number(s?.startedAt) || 0;
  const candidates = (Array.isArray(index) ? index : [])
    .filter((s) => s && String(s.id ?? '') !== cur)
    .filter((s) => String(s.chatKey ?? 'main') === key)
    .filter((s) => !['running', 'waiting'].includes(String(s.status ?? '')))
    .filter((s) => {
      const ts = tsOf(s);
      return ts > 0 && now >= ts && now - ts <= ttlMs;
    })
    .sort((a, b) => tsOf(b) - tsOf(a));
  return candidates[0] ?? null;
}

/**
 * 从一条 session 的 messages 里取【深度思考】正文。
 * 取“最长的一段”（多轮工具调用会有多段思考；最长的那段通常承载完整推理）。
 * 超长按 maxChars 截断并标注后略。
 *
 * @param {object} session
 * @param {number} maxChars
 * @returns {string}
 */
export function extractThinking(session, maxChars = DEFAULT_MAX_CHARS) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  let best = '';
  for (const m of messages) {
    if (m?.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content : '';
    if (!text.startsWith(THINK_PREFIX)) continue;
    const body = text.slice(THINK_PREFIX.length).trim();
    if (body.length > best.length) best = body;
  }
  if (!best) return '';
  const limit = clampInt(maxChars, MIN_MAX_CHARS, MAX_MAX_CHARS, DEFAULT_MAX_CHARS);
  if (best.length <= limit) return best;
  return `${best.slice(0, limit).trim()}\n…（后略）`;
}

/**
 * 渲染注入段。返回 '' = 不注入（关闭/无上一轮/过期/无思考/异常）。
 *
 * @param {{sessions?: {index?: Array<object>, get?: Function}, chatKey?: string,
 *          currentSessionId?: string, now?: number}} p
 * @returns {string}
 */
export function buildTransitionSection({
  sessions = null,
  chatKey = 'main',
  currentSessionId = '',
  now = Date.now()
} = {}) {
  try {
    const cfg = getConfig()?.transition || {};
    if (cfg.enabled === false) return '';
    const last = pickLastSession({
      index: sessions?.index,
      chatKey,
      currentSessionId,
      now,
      ttlMin: cfg.ttlMin
    });
    if (!last?.id || typeof sessions?.get !== 'function') return '';
    const session = sessions.get(last.id);
    const excerpt = extractThinking(session, cfg.maxChars);
    if (!excerpt) return '';
    return [
      '【上一轮你想到一半的地方】',
      excerpt,
      '（这是你上一次醒来时的想法，不是已经说出口的话。接着这个思路；已经想通了就按新的来，不要向对方复述这段。用中文想。）'
    ].join('\n');
  } catch {
    return '';
  }
}
