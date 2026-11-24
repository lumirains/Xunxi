// 记忆卡向量索引（card-vector 夜1 T1.6 · 计划 §3.3 + 第二批行级 T1）——
// 三层派生索引的唯一写者。
//
// 定位（计划 §0 non-goals 铁律）：
//   · 索引是**派生物**：真身 = xunxi.db cards 表 + facts 表（storage-v2 起；此前为
//     data/person/cards/*.jsonl + facts.jsonl）；
//     本模块只经 person API（memory.cards()/facts()）读真身，绝不直写真身；
//     整目录 data/index/ 可随时删除重建（rebuildFromApi / tools/rebuild-card-index.mjs）。
//   · 软依赖：嵌入失败只 console.warn 不抛错——调用方（executor 写入点）一律
//     fire-and-forget，索引滞后由 stats() 可见、rebuild 兜底，绝不影响巩固/聊天主链路。
//   · 不做 ANN、不做网络重试、不做队列（计划 §3.3 纪律）：gist/rows 五年版百条
//     向量，暴力点积毫秒级。
//
// 容器（D2/D6）：JSON，`<DATA_DIR>/index/card-index.json` 单文件三"表"：
//   gists（卡级，键 = 卡日期，同日替换 = upsert）/ facts（键 = fact key，生命周期
//   同步：supersede → 对账修剪删除）/ rows（行级，第二批：键 = `${date}|${kind}|${i}`，
//   同日替换按 rowKey 做行集 diff）/ meta（embed_model / dim / last_rebuild /
//   last_backfill / last_row_backfill，模型或维度不一致 → 自动清表）。
//   接口（本文件导出的七件 API）保留 SQLite 收编路径（storage-layer-v2 另案）。
//   体积参照（实测报告 §3.3 / 计划 Q4）：13 卡 gist ≈60KB；行级 129 单元 ≈3MB。
//
// 纪律：
//   · DATA_DIR 延迟取值（media-store.js:32-35 先例——测试经 XUNXI_DATA_DIR（旧名 QQ_AGENT_DATA_DIR 兼容）重定向，
//     沙箱可隔离，本模块路径每次经 indexDir() 现取，不在模块加载期定死）；
//   · 写入一律 tmp + rename 原子写（与 person/ 同纪律，进程中断不留半截文件）；
//   · 读 JSON 剥 BOM；坏文件按空状态兜底（派生物，重建即愈）；
//   · llm.js 动态 import（diary.js:467 先例——import 期零网络零模型调用）；
//   · 进程内状态缓存按文件 mtime（version）失效——跨进程改动（rebuild 工具）自动重载。
//
// API（计划 §3.3；cardIndex 聚合导出）：
//   open()                     确保目录/读状态，返回概要（幂等，可重复调）
//   syncCard(card)             gist 向量 + 行级向量 upsert：gist 嵌入输入 = gist + 关键词 +
//                              mood；行级按 cardRows 做同日行集 diff（hash 未变跳过）；
//                              无 gist 跳过登记（旧格式/兜底卡）
//   syncFact(fact)             fact 向量 upsert + **对账修剪**（v4.1 终审修正③：读
//                              facts({status:'active'}) key 集合删孤儿向量行——
//                              memory.upsertFact 不回报被顶替的 key，对账让索引自愈，
//                              不动 person/memory 唯一写者签名）
//   search(queryVec)           暴力点积（向量已 L2 归一化→余弦=点积），降序三路返回
//   rebuildFromApi()           读 person API 全量清表重建；幂等
//   stats()                    行数 / 真身对照 / 滞后量 / 模型与维度 / 时间戳
//   prefetchQuery(chatKey, text)  kind:'query' 嵌入 + chatKey 级缓存（TTL 10min、容量 8）；
//                              "单飞"在本函数内实现：同 chatKey 在途嵌入被新文本原子替换
//                              （夜2 orchestrator submit 预取用；peekQuery 读缓存）
//
// 本文件不 import 身体模块（check-boundaries 扫 src/capabilities/**）；import 面 =
// config / person/memory / recall（行枚举同源）/ llm（动态 import）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from '../../config.js';
import * as memory from '../../person/memory.js';
// 行级索引（第二批 T1/T3）：行枚举与 recall.js 的词法行同源，保证"索引的行"与
// "检索的行"逐字一致（cardRows 是本模块唯一的行来源）。
import { cardRows } from './recall.js';

const INDEX_VERSION = 1;
const QUERY_TTL_MS = 10 * 60 * 1000;   // 计划 §3.3：chatKey 级查询缓存 TTL 10min
const QUERY_CACHE_MAX = 8;             // 容量 8（超限逐出最旧）

// ── 路径（DATA_DIR 延迟取值，media-store.js 先例）───────────────────────────
function indexDir() {
  return path.join(DATA_DIR, 'index');
}
function indexFile() {
  return path.join(indexDir(), 'card-index.json');
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex');
}

function emptyState() {
  return {
    version: INDEX_VERSION,
    meta: { embed_model: '', dim: 0, last_rebuild: 0, last_backfill: 0, last_row_backfill: 0 },
    gists: {},   // [date] = { date, gist, keywords, mood, content_hash, embedding, embed_model, dim, written_at }
    facts: {},   // [key]  = { key, text, content_hash, embedding, embed_model, dim }
    // 行级向量（第二批 T1）：[rowKey] = { rowKey, date, kind, speaker, text, content_hash,
    // embedding, embed_model, dim, written_at }；rowKey = `${date}|${kind}|${index}`，
    // index 是该卡 cardRows 序（与词法行同序）。同日替换按 rowKey 对齐做行集 diff。
    rows: {}
  };
}

// ── 状态读写（进程内缓存，mtime = 失效 version）─────────────────────────────
let cache = null;   // { mtimeMs, state }

function loadState() {
  const file = indexFile();
  let mtimeMs = -1;   // -1 = 文件不存在
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* 缺文件按空状态 */ }
  if (cache && cache.mtimeMs === mtimeMs) return cache.state;
  let state = emptyState();
  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    if (parsed && typeof parsed === 'object' && Number(parsed.version) === INDEX_VERSION
      && parsed.gists && typeof parsed.gists === 'object' && !Array.isArray(parsed.gists)
      && parsed.facts && typeof parsed.facts === 'object' && !Array.isArray(parsed.facts)) {
      state = {
        version: INDEX_VERSION,
        meta: { ...emptyState().meta, ...(parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {}) },
        gists: parsed.gists,
        facts: parsed.facts,
        // 旧容器（夜1/夜2 产物）没有 rows 键：按空表兜底，--backfill 补建；
        // 不因缺键判坏文件（派生物向后兼容）。
        rows: (parsed.rows && typeof parsed.rows === 'object' && !Array.isArray(parsed.rows))
          ? parsed.rows : {}
      };
    }
  } catch { /* 坏 JSON：空状态（派生物，rebuild 兜底） */ }
  cache = { mtimeMs, state };
  return state;
}

function saveState(state) {
  const file = indexFile();
  fs.mkdirSync(indexDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, file);   // 原子写：进程中断不留半截文件
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* stat 失败下次 loadState 会重读 */ }
  cache = { mtimeMs, state };
}

/** 嵌入模型/维度变更 → 自动清表（计划 §3.3 index_meta 机制；backfill 全量重嵌为已知成本）。 */
function ensureModel(state, model, dim) {
  if (state.meta.embed_model
    && (state.meta.embed_model !== model || Number(state.meta.dim) !== Number(dim))) {
    console.warn(`[card-index] 嵌入模型/维度变更（${state.meta.embed_model}/dim=${state.meta.dim} → ${model}/dim=${dim}）——索引自动清表，待 rebuild/backfill 重嵌`);
    state.gists = {};
    state.facts = {};
    state.rows = {};
  }
  state.meta.embed_model = model;
  state.meta.dim = Number(dim) || 0;
}

function currentEmbeddingModel() {
  return String(getConfig()?.memory?.embedding?.model ?? '').trim();
}

/** 卡级嵌入输入（计划 §3.3）：gist + '\n关键词：' + keywords.join(' ') + '\n' + mood（空段省略）。 */
function cardEmbedInput(card) {
  const parts = [String(card?.gist ?? '').trim()];
  const keywords = (Array.isArray(card?.keywords) ? card.keywords : [])
    .map((k) => String(k ?? '').trim()).filter(Boolean);
  if (keywords.length) parts.push(`关键词：${keywords.join(' ')}`);
  const mood = String(card?.mood ?? '').trim();
  if (mood) parts.push(mood);
  return parts.filter(Boolean).join('\n');
}

async function embedDocument(text) {
  // 动态 import（diary.js:467 先例）：import 期零网络零模型调用；embed 失败返回 null
  const { embed } = await import('../../llm.js');
  return embed('document', text);
}

// ── 七件 API ───────────────────────────────────────────────────────────────

/** 确保索引目录在位并读状态（幂等）。返回 { dir, gists, facts, meta }。 */
export function open() {
  fs.mkdirSync(indexDir(), { recursive: true });
  const state = loadState();
  return {
    dir: indexDir(),
    gists: Object.keys(state.gists).length,
    facts: Object.keys(state.facts).length,
    rows: Object.keys(state.rows).length,
    meta: { ...state.meta }
  };
}

/**
 * 行级向量同步（第二批 T1）：按 rowKey 对同日行集做 diff。
 * - 行文本 hash + 同模型 + 同维度未变 → 只更新元数据；
 * - 新增/变更行 → embed；失败跳过（保留旧行，不丢整卡索引）；
 * - 卡里消失的行 → 删除；
 * - 关闭态由 syncCard 提前返回，不会进本函数。
 * @returns {Promise<{added:number, updated:number, removed:number, skipped:number}>}
 */
async function syncCardRows(state, card, model) {
  const date = String(card?.date ?? '');
  const expected = cardRows(card).map((r) => ({
    rowKey: `${date}|${r.kind}|${r.index}`,
    date,
    kind: r.kind,
    speaker: r.speaker ?? null,
    text: r.text,
    content_hash: sha1(r.text)
  }));
  const prevRows = Object.values(state.rows).filter((r) => r?.date === date);
  const prevByKey = new Map(prevRows.map((r) => [r.rowKey, r]));
  const nextKeys = new Set(expected.map((r) => r.rowKey));
  let added = 0;
  let updated = 0;
  let removed = 0;
  let skipped = 0;
  for (const row of expected) {
    const prev = prevByKey.get(row.rowKey);
    const unchanged = prev && prev.content_hash === row.content_hash
      && prev.embed_model === model && Array.isArray(prev.embedding)
      && Number(prev.dim) === Number(state.meta.dim || prev.dim);
    if (unchanged) {
      state.rows[row.rowKey] = { ...prev, text: row.text, kind: row.kind, speaker: row.speaker, written_at: Date.now() };
      continue;
    }
    const vec = await embedDocument(row.text);
    if (!Array.isArray(vec) || !vec.length) { skipped += 1; continue; }
    ensureModel(state, model, vec.length);   // 可能清表：清后当前行再落新向量
    state.rows[row.rowKey] = { ...row, embedding: vec, embed_model: model, dim: vec.length, written_at: Date.now() };
    if (prev) updated += 1; else added += 1;
  }
  for (const prev of prevRows) {
    if (!nextKeys.has(prev.rowKey) && state.rows[prev.rowKey]) {
      delete state.rows[prev.rowKey];
      removed += 1;
    }
  }
  return { added, updated, removed, skipped };
}

/**
 * 卡级 gist 向量 + 行级向量 upsert。嵌入输入 = gist + 关键词 + mood；content_hash
 * （sha1）未变 → 只更新元数据不烧嵌入；无 gist（旧格式卡/兜底卡）→ 跳过登记；嵌入
 * 拿不到（关闭态/服务不在）→ 跳过（滞后 stats 可见）。行级向量按 cardRows 做同日
 * 行集 diff（第二批 T1）。绝不抛错——调用方 fire-and-forget。
 * @param {import('../../person/contracts.js').MemoryCard} card
 * @returns {Promise<{ok?: boolean, date?: string, dim?: number, skipped?: string, gist?: string, rows?: {added:number,updated:number,removed:number,skipped:number}}>}
 */
export async function syncCard(card) {
  try {
    const date = String(card?.date ?? '');
    const gist = String(card?.gist ?? '').trim();
    if (!gist) return { skipped: 'no-gist', date };           // 计划 §3.3：无 gist → 跳过登记
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { skipped: 'bad-date', date };
    // 关闭态：gist/rows 都不写（embed 直接 null；提前返回也避免行集 diff 误删旧行）
    if (!getConfig()?.memory?.embedding?.enabled) return { skipped: 'disabled', date };
    const input = cardEmbedInput(card);
    const hash = sha1(input);
    const model = currentEmbeddingModel();
    const state = loadState();
    const prev = state.gists[date];
    const gistUnchanged = Boolean(prev && prev.content_hash === hash
      && prev.embed_model === model && Array.isArray(prev.embedding));
    let gistSkipped = false;
    if (gistUnchanged) {
      // hash 未变（同模型）：只更新元数据，不烧嵌入（幂等零成本）
      prev.gist = gist;
      prev.keywords = (Array.isArray(card?.keywords) ? card.keywords : []).map((k) => String(k ?? '').trim()).filter(Boolean);
      prev.mood = String(card?.mood ?? '').trim();
      prev.written_at = Date.now();
    } else {
      const vec = await embedDocument(input);
      if (!Array.isArray(vec) || !vec.length) {
        gistSkipped = true;
      } else {
        ensureModel(state, model, vec.length);   // 可能清表——prev 引用随之失效，重取
        state.gists[date] = {
          date,
          gist,
          keywords: (Array.isArray(card?.keywords) ? card.keywords : []).map((k) => String(k ?? '').trim()).filter(Boolean),
          mood: String(card?.mood ?? '').trim(),
          content_hash: hash,
          embedding: vec,
          embed_model: model,
          dim: vec.length,
          written_at: Date.now()
        };
      }
    }
    const rows = await syncCardRows(state, card, model);
    saveState(state);
    return {
      ok: !gistSkipped,
      date,
      dim: state.meta.dim,
      ...(gistSkipped ? { skipped: 'no-embed' } : (gistUnchanged ? { skipped: 'hash' } : {})),
      gist: gistSkipped ? 'skipped' : (gistUnchanged ? 'hash' : 'embedded'),
      rows
    };
  } catch (err) {
    console.warn('[card-index] syncCard 失败（跳过，滞后由 stats 可见）:', err?.message ?? err);
    return { skipped: 'error' };
  }
}

/**
 * fact 向量 upsert + 对账修剪。superseded/已不 active 的 key 不建向量；每次调用后
 * 读 facts({status:'active'}) 的 key 集合，删除不在集合内的向量行（孤儿自愈——
 * supersede 发生在 memory.upsertFact 内部重写，唯一写者签名零触碰）。
 * @param {{key: string, content: string}} fact 落盘后的 Fact（executor 传 memory.upsertFact 的返回值）
 */
export async function syncFact(fact) {
  try {
    const key = String(fact?.key ?? '').trim();
    const text = String(fact?.content ?? '').trim();
    if (!key || !text) return { skipped: 'bad-fact', key };
    const state = loadState();
    const model = currentEmbeddingModel();
    // 对账基准先行：不 active 的 key 不建向量，只走修剪
    const activeKeys = new Set(memory.facts({ status: 'active' })
      .map((f) => String(f?.key ?? '')).filter(Boolean));
    const prune = () => {
      let pruned = 0;
      for (const k of Object.keys(state.facts)) {
        if (!activeKeys.has(k)) { delete state.facts[k]; pruned += 1; }
      }
      return pruned;
    };
    if (!activeKeys.has(key)) {
      const pruned = prune();
      if (pruned) saveState(state);
      return { skipped: 'not-active', key, pruned };
    }
    const hash = sha1(text);
    const prev = state.facts[key];
    if (!(prev && prev.content_hash === hash && prev.embed_model === model && Array.isArray(prev.embedding))) {
      const vec = await embedDocument(text);
      if (!Array.isArray(vec) || !vec.length) return { skipped: 'no-embed', key };
      ensureModel(state, model, vec.length);
      state.facts[key] = { key, text, content_hash: hash, embedding: vec, embed_model: model, dim: vec.length };
    }
    const pruned = prune();
    saveState(state);
    return { ok: true, key, pruned };
  } catch (err) {
    console.warn('[card-index] syncFact 失败（跳过，滞后由 stats 可见）:', err?.message ?? err);
    return { skipped: 'error' };
  }
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

/**
 * 暴力点积检索（向量已 L2 归一化 → 余弦 = 点积）。返回
 * { gists:[{date,gist,score}], facts:[{key,text,score}], rows:[{rowKey,date,kind,text,score}] }
 * 三路各自降序。维度不一致的行跳过（模型换轨瞬间的旧行不参与）。
 * @param {number[]} queryVec query 侧向量（llm.embed('query', text)）
 */
export function search(queryVec) {
  const q = (Array.isArray(queryVec) ? queryVec : []).map(Number).filter((n) => Number.isFinite(n));
  const empty = { gists: [], facts: [], rows: [] };
  if (!q.length) return empty;
  const state = loadState();
  const rank = (rows, pick) => Object.values(rows)
    .filter((r) => Array.isArray(r?.embedding) && r.embedding.length === q.length)
    .map((r) => ({ ...pick(r), score: dot(q, r.embedding) }))
    .sort((a, b) => b.score - a.score);
  return {
    gists: rank(state.gists, (r) => ({ date: r.date, gist: r.gist })),
    facts: rank(state.facts, (r) => ({ key: r.key, text: r.text })),
    rows: rank(state.rows, (r) => ({ rowKey: r.rowKey, date: r.date, kind: r.kind, text: r.text }))
  };
}

/**
 * 读 person API 全量清表重建（幂等；"修索引数据永远不存在，只有重建"）。无 gist 的卡
 * 跳过登记（--gist-backfill 补齐后重建即得卡级向量）。嵌入失败的条目跳过（滞后可见）。
 */
export async function rebuildFromApi() {
  const state = emptyState();
  const cardList = memory.cards();
  const factList = memory.facts({ status: 'active' });
  let gists = 0;
  let rowsDone = 0;
  let factsDone = 0;
  for (const card of cardList) {
    const date = String(card?.date ?? '');
    const input = cardEmbedInput(card);
    if (!input) continue;   // 无 gist（旧格式卡）
    const vec = await embedDocument(input);
    if (!Array.isArray(vec) || !vec.length) continue;
    const model = currentEmbeddingModel();
    ensureModel(state, model, vec.length);
    state.gists[date] = {
      date,
      gist: String(card?.gist ?? '').trim(),
      keywords: (Array.isArray(card?.keywords) ? card.keywords : []).map((k) => String(k ?? '').trim()).filter(Boolean),
      mood: String(card?.mood ?? '').trim(),
      content_hash: sha1(input),
      embedding: vec,
      embed_model: model,
      dim: vec.length,
      written_at: Date.now()
    };
    gists += 1;
    // 行级（第二批 T1）：每卡可召回行逐条嵌入；行序与 recall.cardRows 同源。
    const cardRowList = cardRows(card);
    for (const row of cardRowList) {
      const rvec = await embedDocument(row.text);
      if (!Array.isArray(rvec) || !rvec.length) continue;
      const rmodel = currentEmbeddingModel();
      ensureModel(state, rmodel, rvec.length);
      const rowKey = `${date}|${row.kind}|${row.index}`;
      state.rows[rowKey] = {
        rowKey,
        date,
        kind: row.kind,
        speaker: row.speaker ?? null,
        text: row.text,
        content_hash: sha1(row.text),
        embedding: rvec,
        embed_model: rmodel,
        dim: rvec.length,
        written_at: Date.now()
      };
      rowsDone += 1;
    }
  }
  for (const f of factList) {
    const key = String(f?.key ?? '').trim();
    const text = String(f?.content ?? '').trim();
    if (!key || !text) continue;
    const vec = await embedDocument(text);
    if (!Array.isArray(vec) || !vec.length) continue;
    const model = currentEmbeddingModel();
    ensureModel(state, model, vec.length);
    state.facts[key] = { key, text, content_hash: sha1(text), embedding: vec, embed_model: model, dim: vec.length };
    factsDone += 1;
  }
  state.meta.last_rebuild = Date.now();
  state.meta.last_row_backfill = state.meta.last_rebuild;
  saveState(state);
  return { gists, facts: factsDone, rows: rowsDone, cards: cardList.length, activeFacts: factList.length };
}

/** 观测面（计划 §3.3 + 第二批）：行数 / 真身对照 / 滞后量（API 有而索引没有）/ 模型与维度 / 时间戳。 */
export function stats() {
  const state = loadState();
  const cardList = memory.cards();
  const factList = memory.facts({ status: 'active' });
  const cardsWithGist = cardList.filter((c) => String(c?.gist ?? '').trim()).length;
  const lagGists = cardList
    .filter((c) => String(c?.gist ?? '').trim() && !state.gists[String(c?.date ?? '')]).length;
  const lagFacts = factList.filter((f) => !state.facts[String(f?.key ?? '')]).length;
  // 行级滞后：与 gist 同口径——只统计有 gist 的卡（无 gist 卡按约定不建行向量）；
  // expected 行的 rowKey 与 syncCardRows 的生成规则逐字一致。
  const expectedRowKeys = [];
  for (const c of cardList) {
    if (!String(c?.gist ?? '').trim()) continue;
    const date = String(c?.date ?? '');
    cardRows(c).forEach((r) => expectedRowKeys.push(`${date}|${r.kind}|${r.index}`));
  }
  const lagRows = expectedRowKeys.filter((k) => !state.rows[k]).length;
  return {
    gists: Object.keys(state.gists).length,
    facts: Object.keys(state.facts).length,
    rows: Object.keys(state.rows).length,
    cards: cardList.length,
    cardsWithGist,
    cardsRows: expectedRowKeys.length,
    activeFacts: factList.length,
    lag: { gists: lagGists, facts: lagFacts, rows: lagRows },
    meta: { ...state.meta }
  };
}

// ── 预取（夜2 orchestrator 接线用；夜1 先落实现 + 单飞语义）──────────────────
const queryCache = new Map();        // chatKey → { text, vec, at }
const prefetchInflight = new Map();  // chatKey → ticket（同 chatKey 单飞：新文本原子替换）
let prefetchSeq = 0;

/**
 * kind:'query' 嵌入 + chatKey 级缓存（TTL 10min、容量 8）。"单飞"在本函数内：
 * 同 chatKey 在途嵌入被新文本原子替换（last-write-wins——只有仍是最新请求的嵌入
 * 才写缓存）。失败/关闭态返回 null（缓存保持原样），绝不抛错。
 * @param {string} chatKey 会话键
 * @param {string} text 查询文本（submit 入库的那条用户消息）
 */
export async function prefetchQuery(chatKey, text) {
  const key = String(chatKey ?? '');
  const t = String(text ?? '').trim();
  if (!key || !t) return null;
  const { embed } = await import('../../llm.js');
  const ticket = (prefetchSeq += 1);
  prefetchInflight.set(key, ticket);
  const vec = await embed('query', t);
  if (prefetchInflight.get(key) !== ticket) return null;   // 已被更新的文本取代
  prefetchInflight.delete(key);
  if (!Array.isArray(vec) || !vec.length) return null;
  const now = Date.now();
  for (const [k, v] of queryCache) {
    if (now - v.at > QUERY_TTL_MS) queryCache.delete(k);   // TTL 过期清理
  }
  if (!queryCache.has(key) && queryCache.size >= QUERY_CACHE_MAX) {
    queryCache.delete(queryCache.keys().next().value);     // Map 保序：逐出最旧
  }
  queryCache.set(key, { text: t, vec, at: now });
  return vec;
}

/** 读 chatKey 预取缓存（夜2 #runAgent 组装前取 vectorHits 用）；未热/过期返回 null。 */
export function peekQuery(chatKey) {
  const hit = queryCache.get(String(chatKey ?? ''));
  if (!hit) return null;
  if (Date.now() - hit.at > QUERY_TTL_MS) {
    queryCache.delete(String(chatKey ?? ''));
    return null;
  }
  return hit;
}

/**
 * 登记一次 backfill 时间戳（tools/rebuild-card-index.mjs 专用簿记——stats() 观测面的
 * "最后 backfill"；不是容器七件接口的一部分，工具侧显式调用）。
 */
export function stampBackfill(ts = Date.now()) {
  const state = loadState();
  const when = Number(ts) || Date.now();
  state.meta.last_backfill = when;
  state.meta.last_row_backfill = when;
  saveState(state);
}

/** 聚合导出（executor/工具单一 import 口）。 */
export const cardIndex = {
  open,
  syncCard,
  syncFact,
  search,
  rebuildFromApi,
  stats,
  prefetchQuery,
  peekQuery
};
