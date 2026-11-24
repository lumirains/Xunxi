// 通话回想（V3 · T6，night-plan §2-T6 / call-mode 稿 §8 / design §12 文件表：
// "回想 | src/voice/recall.js（新） | 挂断生成 + appendSelf + 可选 staging | V3"）。
//
// ── 纪律（D15/§8 原文口径，本文是 2026-11-19 起的**唯一存档写入点**）────────────
//   · 本文件持有 store 写面：store.appendSelf 恰一次（前缀契约行，design §8.2）；
//     call.js 不再触 store 写面（store.recent 摘要只读保留）——tools/voice-call-test.mjs
//     import 图断言锁这个分工。
//   · callId 幂等（§8.3"重放不重复落"）：工厂级 Set<callId>，重复 kick 静默忽略。
//   · 挂断后**异步**生成（§8.3 时机行）：call.js 先回 ended 帧/断链，再 fire-and-forget
//     调 kick()——生成耗时绝不阻塞挂断响应；LLM 失败回落模板行，通话记录本身不丢。
//   · staging 单一写者纪律（§8.4）：追加走 person/memory.js 的 remember() API，
//     本文件**不直写 staging 表/文件**；条件=通话 ≥ config.voice.call.recallMinSeconds
//     （缺省 120s）**或**情绪显著（2026-11-21 起=文字口径：通话首尾心绪文本或挂心事
//     集合变化；原 mind 数值轴 |Δ|>0.3 随数值丢弃一并退役）。
//   · 逐句对话仍不落档（D15）：逐句记录只活在 call.js 内存 history，本文件只读入参、
//     输出**一行**；通话音频零落盘零 media-store（E1，与 call.js 同面）。
//
// 生成参数（所有者 2026-11-18 改拍板，night-plan §0"回想"行）：按通话逐句记录生成、
// 字数放宽——输出 ≤200 字 / maxTokens 800（T8 真模型实证上浮，见 RECALL_MAX_TOKENS 注）
// / temperature 0.6 / 无工具无思考
//（skillContext.thinkingMode:'off'，tools 不传=无工具；与 buildCallPreamble 同款形状）。
// 输出契约（两次拍板合并成一次调用）：第一行=回想正文（代码拼 [通话 M:SS] 前缀——
// 前缀是契约（§8.2/§2-T6），由代码拼装保证恒为良形；模型正文含"通了电话"语义）；
// 另一行以「和他通了电话」开头的暂存句（条件满足时进 staging；缺省模板兜底）。
import { getConfig } from '../config.js';
import { chatCompletion } from '../llm.js';
import * as memory from '../person/memory.js';

// ── 前缀契约（design §8.2/§2-T6"两侧同源常量"的后端侧唯一定义点）────────────────
// 前端同值字面 = frontend/src/lib/types.ts 的 RECALL_LINE_RE（两侧字面一致性由
// tools/voice-call-test.mjs 的同源断言锁；改一处必改两处）。
export const RECALL_PREFIX_RE = /^\[通话 (\d+:\d{2})\]\s/;

// ── 常量（design §8.3/§8.4 与所有者拍板定值，不进 config）──────────────────────
// 输出预算（所有者改拍板：原 180 → 350，字数放宽到 ≤200 字）。T8 真模型实证（2026-11-19
// 中控 deepseek-v4.1-flash）上浮到 800：该模型是思考型——当时 thinking.js 把本地网关判成
// ollama/local-openai（supports:[]）不发关思考参数，思考 token 吃满 350（finish=length、
// 正文从未到达 → content=截断思考被 parseRecallOutput 当正文落档）。
// **2026-11-19 已修**：方言识别改为本地端点"模型名优先"，deepseek 方言正确下发
// thinking:{type:'disabled'}，实测 reasoning_tokens=0。800 现在只是安全上限（正文 ≤200 字
// 远用不到），不再承担"给思考让路"的职责；parseRecallOutput 另加了复述护栏。
const RECALL_MAX_TOKENS = 800;
const RECALL_TEMPERATURE = 0.6;       // §8.3 原值
const RECALL_BODY_MAX = 200;          // 回想正文硬上限（改拍板：原 40-120 字 → ≤200 字）
const STAGING_LINE_MAX = 60;          // staging 一句上限（§8.4 样张 20 余字，60 兜截断）
const RECALL_MIN_SECONDS_DEFAULT = 120; // config.voice.call.recallMinSeconds 缺省（§8.4）
const TRANSCRIPT_MAX_LINES = 60;      // 回想输入的逐句条数上限（HISTORY_CAP=400 的防无界截）
const TRANSCRIPT_LINE_MAX = 120;      // 每句截断（与 buildVoicePrompt 段 6 同口径）

const RECALL_INSTRUCTION = [
  '你在整理自己的一通电话回忆。根据这通电话的记录，输出两行，除此之外不要输出任何别的内容：',
  '第一行：回想正文，不超过 200 字。用你的第一人称口吻（"我"），必须体现"和他通了个电话"',
  '这层意思；概括这通电话聊了什么、气氛如何，不要逐句复述，带一点当时的心情；',
  '不要列表、不要引号、不要 Markdown、不要动作描写。',
  '第二行：以「和他通了电话」开头，按「和他通了电话，聊到 <主题>，他当时 <心情>」的格式',
  '写一句不超过 40 字的记忆暂存。',
  // T8 真模型加固（deepseek-v4.1-flash temp 0.6 实测会复述任务当输出——见 RECALL_MAX_TOKENS 注）：
  '直接输出这两行结果，不要复述或改述任务要求，不要输出任何思考、分析或说明过程。'
].join('\n');

function clip(s, max) {
  const t = String(s ?? '').trim();
  return t.length <= max ? t : t.slice(0, max);
}

/** 通话时长 → M:SS（与 call.js 旧挂断计算逐字节同式：分不补零、秒补两位）。 */
export function fmtCallDuration(durMs) {
  const ms = Math.max(0, Number(durMs) || 0);
  const mm = Math.floor(ms / 60000);
  const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 失败回落模板正文（§8.3；前缀由唯一写点统一拼装）。 */
export function fallbackRecallBody(turns) {
  return `刚才和他通了个电话，聊了 ${turns} 句。`;
}

/** 情绪显著（§8.4"心绪变化 > 阈值"；2026-11-21 数值轴丢弃后改**文字口径**）：
 *  通话首尾快照的心绪文本变化，或挂心事集合变化（新挂/放下任一）→ 显著。
 *  任一侧缺快照 → false（不做无依据的判定，§2.3 away 同精神）。 */
export function emotionSignificant(mindStart, mindEnd) {
  if (!mindStart || !mindEnd) return false;
  if (String(mindStart?.mood?.text ?? '').trim() !== String(mindEnd?.mood?.text ?? '').trim()) return true;
  const key = (m) => (Array.isArray(m?.preoccupations) ? m.preoccupations : [])
    .map((p) => String(p?.id ?? p?.text ?? '')).sort().join('|');
  return key(mindStart) !== key(mindEnd);
}

/** 回想输入的心绪快照行（一段散文；缺项省略——renderVoiceState 同款派生口径；
 *  关系段已随 2026-11-21 relationship 丢弃一并移除）。 */
function snapshotLine(mindEnd) {
  const segs = [];
  const moodText = String(mindEnd?.mood?.text ?? '').trim();
  if (moodText) segs.push(`你当时的心绪：${moodText}`);
  const topics = (Array.isArray(mindEnd?.preoccupations) ? mindEnd.preoccupations : [])
    .map((p) => String(p?.text ?? '').trim()).filter(Boolean).slice(0, 3);
  if (topics.length) segs.push(`你正惦记的事：${topics.join('、')}`);
  return segs.join('；');
}

/** 解析模型输出：正文行（不以「和他通了电话」开头的第一行）+ 暂存行。
 *  模型若自行带 [通话 …] 前缀则剥掉（前缀归代码拼装）。两行全缺 → 回落模板。 */
function parseRecallOutput(raw) {
  const rows = String(raw ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const stagingLine = rows.find((r) => r.startsWith('和他通了电话')) ?? '';
  let body = rows.find((r) => !r.startsWith('和他通了电话')) ?? '';
  body = body.replace(/^\[通话\s*[^\]]*\]\s*/, '').trim();   // 防模型复刻前缀
  // 复述防护（2026-11-19）：模型偶发把任务书当正文吐出来（思考占满预算时尤其明显，
  // 真实事故：两条"我们需要回答…输出两行…不超过200字"落进了聊天记录）。命中元指令词
  // 一律判为无效 → 交调用方回落模板，宁可少一条回想，也不往时间线里塞指令文本。
  if (/(输出两行|不超过\s*\d+\s*字|任务[:：]|记忆暂存|按格式|第一人称|逐句复述|除此之外不要)/.test(body)) {
    return { body: '', stagingLine: '' };
  }
  return { body: clip(body, RECALL_BODY_MAX), stagingLine: clip(stagingLine, STAGING_LINE_MAX) };
}

/** 一次轻量调用出两行（回想正文 + staging 暂存句）；异常上抛由调用方回落模板。 */
async function generateRecall({ chatCompletionFn, history, durText, turns, mindEnd }) {
  const lines = (Array.isArray(history) ? history.slice(-TRANSCRIPT_MAX_LINES) : [])
    .map((h) => `${h?.who === 'me' ? '我' : '他'}：${clip(h?.text, TRANSCRIPT_LINE_MAX)}`)
    .filter((l) => l.length > 3);
  const snap = snapshotLine(mindEnd);
  const userContent = [
    snap ? `${snap}。` : '',
    `通话时长 ${durText}，共 ${turns} 句。逐句记录如下：`,
    lines.join('\n')
  ].filter(Boolean).join('\n');
  const completion = await chatCompletionFn({
    messages: [
      { role: 'system', content: RECALL_INSTRUCTION },
      { role: 'user', content: userContent }
    ],
    maxTokens: RECALL_MAX_TOKENS,
    temperature: RECALL_TEMPERATURE,
    skillContext: { thinkingMode: 'off' }   // 无工具无思考（§8.3；tools 不传=无工具）
  });
  return parseRecallOutput(completion?.message?.content);
}

/**
 * 通话回想运行器工厂（call.js 装配；每工厂=同一 store 的全部通话）。
 * @param {object} [opts]
 * @param {object} opts.store ChatStore 实例（**唯一存档写入点**：appendSelf 恰一处）
 * @param {function} [opts.log] 日志 fn（缺省静默）
 * @param {{chatCompletion?: function}} [opts.deps] 测试注入口（缺省走真批准口 llm.chatCompletion）
 */
export function createCallRecall({ store, log = () => {}, deps = {} } = {}) {
  if (!store) throw new Error('createCallRecall 需要 store（挂断回想的唯一存档写入点）');
  const doneCalls = new Set();   // callId 幂等（§8.3"重放不重复落"；工厂级，进程内单例等价）
  const chatCompletionFn = deps.chatCompletion
    ? (args) => deps.chatCompletion(args)
    : (args) => chatCompletion(args);

  async function persistRecall(input) {
    const { history = [], endedAt, durMs = 0, mindStart = null, mindEnd = null } = input ?? {};
    const turns = history.filter((h) => h?.who === 'user').length;
    const durText = fmtCallDuration(durMs);
    const cfgMinSec = Number(getConfig()?.voice?.call?.recallMinSeconds);
    const minMs = (Number.isFinite(cfgMinSec) && cfgMinSec > 0 ? cfgMinSec : RECALL_MIN_SECONDS_DEFAULT) * 1000;
    const shouldStage = durMs >= minMs || emotionSignificant(mindStart, mindEnd);

    // 生成（§8.3：失败回落模板；零句通话直接模板，不空烧一次 LLM）
    let body = '';
    let stagingLine = '';
    if (turns > 0) {
      try {
        const parsed = await generateRecall({ chatCompletionFn, history, durText, turns, mindEnd });
        body = parsed.body;
        stagingLine = parsed.stagingLine;
      } catch (err) {
        log(`[voice] call#${input?.callId} 回想生成失败，回落模板：`, err?.message ?? err);
      }
    }
    if (!body) body = fallbackRecallBody(turns);

    // 唯一存档写入点（design §8.2 形状：chatKey 形参被 store 归一为 'main' 单一时间线，
    // 传 'web:main' 与旧 call.js 写点字面一致）。ts=endedAt（挂断时刻，非生成时刻）。
    try {
      store.appendSelf('web:main', {
        ts: endedAt,
        text: `[通话 ${durText}] ${body}`,
        mid: null
      });
    } catch (err) {
      log(`[voice] call#${input?.callId} 挂断回想落档失败：`, err?.message ?? err);
      return;
    }

    // staging（§8.4：≥recallMinSeconds 或情绪显著）——经 person/memory API（单一写者，
    // 不直写 staging 表）；remember 只追加、失败只 warn（旁路语义），这里再兜一层 log。
    if (shouldStage) {
      const stText = stagingLine || `和他通了电话，聊了 ${turns} 句。`;
      try {
        memory.remember({ text: clip(stText, STAGING_LINE_MAX), mid: null, source: 'voice-call' });
      } catch (err) {
        log(`[voice] call#${input?.callId} staging 追加失败：`, err?.message ?? err);
      }
    }
  }

  /** 挂断入口（call.js hangup 在 ended 帧/断链之后调用）：幂等闸 → fire-and-forget。 */
  function kick(input) {
    const id = input?.callId;
    if (id == null || doneCalls.has(id)) return;   // 重放不重复落（§8.3 幂等）
    doneCalls.add(id);
    if (doneCalls.size > 4096) doneCalls.clear();   // 防长进程无界（与旧 call.js Set 同口径）
    persistRecall(input).catch((err) => log('[voice] 回想异常：', err?.message ?? err));
  }

  return { kick };
}
