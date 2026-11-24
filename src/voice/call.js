// 通话运行器（V2 前半场 · 她开口说话，用户文字输入；night-plan §2-T2 / spec §2.4-§2.5）。
// 架构归属（design §7，D17）：与 orchestrator **并列**的皮层新组件——共享 LLM 口 / store /
// config，不共享状态机；D16：出站走独立 WS `/api/voice`，绕开 adapter/sender/INTENT_TYPES
//（理由：sent↔broadcast↔存档 1:1 不变式与"临时不落档的音频流"正面冲突）。
//
// ── 纪律（design §7.3 原文，五条一条不少）────────────────────────────────────
//   · 不 import surfaces/*（不碰身体）
//   · 不调用 orchestrator.submit（不入消息触发链、不唤醒 wake）
//   · 不读写 sessions（通话不是会话，不进会话列表）
//   · 只在挂断时调 store.appendSelf 一次（§8）
//   · 引擎不可达 → 整通降级纯文字（§10.2），不抛错
//   · V3（T6）注：appendSelf 的写点实体=src/voice/recall.js（design §12 文件表）——
//     本文件挂断后异步经它写、恰一次；本文件自身只保留 store.recent 摘要只读。
// ── 五条由 tools/voice-call-test.mjs 的 import 图断言自测（src/voice/ 不在
//    check-boundaries 扫描面，check-boundaries.mjs:55 SCAN_DIRS 只有 kernel/person/
//    capabilities——纪律靠这条自测，spec §4.3 门禁补强）。
//
// 形态（V2 前半场 + V3 上行闭环，night-plan §2-T2/T5；spec §0.2-7 半双工）：
//   输入面双轨——文字帧 {type:'text'}（V2）+ 上行二进制 PCM16/16k/40ms 裸帧（V3，
//   尾点判定在客户端，服务端收 {type:'utterance_end'} 信令后把缓冲攒成的 wav 交
//   voice.asr.transcribeWav（第三口字节直传形态，15s 超时内建；失败提示"没听清，
//   再说一次"不落任何条目）→ prompt 组装 → 回复 → TTS → 下行。
//   半双工状态机：listening ↔ (thinking → speaking)——listening 期收上行帧攒
//   utterance；thinking/speaking 期上行帧**服务端直接丢弃**（客户端 Worklet 发送侧
//   门控=双保险，design §6.5）；阶段变更推 {type:'state',value} 帧，前端按它开/关门控。
//   主链：LLM 非流式整段（llm.chatCompletion，无工具、thinkingMode off；spec
//   §0.2-1：llm.js 无流式口，首声 >3.5s 先砍输出长度不改流式）→ splitForSpeech 切句
//   → TTS 队列（并发 1 / 深度≤3 背压=源数组天然有界 / 单句 5s 在 synthesizeRaw 内建 /
//   整轮 20s 总闸 / 连续 2 败降级纯文字，§5.3 原文参数）→ 下行双模（W2，
//   内部文档 voice-provider-plan.md §4）：deepseek-tools 方言 = PCM 流分块推 WS（ready 后
//   发 {type:'audio-mode',value:'pcm',sampleRate} 通知帧）；gpu-local/openai 方言 =
//   整段 ogg（Opus 24k/voip，night-plan §0 2026-11-18 裁定，取代 PCM 帧重采样；客户端
//   decodeAudioData 排程，iOS ogg 兼容未实测——失败发 {type:'audio-format',value:'wav'}
//   服务端换档）。
//
// 存档（design §8，D15）：逐句对话不进 messages、不进 sessions；挂断落**一行**回想——
// V3 起由 src/voice/recall.js 异步生成（不阻塞挂断响应；按通话逐句记录生成 ≤200 字，
// maxTokens 800（T8 真模型实证上浮，见 recall.js RECALL_MAX_TOKENS 注）/temperature 0.6/
// 无工具无思考——所有者 2026-11-18 改拍板；LLM 失败回落
// 模板行；callId 幂等；≥config.voice.call.recallMinSeconds 或情绪显著 → 经 person/memory
// API 追加 staging，单一写者纪律）。通话音频零 media-store 写入（keepAudio 缺省 false）；
// history 只存内存（挂断时整份 slice 交给 recall.js 作生成输入）。
//
// 提示词（buildVoicePrompt，六段封顶 ≤3000，D14）：人设 / voiceRules / renderVoiceState
//（life/mind 派生实读；relationship 关系行已随 2026-11-21 数值丢弃移除）/ 记忆卡 top-k（embedding 开=cardIndex 向量，关=
// 词法打分，零命中省略段）/ buildCallPreamble（24h messages ≤40 条轻量 LLM 调用
// maxTokens 200，失败回落最近 3 条原句，不阻塞接通；缓存键 (dayKey, 最后一条消息 id)）
// / 通话内 8 轮原文（必须原文，§4.7——摘要丢指代，"你刚才说什么"最伤沉浸感）。
// 注：本文件实现 buildCallPreamble 而非 spec §2.1 字面的"prompt.js 本文件补"——
// prompt.js 文件头纪律（纯函数、零 src 内部 import，只 import getConfig）是 S8-③
// 已提交的契约，摘要要调 LLM 读 store，落 call.js 保持 prompt.js 离线可测（偏差登记
// handoff）。
//
// 消息组装（对 spec §2.4 注释"system + 历史 user/assistant 交替 + 本轮 user"的取舍）：
// system=buildVoicePrompt({..., history})（段 6 已含 8 轮原文原文），messages=[system,
// 本轮 user]。转录**只出现一次**——若再走 messages 转录翻倍且绕过六段预算闸，与设计
// 稿 §3.1-⑤"2.2k prompt"的首声数学冲突（偏差登记 handoff）。
import { WebSocketServer } from 'ws';
import { getConfig } from '../config.js';
import { chatCompletion, embed } from '../llm.js';
import * as memory from '../person/memory.js';
import * as mind from '../person/mind.js';
import * as life from '../person/life.js';
// person/relationship 已于 2026-11-21 整体丢弃（数值轴零消费方），快照与关系行随之摘除。
import { buildVoicePrompt } from './prompt.js';
import { splitForSpeech } from './split.js';
import { RECALL_PREFIX_RE, createCallRecall } from './recall.js';
import { getSharedEngineManager } from './engine-manager.js';

// ── 常量（design §5.3 / §4.6 / §8.2-§8.3 原文参数，不进 config——设计稿定值）──────
const TURN_BUDGET_MS = 20000;        // 整轮队列消费总闸（§5.3"整轮 20s"）
const LLM_MAX_TOKENS = 200;          // voiceRules 压到 1-3 短句，200 兜截断（spec §2.4）
const PREAMBLE_MAX_TOKENS = 200;     // 通话前摘要轻量调用（design §4.6 表）
const PREAMBLE_TEMPERATURE = 0.3;    // 同上
const PREAMBLE_HOURS = 24;           // 摘要输入窗口
const PREAMBLE_MAX_MESSAGES = 40;    // 摘要输入条数上限
const HISTORY_CAP = 400;             // 内存 history 滚动上限（防长通话无界；段 6 只取末 8 轮）
const CARD_TOP_K = 5;                // 旧事卡张数（design §4.2 段 4：3-5 张）
// 前缀契约 RECALL_PREFIX_RE（design §8.2"两侧同源常量"）自 T6 起唯一定义点=src/voice/recall.js
//（前端同值字面=frontend/src/lib/types.ts RECALL_LINE_RE；本文件 import 消费）。

// ── V3 上行（night-plan §2-T5 / design §6）：裸 PCM16/16k/40ms 会话级常量（spec §2.5
//    帧表：1280B/帧、无帧头）；min/maxUtteranceMs 读 config.voice.call（缺省 300/60000）。
const UP_PCM_RATE = 16000;            // 上行采样率
const UP_BYTES_PER_SEC = UP_PCM_RATE * 2;   // mono s16 = 32000 B/s（40ms 帧=1280B）

const PREAMBLE_INSTRUCTION =
  '把下面的近期对话压缩成一段话（不超过 150 字），供打电话前快速想起今天聊过什么：' +
  '保留事实、约定与情绪要点，不逐句复述，不用列表不用引号。';

/** 本地日键 YYYY-MM-DD（prompt.js:782 / mind.js:38 同款本地口径，既有先例各自内联）。 */
function localDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function clip(s, max) {
  const t = String(s ?? '').trim();
  return t.length <= max ? t : t.slice(0, max);
}

// ── 词法打分（记忆卡 top-k 的关闭态兜底；embedding 关闭走词法或省略段）────────────
// token = CJK 串的二元组 + 拉丁/数字词；query 与卡（gist+entry+keywords）交集计分。
function termsOf(s) {
  const t = String(s ?? '').toLowerCase();
  const out = new Set();
  for (const m of t.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length === 1) out.add(run);
    else for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  for (const m of t.matchAll(/[a-z0-9][a-z0-9'+.~-]*/g)) out.add(m[0]);
  return out;
}

/** 词法 top-k（纯函数，确定性：稳定排序，并列保持插入序）。零命中 → []（段 4 省略）。 */
function lexicalTop(cands, query, k) {
  const qt = termsOf(query);
  if (!qt.size) return [];
  return cands
    .map((c) => {
      const ct = termsOf(`${c.gist} ${c.summary} ${(c.keywords || []).join(' ')}`);
      let score = 0;
      for (const t of qt) if (ct.has(t)) score += t.length >= 2 ? 2 : 1;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.c);
}

/**
 * 通话运行器工厂。每 WS 连接 = 一通电话（callId 进程内自增）。
 * @param {object} [opts]
 * @param {object} opts.store ChatStore 实例（装配层注入；**唯一写点**=挂断 appendSelf 一次）
 * @param {function} [opts.log] 日志 fn（缺省静默）
 * @param {function} [opts.originAllowed] 来源闸（app.js originAllowed 注入——鉴权策略留装配层，
 *        本模块不 import surfaces/*）
 * @param {{chatCompletion?: function, synthesizeRaw?: function, transcribeWav?: function,
 *        asrAvailable?: function}} [opts.deps]
 *        测试注入口（缺省走真批准口：llm.chatCompletion / voice.tts.synthesizeRaw /
 *        voice.asr.transcribeWav / voice.asr.available 动态 import——import 期零网络零进程）
 */
export function createVoiceCall({ store, log = () => {}, originAllowed = null, deps = {} } = {}) {
  if (!store) throw new Error('createVoiceCall 需要 store（挂断 appendSelf 的唯一写点）');

  const wss = new WebSocketServer({ noServer: true });
  let nextCallId = 1;
  const preambleCache = new Map();   // (dayKey|最后一条消息 id) → 摘要文本（design §4.6 缓存口径）
  let voiceModPromise = null;        // capabilities/voice.js 懒加载（动态 import，import 期零网络零进程）

  const chatCompletionFn = deps.chatCompletion
    ? (args) => deps.chatCompletion(args)
    : (args) => chatCompletion(args);

  // V3 挂断回想（T6 · design §12 文件表把回想写入点归 recall.js）：store 注入给它，
  // 本文件不再触 store 写面（store.recent 摘要只读保留；import 图断言锁这个分工）。
  // callId 幂等 / appendSelf 恰一次 / 失败回落模板 / staging 经 person/memory API 全在 recall.js。
  const recall = createCallRecall({ store, log, deps: { chatCompletion: chatCompletionFn } });

  // D19 引擎装配层（T7 · design §2.4"呼叫中由装配层检查/拉起/预热"）：hello 处理里
  // ensureForCall()——探测/auto 拉起/健康探针/TTS 预热，全在客户端"准备声音"态内完成；
  // 双不可用拒接（§10.2-4），单项不可用照常接通由既有逐句/逐段降级兜住。
  // capabilities/voice.js 保持无状态（engine-manager 只做探测/拉起/登记清理）。
  // W1 起改共享单例（getSharedEngineManager）：Settings 快捷开关的 ensure 端点
  // 与呼叫装配共用同一 owned 登记表/ensurePromise 去重——并发不双拉起。
  const engineManager = getSharedEngineManager({ log });

  /** 第四批准口的流形态（通话下行字节不落档；消息路径 synthesize 与本函数熔断同源）。 */
  async function synthesizeRawFn(text, opts) {
    if (deps.synthesizeRaw) return deps.synthesizeRaw(text, opts);
    if (!voiceModPromise) voiceModPromise = import('../capabilities/voice.js');
    const { voice } = await voiceModPromise;
    return voice.tts.synthesizeRaw(text, opts);
  }

  /** 第三批准口的探测面（V3 上行：区分"识别未开启"→引导文字 与"转写失败"→重说）。 */
  async function asrAvailableFn() {
    if (deps.asrAvailable) return deps.asrAvailable();
    if (!voiceModPromise) voiceModPromise = import('../capabilities/voice.js');
    const { voice } = await voiceModPromise;
    return voice.asr.available();
  }

  /** 第三批准口的字节直传形态（V3 上行：PCM 攒段 wav → 引擎；15s 超时在口内建）。 */
  async function transcribeWavFn(wavBytes) {
    if (deps.transcribeWav) return deps.transcribeWav(wavBytes);
    if (!voiceModPromise) voiceModPromise = import('../capabilities/voice.js');
    const { voice } = await voiceModPromise;
    return voice.asr.transcribeWav(wavBytes);
  }

  // ── 通话前摘要（design §4.6；buildCallPreamble 落本文件的理由见文件头注）────────
  async function buildCallPreamble() {
    let msgs = [];
    try {
      msgs = store.recent('main', { limit: PREAMBLE_MAX_MESSAGES, includeSelf: true }) ?? [];
    } catch (err) {
      log('[voice] 摘要取消息失败：', err?.message ?? err);
      return '';
    }
    const cutoff = Date.now() - PREAMBLE_HOURS * 60 * 60 * 1000;
    const recent = msgs.filter((m) => Number(m?.ts) >= cutoff
      && !(m?.self && RECALL_PREFIX_RE.test(String(m?.text ?? ''))));
    if (!recent.length) return '';
    const cacheKey = `${localDayKey()}|${recent[recent.length - 1]?.id ?? ''}`;
    if (preambleCache.has(cacheKey)) return preambleCache.get(cacheKey);

    const lines = recent.map((m) => `${m?.self ? '我' : '他'}：${clip(m?.text, 120)}`);
    let text = '';
    try {
      const completion = await chatCompletionFn({
        messages: [
          { role: 'system', content: PREAMBLE_INSTRUCTION },
          { role: 'user', content: lines.join('\n') }
        ],
        maxTokens: PREAMBLE_MAX_TOKENS,
        temperature: PREAMBLE_TEMPERATURE,
        skillContext: { thinkingMode: 'off' }   // 无工具无思考（design §4.6 表）
      });
      text = String(completion?.message?.content ?? '').trim();
    } catch (err) {
      log('[voice] 通话前摘要生成失败，回落最近 3 条原句：', err?.message ?? err);
    }
    if (!text) {
      // 失败回落：最近 3 条消息原句拼接，不阻塞接通（design §4.6 表）
      text = recent.slice(-3).map((m) => `${m?.self ? '我' : '他'}：${clip(m?.text, 80)}`).join('\n');
    }
    if (text) {
      preambleCache.set(cacheKey, text);
      if (preambleCache.size > 8) {
        const oldest = preambleCache.keys().next().value;
        preambleCache.delete(oldest);
      }
    }
    return text;
  }

  // ── 记忆卡 top-k（design §4.2 段 4：按通话前摘要为 query 检索；embedding 关=词法）─
  async function tryEmbedTop(query, candidates) {
    if (!getConfig()?.memory?.embedding?.enabled) return null;
    try {
      const vec = await embed('query', query);
      if (!Array.isArray(vec) || !vec.length) return null;
      const { cardIndex } = await import('../capabilities/reflection/card-index.js');
      cardIndex.open();
      const res = cardIndex.search(vec);
      const ranked = (res?.gists ?? [])
        .map((g) => ({ date: String(g?.date ?? ''), gist: String(g?.gist ?? '').trim(), score: Number(g?.score) || 0 }))
        .filter((g) => g.date && g.gist)
        .sort((a, b) => b.score - a.score);
      if (!ranked.length) return null;   // 索引空（派生物可删可重建）→ 词法兜底
      const byDate = new Map(ranked.map((g) => [g.date, g.gist]));
      const hit = new Set(ranked.slice(0, CARD_TOP_K).map((g) => g.date));
      return candidates.filter((c) => hit.has(c.date));
    } catch (err) {
      log('[voice] 卡向量检索失败，词法兜底：', err?.message ?? err);
      return null;
    }
  }

  async function pickCards(query) {
    let cards = [];
    try {
      cards = memory.cards() ?? [];   // person API 真身读取（本体 = private 可见，无需过滤）
    } catch (err) {
      log('[voice] 读记忆卡失败：', err?.message ?? err);
      return { top: [], gists: [] };
    }
    const candidates = cards
      .map((c) => ({
        date: String(c?.date ?? ''),
        gist: String(c?.gist ?? '').trim(),
        summary: String(c?.entry ?? '').trim(),   // buildVoicePrompt seg4 gist 缺省回退体（卡正文，spec 表里叫 summary）
        keywords: Array.isArray(c?.keywords) ? c.keywords.map(String) : []
      }))
      .filter((c) => c.date && (c.gist || c.summary));
    // renderVoiceState 记得行：最近卡的 gist（取前 3 由渲染层裁）
    const gists = cards.slice(-5).map((c) => String(c?.gist ?? '').trim()).filter(Boolean);
    const q = String(query ?? '').trim();
    let top = [];
    if (q) top = (await tryEmbedTop(q, candidates)) ?? lexicalTop(candidates, q, CARD_TOP_K);
    // 零命中 → [] → 段 4 整段省略（design §4.2 段 4 备注"无命中则整段省略"；
    // "记得"行不受影响——gists 来自最近卡，与检索命中无关）
    return { top, gists };
  }

  // ── 状态派生（design §4.5；person/* 只读，零新写者）────────────────────────────
  function gatherState(gists) {
    const state = { mind: null, life: null, gists };
    try { state.mind = mind.snapshot(); } catch (err) { log('[voice] mind 快照失败：', err?.message ?? err); }
    try {
      const plan = life.planForDay(localDayKey());
      if (plan && typeof plan === 'object') state.life = { items: Array.isArray(plan.items) ? plan.items : [] };
    } catch (err) { log('[voice] life plan 读取失败：', err?.message ?? err); }
    return state;
  }

  /** 心绪只读快照（T6 回想用：hello 时刻留底、挂断时刻取终值——情绪显著=首尾
   *  心绪文本或挂心事集合变化（文字口径，recall.js）。快照失败 → null，
   *  回想面降级（模板/staging 条件按缺省判），不拦通话主链。 */
  function snapMind() {
    try { return mind.snapshot(); } catch (err) { log('[voice] mind 快照失败：', err?.message ?? err); return null; }
  }

  // ── 连接状态机 ─────────────────────────────────────────────────────────────────
  function handleConnection(ws) {
    const callId = nextCallId++;
    let startedAt = Date.now();
    let ended = false;
    let state = 'idle';            // idle(未握手) → listening → thinking → speaking → listening（半双工轮替，V3）
    let history = [];              // [{who:'user'|'me', text}] 只存内存（不进 store 不进 sessions）
    let pendingText = null;        // 她说话期间收到的新文字（深度 1，超出 busy）
    let preamble = '';
    let preambleKicked = false;
    let audioFormat = 'ogg';       // 客户端 decode 失败可换 'wav'
    let ttsDown = false;           // 连续 2 句失败 → 整通降级纯文字（design §10.2）
    let ttsFailStreak = 0;
    let segCounter = 0;
    let busyTick = 0;              // busy 提示节流（同句重复来不刷屏）
    let refused = false;           // T7：引擎双不可用拒接（不 ready 不落回想行——§10.2-4）

    // ── V3 上行 utterance 缓冲（listening 期收 PCM 帧；thinking/speaking 期丢弃）────
    // 尾点判定在客户端（night-plan §2-T5：能量 RMS<阈值持续 silenceMs→utterance_end
    // 信令）；服务端按 config.voice.call.{min,max}UtteranceMs 双闸兜底。
    const callCfg = getConfig()?.voice?.call ?? {};
    const minUttMs = Number(callCfg.minUtteranceMs) > 0 ? Number(callCfg.minUtteranceMs) : 300;
    const maxUttMs = Number(callCfg.maxUtteranceMs) > 0 ? Number(callCfg.maxUtteranceMs) : 60000;
    const maxUttBytes = Math.ceil((maxUttMs / 1000) * UP_BYTES_PER_SEC);
    // ── W2 下行双模（内部文档 voice-provider-plan.md §4）────────────────────────────
    // deepseek-tools 方言 = PCM 流分块下行（24k mono s16；ready 后发 audio-mode 帧
    // 通知客户端切播放分支）；其余方言 = 整段 ogg/wav 一帧（现行为，audio-format
    // 换档信令仍有效）。openai-compat 的 'pcm' 配置值在下行面归一为 'ogg'（plan §4），
    // 故模式只按方言判定。方言判定 = voice.js dialectOf 同源三行副本（call.js 不
    // 静态 import capabilities/voice.js——批准口动态 import 纪律）。
    const ttsCfg = getConfig()?.voice?.tts ?? {};
    const rawD = String(ttsCfg.dialect ?? '').trim().toLowerCase();
    const engD = String(ttsCfg.engine ?? '').trim().toLowerCase();
    const ttsDialect = rawD
      ? (['gpu-local', 'deepseek-tools', 'openai-compat'].includes(rawD) ? rawD : null)
      : (['gpu-local', 'deepseek-tools', 'openai-compat'].includes(engD) ? engD : 'gpu-local');
    const downMode = ttsDialect === 'deepseek-tools' ? 'pcm' : 'segment';
    const ttsSampleRate = Number(ttsCfg.sampleRate) > 0 ? Number(ttsCfg.sampleRate) : 24000;
    let uttChunks = [];
    let uttBytes = 0;
    let asrAnnounced = false;      // asr_off 引导提示每通只说一次（说了不吵）
    let mindStart = null;          // hello 时刻心绪快照（回想"情绪显著"的首值；挂断取终值对比）

    const isOpen = () => ws.readyState === 1;   // ws.OPEN
    const send = (obj) => { if (isOpen()) { try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ } } };
    const sendBinary = (buf) => { if (isOpen()) { try { ws.send(buf); } catch { /* ignore */ } } };
    const sendTextFallback = (text) => send({ type: 'text_fallback', text: String(text ?? '') });
    const sendError = (code, message) => send({ type: 'error', code, message });

    /** 半双工阶段切换（V3）：listening/thinking/speaking 变更即推 {type:'state'} 帧——
     *  前端按它开/关 Worklet 发送侧门控（design §6.5）；同值不重发；idle(挂断终态)不推。 */
    function setPhase(next) {
      if (state === next) return;
      state = next;
      if (next !== 'idle') send({ type: 'state', value: next });
    }

    function kickPreamble() {
      if (preambleKicked) return;
      preambleKicked = true;
      // 通话开始一次轻量调用，不阻塞接通（fire-and-forget；下一轮组装时可用则用）
      buildCallPreamble()
        .then((t) => { if (t) preamble = t; })
        .catch((err) => log('[voice] 摘要异常（忽略）：', err?.message ?? err));
    }

    /** 接通收尾（T7 D19）：引擎确保完成后发 ready + 进 listening。双不可用
     *  （两引擎**均配置**且均拉起失败/未运行，§10.2-4）→ 明确报错拒接——不 ready、
     *  不进回想（refused 置位：零句拒绝不是"通话"，不落 [通话 M:SS] 行）。
     *  单项不可用照常接通：TTS 不可用=逐句 text_fallback（§10.2-2），ASR 不可用=
     *  utterance 得 asr_off 引导（§10.2-3，既有面）。 */
    function finishHello(status) {
      if (ended) return;
      if (status?.bothDown) {
        refused = true;
        ended = true;
        state = 'idle';
        const why = [status.tts, status.asr]
          .filter((x) => x?.configured && !x?.ok && x?.reason)
          .map((x) => x.reason)
          .join('；') || 'TTS 与语音识别均未就绪';
        log(`[voice] call#${callId} 拒接：${why}`);
        sendError('unavailable', `语音引擎未就绪（${why}），这通先打不了`);
        try { ws.close(); } catch { /* ignore */ }
        return;
      }
      kickPreamble();
      mindStart = snapMind();   // T6 回想：通话首值留底（挂断时对比判"情绪显著"）
      send({ type: 'ready', callId });
      // W2：PCM 双模通知帧（plan §4）——仅 pcm 模式发（segment 为缺省，不发=向后
      // 兼容旧客户端）；客户端按 value/sampleRate 切 PCM 播放分支。
      if (downMode === 'pcm') send({ type: 'audio-mode', value: 'pcm', sampleRate: ttsSampleRate });
      setPhase('listening');   // V3：接通即 listening（客户端按 state 帧开麦门控）
    }

    function drainPending() {
      if (ended || pendingText == null) return;
      const t = pendingText;
      pendingText = null;
      runTurn(t).catch((err) => {
        log('[voice] 排队轮异常：', err?.message ?? err);
        setPhase('listening');
        drainPending();
      });
    }

    /** 一轮：文字/转写进 → LLM 整段 → 切句 → TTS 队列 → 下行。 */
    async function runTurn(userText) {
      if (ended) return;
      setPhase('thinking');
      history.push({ who: 'user', text: String(userText ?? '') });
      if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP);

      let reply = '';
      try {
        const { top: cards, gists } = await pickCards(preamble || userText);
        const system = buildVoicePrompt({
          state: gatherState(gists),
          cards,
          preamble,
          history
        });
        const messages = [
          { role: 'system', content: system },
          { role: 'user', content: String(userText ?? '') }
        ];
        const completion = await chatCompletionFn({
          messages,
          maxTokens: LLM_MAX_TOKENS,
          temperature: null,                        // 用 api 缺省（spec §2.4）
          skillContext: { thinkingMode: 'off' }     // 按次关思考；tools 不传 = 无工具
        });
        reply = String(completion?.message?.content ?? '').trim();
      } catch (err) {
        log('[voice] LLM 失败：', err?.message ?? err);
        sendError('internal', '模型没接上，再说一句试试');
        setPhase('listening');
        drainPending();
        return;
      }
      if (!reply) {
        sendError('internal', '模型返回为空');
        setPhase('listening');
        drainPending();
        return;
      }
      history.push({ who: 'me', text: reply });
      if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP);

      await speakTurn(reply);
    }

    /** W2 PCM 流分块下行（plan §4，deepseek 方言）：synthesizeRaw 的 {stream} 产物 →
     *  WS 二进制分块顺序推（帧边界无语义——客户端在 segment_start..segment_end 间
     *  流式排程/累积）。返回 true=流完整送达；false=失败/中断（部分块可能已出——
     *  客户端播已到部分，调用方按失败计并补 text_fallback）。deadline=本轮 20s
     *  总闸，在分块间隙同样生效（超闸取消余流，截断段收口）。 */
    async function pushPcmStream(encoded, seg, deadline) {
      const segId = ++segCounter;
      send({ type: 'segment_start', segId, index: seg.index, isFirst: seg.isFirst });
      const reader = encoded.stream.getReader();
      let sentBytes = 0;
      try {
        for (;;) {
          if (ended || !isOpen()) return false;
          if (Date.now() > deadline) {
            try { await reader.cancel(); } catch { /* ignore */ }
            break;
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            sendBinary(Buffer.from(value));   // 拷贝脱离流内部视图
            sentBytes += value.length;
          }
        }
      } catch (err) {
        log('[voice] PCM 流中断（按失败计）：', err?.message ?? err);
        try { await reader.cancel(); } catch { /* ignore */ }
        send({ type: 'segment_end', segId });   // 截断段收口（客户端播已到部分）
        return false;
      }
      send({ type: 'segment_end', segId });
      if (!sentBytes) {
        log('[voice] PCM 流为空（按失败计）');
        return false;
      }
      return true;
    }

    /** TTS 队列（并发 1；源=本轮切句数组天然有界；单句 5s 超时在 synthesizeRaw 内建）。 */
    async function speakTurn(reply) {
      if (ended) return;
      setPhase('speaking');
      const deadline = Date.now() + TURN_BUDGET_MS;
      const segs = splitForSpeech(reply);   // 只切不改（R7 逐字节全等）
      if (ttsDown) {
        // 整通降级：整段文字原样一帧出（spec 验收 2"整段文字原样"），不再逐句试引擎
        sendTextFallback(reply);
        setPhase('listening');
        drainPending();
        return;
      }
      for (const seg of (segs.length ? segs : [{ index: 0, text: reply, isFirst: true }])) {
        if (ended) return;
        if (ttsDown || Date.now() > deadline) {
          // 连续 2 败 / 整轮 20s 总闸：余句全部 text_fallback（spec §2.4，通话不断）
          sendTextFallback(seg.text);
          continue;
        }
        let encoded = null;
        try {
          encoded = await synthesizeRawFn(seg.text, { format: audioFormat });
        } catch (err) {
          log('[voice] synthesizeRaw 异常（按失败计）：', err?.message ?? err);
          encoded = null;
        }
        if (ended) return;
        // W2 下行双模（plan §4）：stream 产物 = PCM 流分块推（deepseek 方言）；
        // bytes 产物 = 整段 ogg/wav 一帧（现行为）。
        if (encoded?.stream && typeof encoded.stream.getReader === 'function') {
          const ok = await pushPcmStream(encoded, seg, deadline);
          if (ended) return;
          if (!ok) {
            ttsFailStreak += 1;
            if (ttsFailStreak >= 2) ttsDown = true;   // 连续 2 句失败 → 降级（与 voice.js 熔断同源并存）
            sendTextFallback(seg.text);
          } else {
            ttsFailStreak = 0;
          }
          continue;
        }
        const bytes = encoded?.bytes;
        if (!bytes || !Buffer.isBuffer(bytes) || !bytes.length) {
          ttsFailStreak += 1;
          if (ttsFailStreak >= 2) ttsDown = true;   // 连续 2 句失败 → 降级（与 voice.js 熔断同源并存）
          sendTextFallback(seg.text);
        } else {
          ttsFailStreak = 0;
          const segId = ++segCounter;
          send({ type: 'segment_start', segId, index: seg.index, isFirst: seg.isFirst });
          sendBinary(bytes);                        // 整段 ogg/wav 一帧（night-plan §0 2026-11-18 裁定）
          send({ type: 'segment_end', segId });
        }
      }
      setPhase('listening');
      drainPending();
    }

    // ── V3 上行（night-plan §2-T5 / design §6）────────────────────────────────────
    /** 上行 PCM 帧入口：listening 期攒 utterance；thinking/speaking 期直接丢弃
     *  （服务端状态机侧；客户端 Worklet 发送侧门控=双保险，design §6.5）。
     *  缓冲超 maxUtteranceMs 上限 → 强制收尾（客户端尾点失联兜底）。 */
    function onPcmFrame(chunk) {
      if (state !== 'listening' || ended) return;
      const buf = Buffer.from(chunk);   // 拷贝脱离 ws 内部视图
      uttChunks.push(buf);
      uttBytes += buf.length;
      if (uttBytes >= maxUttBytes) finalizeUtterance('cap');
    }

    /** utterance 收尾（客户端 {type:'utterance_end'} 信令 / 60s 上限兜底）：
     *  缓冲 → wav（内存）→ ASR。空/过短（< minUtteranceMs，design §6.1 防咳嗽误触）
     *  静默丢弃不回帧，状态不离开 listening。 */
    function finalizeUtterance(source) {
      if (ended) return;
      let pcm = uttChunks.length ? Buffer.concat(uttChunks) : Buffer.alloc(0);
      uttChunks = [];
      uttBytes = 0;
      if (state !== 'listening') return;   // 非 listening 的信令（竞态/重放）：忽略不扰当前轮
      if (!pcm.length) return;
      if (pcm.length % 2 === 1) pcm = pcm.subarray(0, pcm.length - 1);   // s16 对齐
      const ms = Math.round((pcm.length / UP_BYTES_PER_SEC) * 1000);
      if (ms < minUttMs) {
        log(`[voice] call#${callId} utterance 过短丢弃（${ms}ms < ${minUttMs}ms，${source}）`);
        return;
      }
      setPhase('thinking');
      runUtterance(pcm, ms).catch((err) => {
        log('[voice] 上行轮异常：', err?.message ?? err);
        sendError('internal', '这通电话出了点状况，再说一句试试');
        setPhase('listening');
        drainPending();
      });
    }

    /** 上行轮：ASR（15s 超时=voice.asr.timeoutMs 在批准口内建）→ 成功走 runTurn 主链；
     *  识别未开启 → asr_off 引导文字（每通一次）；失败/空 → "没听清，再说一次"。
     *  失败不落任何条目（不进 history 不进 store——"逐句对话不落档"的失败侧）。 */
    async function runUtterance(pcm, ms) {
      const available = await asrAvailableFn();
      if (ended) return;
      if (!available) {
        if (!asrAnnounced) {
          asrAnnounced = true;
          sendError('asr_off', '我这边还听不了语音（识别未开启），打字说吧');
        }
        setPhase('listening');
        return;
      }
      let res = null;
      try {
        res = await transcribeWavFn(pcmToWav16k(pcm));
      } catch (err) {
        log('[voice] transcribeWav 异常（按失败计）：', err?.message ?? err);
        res = null;
      }
      if (ended) return;
      const text = String(res?.text ?? '').trim();
      if (!text) {
        log(`[voice] call#${callId} ASR 失败/为空（${ms}ms）——提示重说不落档`);
        sendError('asr', '没听清，再说一次');
        setPhase('listening');
        return;
      }
      log(`[voice] call#${callId} utterance ${ms}ms → "${clip(text, 40)}"`);
      await runTurn(text);
    }

    function handleText(raw) {
      const text = String(raw ?? '').trim();
      if (!text) {
        sendError('bad_request', 'text 为空');
        return;
      }
      if (ended) return;
      kickPreamble();
      if (state === 'idle' || state === 'listening') {
        runTurn(text).catch((err) => {
          log('[voice] 轮次异常：', err?.message ?? err);
          setPhase('listening');
          sendError('internal', '通话轮次异常，再说一句试试');
          drainPending();
        });
        return;
      }
      // 半双工 V2 简化：她说期间新文字排队一条（深度 1，超出回 busy；不打断）
      if (pendingText == null) {
        pendingText = text;
      } else {
        const tick = ++busyTick;
        send({ type: 'error', code: 'busy', message: `她说着呢，这条没排上（${tick}）` });
      }
    }

    /** 挂断（WS close 或 stop 信令）：停队列、状态回 idle、ended 帧先行，回想异步（T6）。 */
    function hangup(reason) {
      if (ended) return;
      ended = true;
      state = 'idle';
      pendingText = null;
      const endedAt = Date.now();
      send({ type: 'ended', reason });
      try { ws.close(); } catch { /* ignore */ }
      // V3 挂断回想（design §8.3 时机行"挂断后异步，不阻塞挂断响应"）：ended 帧与断链
      // 先出，fire-and-forget 生成。唯一存档写入点=recall.js（appendSelf 恰一次 + callId
      // 幂等 + 失败回落模板 + ≥recallMinSeconds/情绪显著经 person/memory 追加 staging）。
      // history.slice()=拍快照：turn 收尾竞态下迟到的 push 不影响已交给回想的输入。
      // 回想开关（所有者 2026-11-19：调试期可关）：缺省 true；false 时整通不落回想行。
      // 关掉=聊天记录里不留通话痕迹（逐句本来就不进 messages），只影响这一条回想。
      if (getConfig()?.voice?.call?.recall !== false) {
        recall.kick({
          callId,
          history: history.slice(),
          endedAt,
          durMs: Math.max(0, endedAt - startedAt),
          mindStart,
          mindEnd: snapMind()
        });
      }
    }

    ws.on('message', (data, isBinary) => {
      if (ended) return;
      if (isBinary) {
        onPcmFrame(data);   // 上行二进制 = PCM16/16k/40ms 裸帧（V3 消费；listening 外丢弃）
        return;
      }
      let msg = null;
      try {
        msg = JSON.parse(Buffer.from(data).toString('utf8'));
      } catch {
        sendError('bad_request', '控制消息不是合法 JSON');
        return;
      }
      const type = String(msg?.type ?? '');
      if (type === 'hello') {
        // T7 D19：引擎确保（探测/auto 拉起/预热）在 ready 之前——客户端整个
        // "准备声音"态（preparing）覆盖这段（design §2.4 状态链：呼叫中→准备
        // 声音（拉起/预热引擎）→接通中）。引擎均未配置时 ensureForCall 同步
        // 返回普通对象（零探测零进程），ready 保持既有同步路径（快路径不劣化）。
        const status = engineManager.ensureForCall();
        if (status && typeof status.then === 'function') {
          status.then((s) => finishHello(s)).catch((err) => {
            // 引擎确保自身异常 ≠ 通话失败：按"无信息"接通，逐句/逐段降级兜住
            //（§10.2 铁律：不卡死不静默；synthesizeRaw/asr 口自有的失败面照常工作）
            log(`[voice] call#${callId} 引擎确保异常（按无信息接通）：`, err?.message ?? err);
            finishHello(null);
          });
        } else {
          finishHello(status);
        }
        return;
      }
      if (type === 'utterance_end') {
        finalizeUtterance('client');   // 客户端尾点判定信令（night-plan §2-T5）
        return;
      }
      if (type === 'text') {
        handleText(msg?.text);
        return;
      }
      if (type === 'audio-format') {
        const v = String(msg?.value ?? '').trim().toLowerCase();
        audioFormat = v === 'wav' ? 'wav' : 'ogg';   // 客户端 decode 失败换档（night-plan §0 裁定）
        log(`[voice] call#${callId} 下行档位换 ${audioFormat}`);
        return;
      }
      if (type === 'stop') {
        hangup('client');
        return;
      }
      sendError('bad_request', `未知消息类型 ${type || '(空)'}`);
    });
    ws.on('close', () => hangup('client'));
    ws.on('error', (err) => {
      log(`[voice] call#${callId} ws 错误：`, err?.message ?? err);
      hangup('client');
    });
  }

  /** HTTP → WS 升级握手（app.js server.on('upgrade') 调）。鉴权面与 /api 一致
   *  （originAllowed 由装配层注入，不新增 token 要求——spec §2.5）；
   *  voice.call.enabled=false（或 voice.enabled=false）→ 404，通话入口不存在
   *  （design §12 回滚口径：开关关=入口消失，其余功能不变）。 */
  async function handleUpgrade(req, socket, head) {
    const v = getConfig()?.voice;
    if (!v?.enabled || !v?.call?.enabled) {
      rawReject(socket, 404, 'voice call disabled');
      return;
    }
    if (originAllowed && !originAllowed(req)) {
      rawReject(socket, 403, 'origin not allowed');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws));
  }

  // releaseEngines（T7 D19）：暴露装配层的自拉进程清理给 app.stop()——退出时只杀
  // engine-manager 登记过的 PID（所有者手启的引擎绝不触碰）。挂断不调它：GPU 无限制
  // 口径下引擎可长驻（night-plan §1-1），下次呼叫免 25s 冷启。
  return { handleUpgrade, handleConnection, releaseEngines: () => engineManager.release() };
}

/** PCM16/16k mono 裸字节 → wav 容器（内存 44B 头；E1：字节只进内存与引擎请求体，
 *  不落 media-store 不落盘——keepAudio=false 通话形态）。 */
function pcmToWav16k(pcm) {
  const dataLen = pcm.length;
  const out = Buffer.alloc(44 + dataLen);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataLen, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);       // fmt 块长
  out.writeUInt16LE(1, 20);        // PCM
  out.writeUInt16LE(1, 22);        // mono
  out.writeUInt32LE(UP_PCM_RATE, 24);
  out.writeUInt32LE(UP_BYTES_PER_SEC, 28);
  out.writeUInt16LE(2, 32);        // block align
  out.writeUInt16LE(16, 34);       // bits
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataLen, 40);
  pcm.copy(out, 44);
  return out;
}

/** 非 WebSocket 应答（plain HTTP 错误行 + 断链）。 */
function rawReject(socket, code, reason) {
  try {
    socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* ignore */ }
  try { socket.destroy(); } catch { /* ignore */ }
}
