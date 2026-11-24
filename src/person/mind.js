// 人格内核 · 心绪状态（Phase 3 / T3.3；步骤③ T3.2 扩 mind_note/mind_settle 写入口）
// storage-v2 V4 起后端 = xunxi.db **state 表（key='mind'，整对象 JSON 列）**
//（原 data/person/mind.json 已随迁移改为 .pre-storage-v2 原位归档）。
// 本文件是 mind 状态的**唯一写者**。
// **2026-11-21 所有者裁定：心绪只注入文字（prompt.renderMindSection 只读 mood.text
// 与心事文本），数值轴 valence/arousal/energy 不进提示词 → 整体丢弃**——apply 不再
// 更新数值（保留 impact 阈值门控心事创建，属内部机制非存储值）、decay 删除、
// temperament 依赖随之摘除；ensure() 顺手剥离旧状态里的遗留数值字段。
// apply/noteMood/settle 的写入失败只 console.warn、不上抛、绝不写半截状态
//（DB 后端：单语句 UPSERT 自身原子；嵌套在巩固事务内时由外层事务保证整体原子）。
//
// 步骤③（v3 T3.2）新增：noteMood / settle 两个写入口，语义从已归档的「私聊记忆库」
// 技能（原 skills/ 心绪机制，2026-11-07 随步骤③整目录归档至 _archive-20261107/）的
// applyMindNote / applyMindSettle 移植（mood 文本 ≤20 字、心事 ≤30 字、容量 ≤3 条、
// TTL 过期 + isSameTopic 近重复合并），但落点是本模块的状态（state 表 key='mind'）：
//   · mood 文本    → state.mood.text / state.mood.textAt
//   · 心事 topics  → state.preoccupations（expiresAt 用 72h，替代旧"touchedAt+12h"口径）
// 过期清理在 snapshot()/apply() 顺手做（pruneExpired），读取方不产生额外副作用之外
// 的写库 —— 与本模块既有约定一致。
import path from 'node:path';
import { DATA_DIR as DATA_ROOT } from '../config.js';
import { stateGet, statePut } from '../storage/state-map.js';

// V4 前的唯一真身路径（现 = .pre-storage-v2 原位归档；仅 dev/诊断面 mindFile 导出使用）。
const FILE = path.join(DATA_ROOT, 'person', 'mind.json');

const PREOCCUPATION_TTL_MS = 72 * 60 * 60 * 1000;  // preoccupation 72 小时过期（步骤③ T3.2 定稿口径）
const PREOCCUPATION_KINDS = ['promise', 'conflict', 'open_loop'];
const PREOCCUPATION_MIN_IMPACT = 0.5;
// ── 步骤③ T3.2：mind_note/mind_settle 的文本口径（移植自已归档的「私聊记忆库」技能）──
const MOOD_TEXT_MAX = 20;    // mood 文本 ≤20 字
const TOPIC_TEXT_MAX = 30;   // 心事文本 ≤30 字
const MAX_TOPICS = 3;        // 心事容量上限 3 条（pruneMoodState 的 maxTopics 移植）
const MOOD_TEXT_TTL_MS = 24 * 60 * 60 * 1000;  // mood 文本 24h 不续期即淡去（旧 moodTtlHours=24 口径）

/** 文本清洗（移植自归档前「私聊记忆库」技能的 clean）：折叠空白、去首尾、按上限截断。 */
function clean(s, max = 0) {
  let out = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (max > 0 && out.length > max) out = out.slice(0, max);
  return out;
}

/**
 * 心事归一化（移植 normalizeTopic）：去空白、去标点/符号、大小写折叠。
 * 近重复合并（isSameTopic）靠它 —— 同一件事换个说法也能认出来。
 */
function normalizeTopic(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/**
 * 两条心事是不是"同一件"（逐字移植 isSameTopic）：
 *   · 归一化后完全相等 → 是；
 *   · 一方包含另一方（或去掉少量插字后包含），且公共部分 ≥6 字、
 *     占双方长度的 ≥50% → 是。
 * 6 字下限与 50% 比例是保守闸门：不把"吃饭了"和"吃饭了没"误并成一件。
 *
 * 2026-11-18 S2 修补（audit ui-ux P2-3，"期待未来能/未听到彼此声音的那天"
 * 近重复在 UI 上并存两件）：原"包含"是**子串**判定——一对只差否定/副词插字
 * （"能真正" vs "未"）的心事互不为子串，永远并不上（负向包含判定缺失）。
 * 现把包含关系放宽为**子序列**（最长公共子序列 LCS 承担），闸门三道：
 * LCS ≥6、≥双方长度 50%、**公共前缀 ≥2**（同一段话中间换了说法才像同一件；
 * "甲件事麻烦还没了结"/"乙件事麻烦还没了结"这类模板填槽对前缀=0，不并——
 * person-tests 容量上限测试即此口径）。行为连续性：子串包含时 LCS=短句全长
 * 且前缀≥2 恒成立，新旧判定真值集一致（旧规则真值集是新规则的真子集）。
 * 既有保守例证不变："吃饭了"/"吃饭了没"（<6 字）不并、"明天要还书"/
 * "下周要还书"（前缀 0）不并。
 * 审计口径注：批次三文案写"否定词的误合并"，实锚=audit P2-3"近重复**未**合并"
 * +设计稿四验收"挂心事无近重复"——修补方向为漏并修复（详见 handoff §10-15）。
 */
export function isSameTopic(a, b) {
  const x = normalizeTopic(a);
  const y = normalizeTopic(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 6) return false;
  if (long.includes(short)) return short.length / long.length >= 0.5;   // 旧判定路径原样
  // 子序列包含（LCS）：差否定/副词插字的近重复（audit P2-3 能/未对）也归一件；
  // 公共前缀 ≥2 把"同模板填槽"（甲/乙件事…）挡在闸外
  const lcs = lcsLength(x, y);
  if (lcs < 6) return false;
  if (lcs / short.length < 0.5 || lcs / long.length < 0.5) return false;
  let prefix = 0;
  const n = Math.min(x.length, y.length);
  while (prefix < n && x[prefix] === y[prefix]) prefix++;
  return prefix >= 2;
}

/** 最长公共子序列长度（O(n·m) 滚动数组 DP；心事 ≤30 字级，开销可忽略） */
function lcsLength(x, y) {
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[y.length];
}

/** 下一个 preoccupation id（p1、p2…按现存最大号递增）。 */
function nextPreoccupationId(state) {
  const maxId = state.preoccupations.reduce((m, p) => {
    const n = Number.parseInt(String(p?.id ?? '').slice(1), 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return `p${maxId + 1}`;
}

/**
 * 把近似重复的心事并成一条（移植 mergeTopics）：文本留"信息更多"的说法、
 * 创建时间按最早排队、过期时间按最晚续期。纯函数，不改入参。
 */
function mergePreoccupations(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const text = clean(p?.text, TOPIC_TEXT_MAX);
    if (!text) continue;
    const at = Number(p?.at) || 0;
    const hit = out.find((o) => isSameTopic(o.text, text));
    if (!hit) {
      // 显式列字段：weight 等 2026-11-21 已丢弃的遗留数值字段不随合并存活
      out.push({ id: p?.id, text, at, source: p?.source, expiresAt: p?.expiresAt });
      continue;
    }
    if (normalizeTopic(text).length > normalizeTopic(hit.text).length) hit.text = text;
    hit.at = hit.at ? Math.min(hit.at, at || hit.at) : at;
    hit.expiresAt = Math.max(Number(hit.expiresAt) || 0, Number(p?.expiresAt) || 0);
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

function seedState(now = Date.now()) {
  return {
    version: 1,
    // text/textAt（步骤③）：mind_note 写入的心绪文本 + 最近一次记录/续期时间。
    // （2026-11-21 数值轴 valence/arousal/energy 已随"数值不注入即丢弃"裁定移除。）
    mood: { text: '', textAt: 0, updatedAt: now },
    body: { sleepy: false, hungry: false },
    preoccupations: [],
    intentions: [],
    updatedAt: now
  };
}

/** 读自己的状态（state 表 key='mind'；缺行/读不到 → null：视为空状态，下次 apply/decay 会落种子）。 */
function readRaw() {
  return stateGet('mind');
}

/** 整对象 UPSERT（state-map 契约：单语句原子）；失败返回 false（调用方只 warn 不上抛）。 */
function writeRaw(state) {
  try {
    statePut('mind', state);
    return true;
  } catch (err) {
    console.warn('[mind] write failed', err?.message ?? err);
    return false;
  }
}

function ensure() {
  const state = readRaw() ?? seedState();
  if (!state.mood || typeof state.mood !== 'object') state.mood = seedState().mood;
  // 2026-11-21 数值轴丢弃：旧状态里的遗留数值字段在读起时剥离，下次写盘即落干净形状
  delete state.mood.valence;
  delete state.mood.arousal;
  delete state.energy;
  delete state.dayKey;
  delete state.dayDeltaSum;
  if (typeof state.mood.text !== 'string') state.mood.text = '';          // 步骤③：心绪文本
  if (!Number.isFinite(Number(state.mood.textAt))) state.mood.textAt = 0; // 步骤③：文本最近记录时间
  if (!state.body || typeof state.body !== 'object') state.body = { sleepy: false, hungry: false };
  if (!Array.isArray(state.preoccupations)) state.preoccupations = [];
  if (!Array.isArray(state.intentions)) state.intentions = [];
  return state;
}

/**
 * 整理过期状态：mood 文本超 24h 未续期即淡去；expiresAt < now 的心事删除。
 * 有清理才需要写盘，返回是否变化。（移植 pruneMoodState 的 TTL 口径；心事 TTL
 * 由每条自身的 expiresAt 承载 —— noteMood/settle/迁移都写 72h。）
 */
function pruneExpired(state, now) {
  let changed = false;
  if (state.mood.text && (now - (Number(state.mood.textAt) || 0)) > MOOD_TEXT_TTL_MS) {
    state.mood.text = '';
    state.mood.textAt = 0;
    changed = true;
  }
  const keep = state.preoccupations.filter((p) => !(Number(p?.expiresAt) < now));
  if (keep.length !== state.preoccupations.length) {
    state.preoccupations = keep;
    changed = true;
  }
  return changed;
}

/**
 * 只读快照。顺手清掉已过期的心绪文本与心事（有过期项时写盘一次，失败只 warn）。
 * @returns {import('./contracts.js').MindState}
 */
export function snapshot(now = Date.now()) {
  const state = ensure();
  if (pruneExpired(state, now)) {
    state.updatedAt = now;
    writeRaw(state);   // 失败已 warn；返回值仍是清理后的视图
  }
  return structuredClone(state);
}

/**
 * 应用一条情绪事件（不抛错：校验不过/写盘失败 → warn + 返回 null，绝不写坏文件）。
 * 2026-11-21 数值轴丢弃后本函数只剩一件事：impact 阈值门控的心事创建（valence
 * 不再消费——事件里的数值只在此作一次性判定用，不落盘）。
 * @param {{valence?: number, impact?: number, kind?: string, text?: string}} event
 * @returns {import('./contracts.js').MindState|null}
 */
export function apply(event = {}) {
  try {
    const impact = Number(event.impact ?? 0);
    if (!Number.isFinite(impact)) {
      console.warn('[mind] apply 收到非数字 impact，忽略', event);
      return null;
    }

    const now = Date.now();
    const state = ensure();
    let changed = false;

    // preoccupations：promise/conflict/open_loop 且 impact > 0.5 时追加；过期顺手清
    if (PREOCCUPATION_KINDS.includes(event.kind) && impact > PREOCCUPATION_MIN_IMPACT) {
      state.preoccupations.push({
        id: nextPreoccupationId(state),
        text: String(event.text ?? ''),
        at: now,   // 步骤③：统一补创建时间（mergePreoccupations 的排序键）
        source: event.kind,
        expiresAt: now + PREOCCUPATION_TTL_MS
      });
      changed = true;
    }
    if (pruneExpired(state, now)) changed = true;

    if (!changed) return structuredClone(state);   // 零变化不写盘

    state.updatedAt = now;
    return writeRaw(state) ? structuredClone(state) : null;
  } catch (err) {
    console.warn('[mind] apply failed', err?.message ?? err);
    return null;
  }
}

/**
 * 记心绪（步骤③ T3.2，语义移植 applyMindNote）：更新 mood 文本 + 挂/续心事。
 *  · mood：≤20 字一句短话；变了就更新并盖时间戳，没变只续期（避免假波动）；
 *  · topics：每条 ≤30 字，最多留 3 条；与现有心事 isSameTopic 命中的只续期
 *    （expiresAt 续到 now+72h，文本留信息更多的说法），没命中才新增；
 *  · 写盘失败 / 校验异常 → warn + 返回 null，绝不写坏文件。
 * @param {{mood?: string, topics?: string[], source?: string}} input
 * @returns {{moodChanged:boolean, added:number, touched:number, state:import('./contracts.js').MindState}|null}
 */
export function noteMood({ mood, topics, source = 'mind_note' } = {}) {
  try {
    const now = Date.now();
    const state = ensure();
    const pruned = pruneExpired(state, now);

    const hasMood = typeof mood === 'string' && mood.trim();
    const topicTexts = (Array.isArray(topics) ? topics : [])
      .map((t) => clean(t, TOPIC_TEXT_MAX))
      .filter(Boolean);
    // 什么有效内容都没传：不写盘，直接回当前状态（旧实现会白写一次 updatedAt，这里省掉）；
    // 若顺手清了过期项，仍要落盘一次，别让清理只停留在内存里。
    if (!hasMood && !topicTexts.length) {
      if (pruned) {
        state.updatedAt = now;
        writeRaw(state);
      }
      return { moodChanged: false, added: 0, touched: 0, state: structuredClone(state) };
    }

    let moodChanged = false;
    if (hasMood) {
      const next = clean(mood, MOOD_TEXT_MAX);
      if (next && next !== state.mood.text) {
        state.mood.text = next;
        state.mood.textAt = now;
        moodChanged = true;
      } else if (next) {
        // 情绪没变：只续期，避免"每隔几小时就淡忘一次"的假波动（移植语义）
        state.mood.textAt = now;
      }
    }

    let added = 0;
    let touched = 0;
    for (const text of topicTexts) {
      const hit = state.preoccupations.find((p) => isSameTopic(p?.text, text));
      if (hit) {
        if (normalizeTopic(text).length > normalizeTopic(hit.text).length) hit.text = text;
        hit.expiresAt = now + PREOCCUPATION_TTL_MS;   // 同一件事：只续期，不重复记
        touched += 1;
        continue;
      }
      state.preoccupations.push({
        id: nextPreoccupationId(state),
        text,
        at: now,
        source: String(source ?? 'mind_note'),
        expiresAt: now + PREOCCUPATION_TTL_MS
      });
      added += 1;
    }

    // 近重复合并 + 容量上限（移植 mergeTopics + slice(-maxTopics)）：
    // 心事统一按创建时间排队，超出 3 条的挤掉最早的。
    state.preoccupations = mergePreoccupations(state.preoccupations).slice(-MAX_TOPICS);

    state.mood.updatedAt = now;
    state.updatedAt = now;
    return writeRaw(state)
      ? { moodChanged, added, touched, state: structuredClone(state) }
      : null;
  } catch (err) {
    console.warn('[mind] noteMood failed', err?.message ?? err);
    return null;
  }
}

/**
 * 放下心事 / 更新情绪（步骤③ T3.2，语义移植 applyMindSettle）。
 *  · keyword：归一化后包含匹配（传关键词的一部分也能命中）；不传 = 全部放下；
 *  · mood：想通后的新情绪（可选，≤20 字）。
 * @param {{keyword?: string, mood?: string}} input
 * @returns {{removed:number, state:import('./contracts.js').MindState}|null}
 */
export function settle({ keyword, mood } = {}) {
  try {
    const now = Date.now();
    const state = ensure();
    const pruned = pruneExpired(state, now);

    const kw = clean(keyword, TOPIC_TEXT_MAX);
    let removed = 0;
    if (kw) {
      const nk = normalizeTopic(kw) || kw;
      state.preoccupations = state.preoccupations.filter((p) => {
        const nt = normalizeTopic(p?.text);
        if (nt && (nt.includes(nk) || nk.includes(nt))) { removed += 1; return false; }
        return true;
      });
    } else {
      removed = state.preoccupations.length;
      state.preoccupations = [];
    }

    let moodChanged = false;
    if (typeof mood === 'string' && mood.trim()) {
      const next = clean(mood, MOOD_TEXT_MAX);
      if (next && next !== state.mood.text) {
        state.mood.text = next;
        state.mood.textAt = now;
        moodChanged = true;
      } else if (next) {
        state.mood.textAt = now;
      }
    }

    state.preoccupations = mergePreoccupations(state.preoccupations).slice(-MAX_TOPICS);

    // 没放下任何心事、情绪也没动：不写盘（省一次无意义落盘）；顺手清了过期项仍要落盘
    if (!removed && !moodChanged) {
      if (pruned) {
        state.updatedAt = now;
        writeRaw(state);
      }
      return { removed: 0, state: structuredClone(state) };
    }
    state.mood.updatedAt = now;
    state.updatedAt = now;
    return writeRaw(state) ? { removed, state: structuredClone(state) } : null;
  } catch (err) {
    console.warn('[mind] settle failed', err?.message ?? err);
    return null;
  }
}

/** V4 前状态文件绝对路径（dev 脚本/诊断用；V4 起真身 = xunxi.db state 表 key='mind'，
 *  该路径为 .pre-storage-v2 原位归档的历史位置）。 */
export const mindFile = FILE;
