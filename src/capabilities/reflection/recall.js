// 召回子系统（步骤⑤ / T5.5；card-vector 夜2 T2.1 三源融合扩展；W4 注入策略）—— 闸门 + 卡片检索。
//
// 定位（原清单 §10.4 / v3 T5.5；card-vector-index-plan v4.1 §3.6）：
//   · 闸门：冷启动（>2 小时没聊）跑"上次聊到哪"；触发文本含回忆线索
//     （记得/上次/以前/那天/当时/凭记忆/翻记录/上周/日期型）或人名才跑；其余不跑 ——
//     不给模型加工具，是否召回、召回什么由皮层在此决定（"不注册模型工具"）。
//   · W4（night-plan-polish §2-W4 · 所有者拍板"调用与注入解耦"）：embedding 开启且
//     预取命中（vectorHits 非空）时 gateMode='always'（缺省）跳过三闸门直接融合注入
//     （命中即注入；注入块头部带「仅供参考」标注行 RECALL_NOTE_LINE）；gateMode='strict'
//     回退旧三闸门（行为与 W4 前逐字节一致）。vectorHits 空（关闭态/预取未热/无命中）
//     闸门照旧——关闭态零调用零注入不变式保持。
//   · 语料 = 记忆卡（person/cards，巩固产物），**不查消息原文**。词法行语料自
//     夜2 T2.1 起扩展：entry 正文与 promises 入 cardLines（P2-4 缺口另一半）；
//     另有四源向量路（见下）——服务不在/关闭态时纯词法是常态路径。
//   · 返回 ≤2 条、每条 ≤60 字、带日期；recallHits 多源记账由本文件产出、
//     接线方（prompt.js 召回块）写入 session.recallHits（UI 可见；M1 承诺兑现）。
//
// 四源 RRF 融合（夜2 T2.1/T2.7 + 第二批行级 T3 · 计划 §3.6/D3 + 20 题验收定型）：
//   · 词法行（tokenize 打分，语料已扩展）× 卡级 gist 行 × fact 行 × 行级向量行——
//     四路候选**行级直出**（Q2 拍板），score = Σ w_i/(60+rank_i)，k=60、rank 1 起，
//     路权重读 config memory.embedding.fuseWeights（lexical/vector/row/gist/fact 五键；
//     gist/fact 显式给出时优先，缺省回落 vector）。
//   · 注入式：recallForPrompt({vectorHits}) —— 形状 [{kind:'gist'|'fact'|'row',
//     date|key|rowKey, text, score}]（orchestrator #runAgent 从 cardIndex.peekQuery+search
//     组装）；**缺省 undefined = 纯词法**，与改造前调用形状逐字节一致（关闭态不变式；
//     对照基线 = tools/fixtures/recall-lexical-snapshot.json，差异仅限语料扩展）。
//   · 展示（gist 命中→gist 行 / fact 命中→content 行 / 词法→原行）+ 输出层日期聚合：
//     同一天只保留融合序最优的一行，词法行与 gist 行双源在场标 'both'（T2.4 四值记账）；
//     向量行有 cosine 下限 vectorFloor（验收实测定值）——低相关行不顶词法命中。
//   · 只在融合路生效；纯词法路保持改造前行为（不重组不聚合，逐字节不变式）。
//     renderRecallSection（prompt.js）零改动。
//
// 本文件禁止 import 发送/协议模块（check-boundaries 扫 src/capabilities/**）；
// import 面 = person/memory（真身读者）/ config（fuseWeights，纯读）。

import { cards } from '../../person/memory.js';
import { getConfig } from '../../config.js';

// ── 闸门 ──────────────────────────────────────────────────────────────────

/**
 * 回忆线索触发词（v3 T5.5 词表；2026-11-16 真聊扩 gate：日期/记忆测试线索）。
 * 只做提示词注入闸门，不改变召回算法；误触发成本=一次本地向量检索 + 最多两条注入。
 */
export const RECALL_TRIGGER_WORDS = [
  '记得', '上次', '以前', '那天',
  '当时', '凭记忆', '记忆里', '回忆', '翻聊天记录', '翻记录', '上周'
];

/** 日期型记忆线索：11月3号 / 十一月三号 / 2号 / 2026-11-03。 */
const RECALL_DATE_RE = /(?:\d{1,2}|[一二三四五六七八九十]{1,2})月(?:\d{1,2}|[一二三四五六七八九十]{1,2})[日号]|\d{1,2}号|\d{4}-\d{2}-\d{2}/;

const COLD_START_MS = 2 * 60 * 60 * 1000;   // 冷启动阈值：>2 小时没聊

// ── W4 注入策略（night-plan-polish §2-W4 · 所有者拍板：调用与注入解耦）─────────
// 【近期回忆】注入块的「仅供参考」标注行——文案单一事实源（prompt.js renderRecallSection
// 引用本常量渲染，勿在别处复制第二份）。
export const RECALL_NOTE_LINE = '不必刻意提及，相关可提';

/** embedding 注入闸门模式（config.memory.embedding.gateMode；W4）：
 *  · 'always'（缺省）＝新策略——embedding 开启且预取命中（vectorHits 非空）时跳过旧
 *    三闸门（冷启动/线索词/人名）直接融合注入（"命中即注入"）；vectorHits 空（关闭态/
 *    预取未热/无命中）不注入向量路，闸门照旧管词法兜底——关闭态行为逐字节不变。
 *  · 'strict' ＝旧三闸门可回退，行为与 W4 前逐字节一致。
 *  非法/缺省值一律落 'always'（新策略是缺省；显式 'strict' 才回退）。 */
export function embeddingGateMode() {
  const v = String(getConfig()?.memory?.embedding?.gateMode ?? '').trim();
  return v === 'strict' ? 'strict' : 'always';
}

/**
 * 召回闸门（纯函数）。
 * @param {{
 *   text?: string,             // 本轮触发的最新消息文本（未读信息）
 *   lastMessageTs?: number,    // 该会话最后一条消息的时间（0 = 没聊过）
 *   now?: number,
 *   names?: string[]           // 已知人名（备注名/昵称等；命中即"人名"线索）
 * }} p
 * @returns {{hit: boolean, reason: ''|'cold-start'|'trigger-word'|'name'}}
 */
export function recallGate({ text = '', lastMessageTs = 0, now = Date.now(), names = [] } = {}) {
  const ts = Number(lastMessageTs) || 0;
  if (ts > 0 && now - ts > COLD_START_MS) return { hit: true, reason: 'cold-start' };
  const t = String(text ?? '');
  if (RECALL_TRIGGER_WORDS.some((w) => t.includes(w))) return { hit: true, reason: 'trigger-word' };
  // 日期型问法（"11月3号晚上…"/"2号下午…"/"2026-11-03…"）不再要求用户先说"记得"。
  if (RECALL_DATE_RE.test(t)) return { hit: true, reason: 'trigger-word' };
  if ((Array.isArray(names) ? names : []).some((n) => String(n ?? '').trim() && t.includes(String(n).trim()))) {
    return { hit: true, reason: 'name' };
  }
  return { hit: false, reason: '' };
}

// ── 词法检索（移植 tokenize.js + hippocampus 打分的精华） ─────────────────

const STOP = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '这', '那', '有', '在',
  '和', '与', '也', '就', '都', '很', '吗', '呢', '吧', '啊', '呀', '哦', '嗯',
  'the', 'a', 'an', 'is', 'are', 'was', 'to', 'of', 'and', 'or', 'in', 'on', 'at'
]);

/** 规范化：全角半角、大小写（移植 normText）。 */
function normText(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 切检索 token：ASCII 整词 + 汉字单字/相邻 bigram，滤停用词（移植 tokenize）。 */
function tokenize(text) {
  const s = normText(text);
  if (!s) return [];
  const out = new Set();
  const push = (t) => { if (t && !STOP.has(t) && t.length <= 40) out.add(t); };
  for (const m of s.matchAll(/[a-z0-9_][a-z0-9_.-]*/g)) push(m[0]);
  for (const run of s.match(/[一-鿿㐀-䶿]+/g) || []) {
    for (let i = 0; i < run.length; i++) {
      push(run[i]);
      if (i + 1 < run.length) push(run.slice(i, i + 2));
    }
  }
  return [...out];
}

/** 查询串 → 带权 token（长词权重大；短句整句精确短语加分。移植 queryTokens）。 */
function queryWeights(text) {
  const s = normText(text);
  const weights = new Map();
  for (const t of tokenize(s)) {
    const w = t.length >= 4 ? 2.5 : t.length >= 2 ? 1.5 : 1;
    weights.set(t, Math.max(weights.get(t) || 0, w));
  }
  if (s && s.length >= 2 && s.length <= 24) weights.set(s, 4);
  return weights;
}

/**
 * 一张卡的全部可召回行（行级向量第二批）：kind/speaker/text 三件。
 * 行序按 MemoryCard 协议字段序（events → facts → entry → promises → open_loops → mood），
 * 同分并列时的先现序由本序决定（稳定排序，确定性）；词法行与行级向量共用本函数，
 * 保证"索引的行"与"检索的行"逐字同源。
 * speaker 预埋（v3 D9；默认 null，不参与嵌入——角色前缀实验未实测，不让未验证变量
 * 进本轮验收）。
 * @param {import('../../person/contracts.js').MemoryCard} card
 * @returns {Array<{kind:'event'|'fact'|'entry'|'promise'|'open_loop'|'mood', index:number, speaker:null, text:string}>}
 */
export function cardRows(card) {
  const out = [];
  const counters = new Map();
  const push = (kind, text) => {
    const t = String(text ?? '').trim();
    if (!t) return;
    // index = 同 kind 内的出现序（不是全局序）：删掉前面的 promise/open_loop 不会
    // 让后面的 mood/entry 行键整体漂移，rowKey 更稳定（同日替换只动真正变了的行）。
    const index = counters.get(kind) ?? 0;
    counters.set(kind, index + 1);
    out.push({ kind, index, speaker: null, text: t });
  };
  for (const e of (Array.isArray(card?.events) ? card.events : [])) push('event', e);
  for (const f of (Array.isArray(card?.facts) ? card.facts : [])) push('fact', f?.content);
  push('entry', card?.entry);
  for (const pr of (Array.isArray(card?.promises) ? card.promises : [])) push('promise', pr?.text);
  for (const o of (Array.isArray(card?.open_loops) ? card.open_loops : [])) push('open_loop', o);
  push('mood', card?.mood);
  return out;
}

/** 词法检索行（= cardRows 的 text 列；顺序逐字节一致）。 */
function cardLines(card) {
  return cardRows(card).map((r) => r.text);
}

/**
 * 卡片词法检索（纯函数）：query 与卡行 token 加权重叠打分。
 * @param {string} query
 * @param {Array<import('../../person/contracts.js').MemoryCard>} cardList
 * @param {{limit?: number, maxChars?: number}} [opts]   默认 ≤2 条、每条 ≤60 字（v3 T5.5 口径）
 * @returns {Array<{date: string, text: string, score: number}>}  文本已带"MM-DD "日期前缀并截断
 */
export function retrieveFromCards(query, cardList, { limit = 2, maxChars = 60, minScore = null } = {}) {
  const weights = queryWeights(query);
  if (!weights.size) return [];
  // 注意 Number(null)=0：null 必须走配置下限，不能被当成“显式 0”把 floor 关掉。
  const explicit = minScore !== null && minScore !== undefined && minScore !== '';
  const floor = explicit && Number.isFinite(Number(minScore)) ? Number(minScore) : lexicalFloor();
  const hits = [];
  for (const card of (Array.isArray(cardList) ? cardList : [])) {
    const date = String(card?.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const line of cardLines(card)) {
      const lineTokens = new Set(tokenize(line));
      let score = 0;
      for (const [tok, w] of weights) {
        if (lineTokens.has(tok)) score += w;
      }
      if (score <= 0 || score < floor) continue;
      const dayLabel = date.slice(5);   // YYYY-MM-DD → MM-DD（"带日期"）
      const text = `${dayLabel} ${line}`.slice(0, maxChars);
      hits.push({ date, text, score });
    }
  }
  // 打分降序；同分先看更近的卡（时间升序输入里取后出现的）
  return hits
    .sort((a, b) => b.score - a.score)
    .filter((h, i, arr) => arr.findIndex((x) => x.text === h.text) === i)   // 去重同文本行
    .slice(0, Math.max(0, Number(limit) || 2));
}

// ── 四源 RRF 融合（card-vector 夜2 T2.1 + 第二批行级 T3）──────────────────

const RRF_K = 60;            // Q5 拍板保留 k=60
const FUSE_LEX_DEPTH = 10;   // 词法路供融合的排名深度（bench hybrid 口径 limit=10）

/** RRF 路权重（config.memory.embedding.fuseWeights；非法/缺省 → 1，0 合法）。
 * vector 是 gist/fact 的历史共用键；gist/fact 显式给出时优先（第二批验收调参用）。 */
function fuseWeights() {
  const w = getConfig()?.memory?.embedding?.fuseWeights ?? {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 1);
  const vector = num(w.vector);
  return {
    lexical: num(w.lexical),
    vector,
    row: num(w.row),
    gist: Number.isFinite(Number(w.gist)) ? Number(w.gist) : vector,
    fact: Number.isFinite(Number(w.fact)) ? Number(w.fact) : vector
  };
}

/** 向量行入融合候选的 cosine 下限（config.memory.embedding.vectorFloor；缺省 0.45——
 * 夜2 T2.7 20 题验收实测定值：无关对 <0.40 / 相关对 >0.55 的间隙；换嵌入模型需重测）。 */
function vectorFloor() {
  const v = Number(getConfig()?.memory?.embedding?.vectorFloor);
  return Number.isFinite(v) ? v : 0.45;
}

/** 行级向量入融合候选的 cosine 下限（第二批新增；缺省同 vectorFloor，bench 可覆盖）。 */
function rowFloor() {
  const v = Number(getConfig()?.memory?.embedding?.rowFloor);
  return Number.isFinite(v) ? v : 0.45;
}

/** 词法行入候选的最低 token 重叠分（P11 · 2026-11-20；缺省 2.0）。
 * 2.0 ≈ 至少一个二字词命中；单字闲聊不触发。召回宁缺毋滥。 */
function lexicalFloor() {
  const v = Number(getConfig()?.memory?.embedding?.lexicalFloor);
  return Number.isFinite(v) ? v : 1.5;
}

/** 是否至少有一条向量命中高于各自 floor（P11：bypass 三闸门的前提）。
 * 只看向量源；词法源由 lexicalFloor 在检索时过滤。 */
function hasAboveFloorVector(vectorHits) {
  const floor = vectorFloor();
  const rFloor = rowFloor();
  for (const v of (Array.isArray(vectorHits) ? vectorHits : [])) {
    const score = Number(v?.score) || 0;
    if (v?.kind === 'row') {
      if (score >= rFloor) return true;
    } else if (v?.kind === 'gist' || v?.kind === 'fact') {
      if (score >= floor) return true;
    }
  }
  return false;
}

/**
 * 四源融合（检索行级直出 → 输出层日期聚合；Q2 拍板 + 夜2 T2.7 20 题验收定型，
 * 第二批行级 T3 增加第四源）。
 * 四路候选：词法行（rank = 行名次）× 卡级 gist 行（rank = cosine 名次）× fact 行
 * × 行级向量行（rank = cosine 名次；每条可召回行一条）。
 * 融合序 = 分数降序（稳定）→ 同文去重 → **日期聚合（同一天只保留融合序最优的一行，
 * 该天词法行与任一向量源（gist/row）同源在场时标 'both'）** → 取 top limit。
 * 向量行另有 cosine 下限（vectorFloor / rowFloor）——低相关向量行不入候选，不顶词法命中。
 * 注：Σ 公式（score=Σ w_i/(60+rank_i)）在本候选拓扑下作用于"同一候选出现在多路排名"
 * 的情形；行级直出拓扑下各路候选身份互异（词法行/gist 行/fact 行/行向量），Σ 退化为
 * 单源项——同卡双源命中由坍缩的 'both' 记账承载。实测 Σ-merge 进最优词法行的写法会把
 * 错误卡的 gist 证据灌进词法行（r@2 0.25 vs 行级直出 0.30，见夜2 T2.7 变体分析），
 * 故取行级直出。
 * @param {string} text 查询文本
 * @param {Array<object>} cardList 可见卡（可见性已由接线方过滤）
 * @param {Array<{kind:'gist'|'fact'|'row', date?:string, key?:string, rowKey?:string, text:string, score:number}>} vectorHits
 * @param {{limit?: number, maxChars?: number}} opts
 * @returns {{hits: Array<{date:string,text:string,score:number}>, recallHits: Array<{source:'lexical'|'gist'|'fact'|'row'|'both', date?:string, text:string, score:number}>}}
 */
function fuseRecall(text, cardList, vectorHits, { limit = 2, maxChars = 60, minScore = null } = {}) {
  const { lexical: wLex, row: wRow, gist: wGist, fact: wFact } = fuseWeights();
  const floor = vectorFloor();
  const rFloor = rowFloor();
  // 源一：词法行排名（深度取 FUSE_LEX_DEPTH 供融合；展示行 = 命中行原文）
  const lex = retrieveFromCards(text, cardList, { limit: FUSE_LEX_DEPTH, maxChars, minScore });
  const cands = lex.map((h, i) => ({
    date: h.date, text: h.text, score: wLex / (RRF_K + i + 1), source: 'lexical'
  }));
  // 源二：卡级 gist 行（cosine ≥ floor 才入候选；日期不在可见卡的丢弃——可见性已由
  // 接线方过滤，这里按语料成员再兜一道）；展示概括行（- MM-DD {gist}）。
  const validDates = new Set((Array.isArray(cardList) ? cardList : [])
    .map((c) => String(c?.date ?? '')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  vectorHits
    .filter((v) => v?.kind === 'gist' && String(v?.text ?? '').trim()
      && validDates.has(String(v?.date ?? '')) && (Number(v?.score) || 0) >= floor)
    .sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0))
    .forEach((g, i) => {
      const d = String(g.date);
      cands.push({
        date: d,
        text: `${d.slice(5)} ${String(g?.text ?? '').trim()}`.slice(0, maxChars),
        score: wGist / (RRF_K + i + 1),
        source: 'gist'
      });
    });
  // 源三/四：fact 行 + 行级向量——**共用同一向量排名**（不是各自 rank 1..N）。
  // 依据：bench 行级混合档 0.55/0.80 是"全部行级单元（含 facts）一次向量排序"；
  // 分开排会让每条 fact 在自己的源里拿 rank1（1/61），过度放大 fact、挤掉行级命中。
  // 展示/记账仍按 kind 分别标 fact / row，权重可分别调（缺省同 1）。
  const vectorRows = vectorHits
    .filter((v) => {
      if (v?.kind !== 'row' && v?.kind !== 'fact') return false;
      const text = String(v?.text ?? '').trim();
      if (!text) return false;
      if ((Number(v?.score) || 0) < (v.kind === 'row' ? rFloor : floor)) return false;
      if (v.kind === 'row') return validDates.has(String(v?.date ?? ''));
      return Boolean(String(v?.key ?? '').trim());
    })
    .sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0));
  vectorRows.forEach((v, i) => {
    const isRow = v.kind === 'row';
    const d = isRow ? String(v.date) : '';
    cands.push({
      date: d,
      text: isRow
        ? `${d.slice(5)} ${String(v?.text ?? '').trim()}`.slice(0, maxChars)
        : String(v?.text ?? '').slice(0, maxChars),
      score: (isRow ? wRow : wFact) / (RRF_K + i + 1),
      source: isRow ? 'row' : 'fact'
    });
  });
  // 融合序：分数降序（稳定排序保并列先现序）→ 同文合并。
  // 第二批 T3：**同一条行同时被词法行与行级向量（或 fact 行）命中时，RRF 分数相加**
  // ——与 bench raw hybrid 的 rrf 口径一致；不这样做会让"词法 rank1 的错误行"压过
  // "词法 rank2 + 向量 rank1 的正确行"。gist 概括行与词法行文本不同，永不进入本合并
  //（保留夜2"gist 不灌入词法行"的结论）。
  cands.sort((a, b) => b.score - a.score);
  const byText = new Map();
  for (const c of cands) {
    const prev = byText.get(c.text);
    if (!prev) { byText.set(c.text, { ...c }); continue; }
    const prevHasLex = prev.source === 'lexical' || prev.source === 'both';
    const curHasLex = c.source === 'lexical';
    const curIsVec = c.source === 'row' || c.source === 'fact';
    if ((prevHasLex && curIsVec) || (curHasLex && (prev.source === 'row' || prev.source === 'fact'))) {
      prev.score += c.score;
      prev.source = 'both';
      continue;
    }
    if (c.score > prev.score) byText.set(c.text, { ...c });
  }
  const deduped = [...byText.values()].sort((a, b) => b.score - a.score);
  // 日期聚合（Q2 拍板 / v4.1 澄清⑤）：输出层组行——同一天只保留融合序最优的一行
  //（fact 行无日期，各自成行）；该天词法行与任一向量源（gist/row）同源在场 → 标 'both'。
  // 第二批验收诊断：config.dateCollapse=false 时跳过聚合（bench --no-collapse），
  // 用于对齐 raw hybrid 0.55/0.80 口径；生产默认仍为 true（Q2 拍板不擅自改）。
  const collapseDates = getConfig()?.memory?.embedding?.dateCollapse !== false;
  const collapsed = [];
  if (collapseDates) {
    const rowsByDate = new Map();
    for (const c of deduped) {
      if (c.date) { if (!rowsByDate.has(c.date)) rowsByDate.set(c.date, []); rowsByDate.get(c.date).push(c); }
    }
    const seenDate = new Set();
    for (const c of deduped) {
      if (!c.date) { collapsed.push(c); continue; }
      if (seenDate.has(c.date)) continue;
      seenDate.add(c.date);
      const same = rowsByDate.get(c.date);
      const hasLine = same.some((x) => x.source === 'lexical');
      const hasVector = same.some((x) => x.source === 'gist' || x.source === 'row');
      collapsed.push({ ...c, source: hasLine && hasVector ? 'both' : c.source });
    }
  } else {
    collapsed.push(...deduped);
  }
  const top = collapsed.slice(0, Math.max(0, Number(limit) || 2));
  return {
    hits: top.map(({ date, text, score }) => ({ date, text, score })),
    recallHits: top.map(({ source, date, text, score }) => ({ source, ...(date ? { date } : {}), text, score }))
  };
}

/**
 * 一次召回决策 + 检索的完整入口（骨架公共 API，尾部段接线方调用）。
 * @param {{
 *   text?: string, lastMessageTs?: number, now?: number, names?: string[],
 *   cards?: Array<object>,       // 注入语料（自测/可见性过滤后）；缺省读 person/memory.cards()
 *   vectorHits?: Array<{kind:'gist'|'fact'|'row', date?:string, key?:string, rowKey?:string, text:string, score:number}>,
 *                                // 四源向量路注入（夜2 T2.3 orchestrator 预取缓存组装；
 *                                // 第二批行级 T3 增加 kind:'row'）；
 *                                // 缺省 undefined/空 = 纯词法（与改造前逐字节一致，除语料扩展）
 *   limit?: number, maxChars?: number
 * }} p
 * @returns {{gate: {hit: boolean, reason: string},
 *            hits: Array<{date: string, text: string, score: number}>,
 *            lines: string[],
 *            recallHits: {gate: {hit:boolean, reason:string}, bypassed: boolean, hits: Array<{source:'lexical'|'gist'|'fact'|'row'|'both', date?:string, text:string, score:number}>}}
 *   recallHits 由接线方写入 session.recallHits（M1 承诺兑现；T2.4 四值记账）；
 *   bypassed=true = 闸门未命中但 W4 always 策略放行（vectorHits 命中即注入）。
 */
export function recallForPrompt(p = {}) {
  const gate = recallGate(p);
  // W4 注入策略（embeddingGateMode）：vectorHits 非空（=embedding 开启且预取命中——
  // orchestrator #runAgent 只在 enabled 时组装）且 gateMode='always' → 跳过三闸门
  // （命中即注入）；其余路径（关闭态/预取未热/无命中/strict）闸门照旧——词法兜底与
  // 关闭态行为逐字节不变。bypass 时 gate 记账保持 recallGate 纯函数结果（hit=false
  // 如实记录），注入来源由 recallHits.bypassed 标注。
  // P11（2026-11-20）：bypass 的前提是“至少一条向量命中高于各自 floor”。
  // 原实现只看 vectorHits.length——低分噪声也会跳过三闸门，导致每轮塞无关旧事。
  const bypassGate = embeddingGateMode() === 'always'
    && hasAboveFloorVector(p.vectorHits);
  if (!gate.hit && !bypassGate) return { gate, hits: [], lines: [], recallHits: { gate, bypassed: false, hits: [] } };
  const cardList = Array.isArray(p.cards) ? p.cards : cards();
  const vectorHits = Array.isArray(p.vectorHits) ? p.vectorHits : [];
  if (!vectorHits.length) {
    // 纯词法路（缺省 / 关闭态 / 预取未热 / LM Studio 不在——"拔线退词法"即此路径）：
    // 调用形状与 T2.1 改造前逐字节一致（limit/maxChars 原样透传，不重组不聚合）；
    // 行语料已扩展 entry/promises（对照基线 = tools/fixtures/recall-lexical-snapshot.json）。
    const hits = retrieveFromCards(p.text ?? '', cardList, { limit: p.limit, maxChars: p.maxChars, minScore: p.minScore });
    return {
      gate,
      hits,
      lines: hits.map((h) => `- ${h.text}`),
      recallHits: { gate, bypassed: false, hits: hits.map((h) => ({ source: 'lexical', date: h.date, text: h.text, score: h.score })) }
    };
  }
  // 三源融合路（vectorHits 非空：预取缓存已热 + 开关开启）
  const fused = fuseRecall(p.text ?? '', cardList, vectorHits, { limit: p.limit, maxChars: p.maxChars, minScore: p.minScore });
  return {
    gate,
    hits: fused.hits,
    lines: fused.hits.map((h) => `- ${h.text}`),
    // bypassed = 闸门未命中但 W4 always 策略放行（命中即注入）；记账供 UI/调试溯源。
    recallHits: { gate, bypassed: bypassGate && !gate.hit, hits: fused.recallHits }
  };
}
