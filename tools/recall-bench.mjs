// 20 题召回基准（card-vector 夜0 T0.3 收编版）
//
// 来源：实测报告 内部文档 card-vector-embed-bench-20261115.md §2.3（题型设计）+ %TEMP%\qqagent-embed-bench\embed-bench.mjs
// （临时脚本会被系统清理，本文件是其仓库内恢复版；评分口径/指标定义逐行对齐原稿）。
// fixture：tools/fixtures/recall-bench-20q.json（20 题 + gold，题型 lex 9 / para 6 / loose 3 / time 2）。
//
// 用法（cwd=代码根，Git Bash）：
//   # 词法模式（默认；离线零模型调用；词法基线走真实 recall.js —— bench 纪律：不得重写）
//   XUNXI_DATA_DIR=<数据根绝对路径> node tools/recall-bench.mjs
//   # 向量 / 混合模式（POST /v1/embeddings → LM Studio 本机 127.0.0.1:1234；计划内 embed 调用，零云端）
//   XUNXI_DATA_DIR=<数据根绝对路径> node tools/recall-bench.mjs --mode hybrid --instruct qwen
//   # 显式语料根（文件直读，不经 person API；对照语料/沙箱用）
//   node tools/recall-bench.mjs --data <数据根绝对路径>
//   # 机器可读输出（夜 2 T2.7 开启态验收跑分比对用）
//   ... --json tools/fixtures/recall-bench-last-run.json
//
// 语料口径：person API（src/person/memory.js 的 cards()/facts()）受 XUNXI_DATA_DIR 控制数据根；
// --data 显式给出时改走文件直读。基准语料 = 13 卡 + 17 active 事实 = 129 行级检索单元（报告 §1）。
// 输出口径："MM-DD " + 行文[:60]（报告 §2.4；与 recall.js retrieveFromCards 输出一致）。
// 指标：recall@2（主指标）/ recall@5 / MRR。基准数字（报告 §3.1）：
//   词法 0.40/0.65/0.490 · Qwen3 带前缀 0.55/0.75/0.652 · 混合(带前缀) 0.55/0.75/0.660 · 混合(无前缀) recall@5=0.80。
//
// 夜 2 接线点（T2.7 本版落地）：--mode index-hybrid 读 data/index/ 容器（夜1 T1.6 card-index.js
// JSON 容器，--backfill 产出）——query 侧现场嵌入（prefix 同 --instruct 口径），文档向量直接用
// 容器存量（零重嵌），向量路 = cardIndex.search(queryVec) 映射（与 orchestrator #runAgent 同口径），
// 融合 = 真实 recallForPrompt({vectorHits})（与生产完全同链路，闸门用固定冷启动时钟）。
// 嵌入失败（LM Studio 不在/拔线）→ vectorHits 空 → 纯词法：即"拔线退词法"验收路径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { retrieveFromCards, recallForPrompt } from '../src/capabilities/reflection/recall.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'recall-bench-20q.json');

const argv = process.argv.slice(2);
const args = Object.fromEntries(
  argv.join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')])
    .filter(([k]) => k)
);
const MODE = args.mode || 'lexical';                       // lexical | vector | hybrid | index-hybrid
const DATA = args.data || '';                              // 显式语料根（文件直读）；空 = person API
const ENDPOINT = args.endpoint || 'http://127.0.0.1:1234';
const MODEL = args.model || 'text-embedding-qwen3-embedding-0.6b';
const INSTRUCT = args.instruct || 'qwen';                  // qwen | qwen-en | none（qwen = query 侧加计划前缀）
const LIMIT = Number(args.limit || 10);                    // 词法 rank 深度（原 bench 口径）
const MAX_CHARS = Number(args['max-chars'] || 60);
const JSON_OUT = args.json || '';                          // 文件路径或 '-'（stdout）
// 第二批行级向量（T4 验收）：--no-rows = 退回三源对照；--row-weight / --row-floor
// 仅本进程覆盖（setRuntimeConfig），不改磁盘 config.json。
const NO_ROWS = args['no-rows'] !== undefined;
const ROW_WEIGHT = args['row-weight'] !== undefined ? Number(args['row-weight']) : null;
const ROW_FLOOR = args['row-floor'] !== undefined ? Number(args['row-floor']) : null;
const VECTOR_WEIGHT = args['vector-weight'] !== undefined ? Number(args['vector-weight']) : null;
const GIST_WEIGHT = args['gist-weight'] !== undefined ? Number(args['gist-weight']) : null;
const FACT_WEIGHT = args['fact-weight'] !== undefined ? Number(args['fact-weight']) : null;
const NO_ENTRY = args['no-entry'] !== undefined;   // 诊断：行级源排除 entry（对齐 bench 129 单元口径）
const NO_COLLAPSE = args['no-collapse'] !== undefined;   // 诊断：跳过同日聚合（对齐 raw hybrid 口径）

// 计划 §3.2 queryInstruction（中文文案；实测报告 §5.3 称英文/中文效果无差——夜0 复测：
// 中文前缀 0.35/0.75 vs 英文前缀 0.55/0.75，recall@2 差 4 题，§5.3"无差"结论在本语料不成立，见交接 drift）
const QUERY_INSTRUCTION = 'Instruct: 给定一段对话记忆检索任务，检索与查询语义相关的记忆卡\nQuery: ';
// 原 bench（报告 §3.1 数字）的英文前缀，收编留档用于精确复现
const QUERY_INSTRUCTION_EN = 'Instruct: Given a query in Chinese, retrieve relevant memory passages that a personal AI companion should recall\nQuery: ';
const PREFIX = {
  none: { query: (s) => s, doc: (s) => s },
  qwen: {
    query: (s) => QUERY_INSTRUCTION + s,
    doc: (s) => s
  },
  'qwen-en': {
    query: (s) => QUERY_INSTRUCTION_EN + s,
    doc: (s) => s
  }
};
const pf = PREFIX[INSTRUCT] || PREFIX.none;

// ── 语料读取 ──────────────────────────────────────────────────────────────
function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // 剥 BOM（纪律）
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (o && typeof o === 'object') out.push(o); } catch { /* 坏行跳过 */ }
  }
  return out;
}
function loadCardsFromDir(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
  const out = [];
  for (const f of files) for (const c of readJsonl(path.join(dir, f))) if (/^\d{4}-\d{2}-\d{2}$/.test(c?.date || '')) out.push(c);
  return out;
}

async function loadCorpus() {
  if (DATA) {
    // 文件直读口径（原 bench 行为；不触发 config.js 的数据根推导）
    const cards = loadCardsFromDir(path.join(DATA, 'person', 'cards'));
    const facts = readJsonl(path.join(DATA, 'person', 'facts.jsonl')).filter((f) => (f?.status ?? 'active') === 'active');
    return { cards, facts, source: `--data ${DATA}` };
  }
  // person API 口径：数据根由 config.js 的 XUNXI_DATA_DIR 决定（import 期已定）
  const { cards, facts } = await import('../src/person/memory.js');
  return { cards: cards(), facts: facts({ status: 'active' }), source: 'person-api(XUNXI_DATA_DIR)' };
}

// 行级检索单元（评测口径与报告一致：events/facts/promises/open_loops/mood + facts.jsonl）
function buildDocs(cardsList, factsList) {
  const docs = [];
  const push = (card, role, lines) => {
    lines.forEach((text, idx) => {
      const t = String(text ?? '').trim();
      if (t) docs.push({ id: `c:${card.date}:${role}:${idx}`, kind: 'card', date: card.date, role, text: t, line: t });
    });
  };
  for (const card of cardsList) {
    push(card, 'event', Array.isArray(card.events) ? card.events : []);
    push(card, 'fact', (Array.isArray(card.facts) ? card.facts : []).map((f) => f?.content));
    push(card, 'promise', (Array.isArray(card.promises) ? card.promises : []).map((p) => p?.text));
    push(card, 'open_loop', Array.isArray(card.open_loops) ? card.open_loops : []);
    push(card, 'mood', [card.mood]);
  }
  for (const f of factsList) {
    const t = String(f.content ?? '').trim();
    if (t) docs.push({ id: `f:${f.key}`, kind: 'fact', role: `factfile:${f.kind}`, date: '', text: t, line: t });
  }
  return docs;
}

// ── 嵌入调用（LM Studio OpenAI 兼容端点；已归一化 → 余弦 = 点积） ────────────
async function embedBatch(inputs) {
  const res = await fetch(`${ENDPOINT}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: inputs }),
    signal: AbortSignal.timeout(180000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const arr = Array.isArray(data?.data) ? data.data : [];
  if (arr.length !== inputs.length) throw new Error(`返回 ${arr.length} 条 / 请求 ${inputs.length} 条`);
  return arr.map((d) => d.embedding.map(Number));
}
const cosine = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

// ── 指标（口径对齐原 bench / 报告 §3.1） ─────────────────────────────────────
function isGold(doc, gold) {
  if (gold.type === 'fact') return (doc.kind === 'fact' || doc.role === 'fact') && doc.text.includes(gold.contains);
  if (gold.type === 'role') return doc.role === gold.role && (!gold.date || doc.date === gold.date);
  return doc.kind === 'card' && doc.date === gold.date && doc.text.includes(gold.contains);
}
function formatHit(doc) {
  const day = doc.date ? doc.date.slice(5) : '';
  return (day ? `${day} ${doc.line}` : doc.line).slice(0, MAX_CHARS);
}
function evaluate(rankings) {
  let r2 = 0; let r5 = 0; let mrr = 0; const misses = [];
  for (const item of rankings) {
    const i = item.rank.findIndex((d) => d && item.gold.some((g) => isGold(d, g)));
    if (i === 0) { r2++; r5++; mrr++; }
    else if (i > 0) { if (i < 5) r5++; mrr += 1 / (i + 1); }
    else misses.push(item.q);
  }
  const n = rankings.length || 1;
  return { n: rankings.length, 'recall@2': +(r2 / n).toFixed(3), 'recall@5': +(r5 / n).toFixed(3), mrr: +(mrr / n).toFixed(3), misses };
}
function rrf(idA, idB, k = 60) {
  const s = new Map();
  for (const id of idA) s.set(id, (s.get(id) || 0) + 1 / (k + idA.indexOf(id) + 1));
  for (const id of idB) s.set(id, (s.get(id) || 0) + 1 / (k + idB.indexOf(id) + 1));
  return [...s.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
}

// ── 主流程 ────────────────────────────────────────────────────────────────
let fixture;
{
  let text = fs.readFileSync(FIXTURE, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // 剥 BOM（纪律）
  fixture = JSON.parse(text);
}
const EVAL_SET = fixture.questions;
if (!Array.isArray(EVAL_SET) || EVAL_SET.length !== 20) {
  console.error(`[bench] fixture 异常：期望 20 题，读到 ${EVAL_SET?.length ?? 0} 题（${FIXTURE}）`);
  process.exit(1);
}

const { cards: cardList, facts: factList, source } = await loadCorpus();
if (!cardList.length) {
  console.error('[bench] 语料为空：cards() 读到 0 张卡。请设置 XUNXI_DATA_DIR 指向真实数据根，或用 --data 显式指定。');
  process.exit(1);
}
const docs = buildDocs(cardList, factList);
console.log(`[bench] 语料（${source}）：${cardList.length} 卡 + ${factList.length} 事实 → ${docs.length} 检索单元；评测题 ${EVAL_SET.length} 道`);
console.log(`[bench] 模式=${MODE} · instruct=${INSTRUCT} · model=${MODEL} · limit=${LIMIT} · maxChars=${MAX_CHARS}`);

// 词法基线：真实 recall.js（bench 纪律 2——不得重写）
const lexRank = EVAL_SET.map((e) => retrieveFromCards(e.q, cardList, { limit: LIMIT, maxChars: MAX_CHARS }).map((h) => {
  const full = docs.find((d) => d.date === h.date && formatHit(d) === h.text);
  return full || { id: `lex:${h.date}:${h.text.slice(0, 20)}`, kind: 'card', date: h.date, role: 'lex', text: h.text, line: h.text };
}));

// ── 夜2 T2.7：index-hybrid（真实索引容器 + 真实 recallForPrompt 融合链路）──────────────
// 融合命中回映 bench 文档：词法行按 (date, "MM-DD 行文[:60]") 匹配；gist 概括行不在行级
// 语料里 → 合成 doc（kind:'card'/role:'gist'，gold 判定照 isGold 规则走——不含 gold 片段
// 即不命中，诚实口径：卡级概括行对行级 gold 的覆盖缺口如实计分）。
const mapHitToDoc = (h) => {
  const full = docs.find((d) => (d.date || '') === (h.date || '') && formatHit(d) === h.text);
  if (full) return full;
  const isCard = Boolean(h.date);
  return {
    id: `fused:${isCard ? h.date : 'fact'}:${h.text.slice(0, 16)}`,
    kind: isCard ? 'card' : 'fact',
    date: h.date || '',
    role: isCard ? 'gist' : 'fact',
    text: isCard ? h.text.slice(6) : h.text,
    line: isCard ? h.text.slice(6) : h.text
  };
};

let fusedRank = [];
let fusedErr = '';
let fusedNote = '';
if (MODE === 'index-hybrid') {
  const { cardIndex } = await import('../src/capabilities/reflection/card-index.js');
  if (ROW_WEIGHT !== null || ROW_FLOOR !== null || VECTOR_WEIGHT !== null
    || GIST_WEIGHT !== null || FACT_WEIGHT !== null || NO_COLLAPSE) {
    const configMod = await import('../src/config.js');
    const cfg = configMod.getConfig();
    const baseWeights = cfg.memory?.embedding?.fuseWeights ?? {};
    const weightPatch = {
      ...baseWeights,
      ...(ROW_WEIGHT !== null ? { row: ROW_WEIGHT } : {}),
      ...(VECTOR_WEIGHT !== null ? { vector: VECTOR_WEIGHT } : {}),
      ...(GIST_WEIGHT !== null ? { gist: GIST_WEIGHT } : {}),
      ...(FACT_WEIGHT !== null ? { fact: FACT_WEIGHT } : {})
    };
    const hasWeightPatch = ROW_WEIGHT !== null || VECTOR_WEIGHT !== null || GIST_WEIGHT !== null || FACT_WEIGHT !== null;
    configMod.setRuntimeConfig({
      ...cfg,
      memory: {
        ...cfg.memory,
        embedding: {
          ...(cfg.memory?.embedding ?? {}),
          ...(hasWeightPatch ? { fuseWeights: weightPatch } : {}),
          ...(ROW_FLOOR !== null ? { rowFloor: ROW_FLOOR } : {}),
          ...(NO_COLLAPSE ? { dateCollapse: false } : {})
        }
      }
    });
    console.log(`[bench] 行级覆盖（仅本进程）：rowWeight=${ROW_WEIGHT ?? 'default'} rowFloor=${ROW_FLOOR ?? 'default'} vectorWeight=${VECTOR_WEIGHT ?? 'default'} gistWeight=${GIST_WEIGHT ?? 'default'} factWeight=${FACT_WEIGHT ?? 'default'} dateCollapse=${NO_COLLAPSE ? 'off' : 'default'}`);
  }
  const st = cardIndex.stats();
  console.log(`[bench] 索引容器：gists=${st.gists} facts=${st.facts} rows=${st.rows} lag=${JSON.stringify(st.lag)} meta=${JSON.stringify(st.meta)}`);
  try {
    const t0 = Date.now();
    const qv = await embedBatch(EVAL_SET.map((e) => pf.query(e.q)));
    console.log(`[bench] index-hybrid：${EVAL_SET.length} 条 query 嵌入耗时 ${Date.now() - t0}ms（prefix=${INSTRUCT}；文档向量读容器零重嵌；rows=${NO_ROWS ? 'off' : 'on'}）`);
    const FIXED_NOW = Date.parse('2026-11-15T22:00:00+08:00');
    const COLD_TS = FIXED_NOW - 4 * 60 * 60 * 1000;   // 冷启动闸门（与快照同口径固定时钟）
    for (let qi = 0; qi < EVAL_SET.length; qi++) {
      const res = cardIndex.search(qv[qi]);
      const vectorHits = [
        ...(res.gists || []).map((g) => ({ kind: 'gist', date: String(g.date ?? ''), text: String(g.gist ?? ''), score: Number(g.score) || 0 })),
        ...(res.facts || []).map((f) => ({ kind: 'fact', key: String(f.key ?? ''), text: String(f.text ?? ''), score: Number(f.score) || 0 })),
        ...(!NO_ROWS && Array.isArray(res.rows) ? res.rows
          .filter((r) => !NO_ENTRY || r?.kind !== 'entry')
          .map((r) => ({
            kind: 'row', date: String(r.date ?? ''), rowKey: String(r.rowKey ?? ''),
            text: String(r.text ?? ''), score: Number(r.score) || 0
          })) : [])
      ];
      const rec = recallForPrompt({
        text: EVAL_SET[qi].q, lastMessageTs: COLD_TS, now: FIXED_NOW,
        cards: cardList, vectorHits, limit: LIMIT, maxChars: MAX_CHARS
      });
      fusedRank.push(rec.hits.map(mapHitToDoc));
    }
  } catch (err) {
    fusedErr = String(err?.message ?? err);
    fusedNote = 'embed 失败（LM Studio 不在/拔线）→ vectorHits 空 → 纯词法（退词法路径，验收 ②）';
    console.error(`[bench] index-hybrid 嵌入失败：${fusedErr}`);
    console.error(`[bench] ${fusedNote}`);
    fusedRank = lexRank.slice();   // 退词法：与词法路同排名（全链路退词法的证明）
  }
}

// 向量路（--mode vector|hybrid；失败不阻塞词法档输出，但退出码非 0）
let embRank = [];
let vecErr = '';
if (MODE === 'vector' || MODE === 'hybrid') {
  try {
    const t0 = Date.now();
    const [dv, qv] = await Promise.all([
      embedBatch(docs.map((d) => pf.doc(d.text))),
      embedBatch(EVAL_SET.map((e) => pf.query(e.q)))
    ]);
    console.log(`[bench] dim=${dv[0].length} · ${docs.length}+${EVAL_SET.length} 条耗时 ${Date.now() - t0}ms`);
    for (let qi = 0; qi < EVAL_SET.length; qi++) {
      embRank.push(docs.map((d, di) => ({ d, s: cosine(qv[qi], dv[di]) })).sort((a, b) => b.s - a.s).map((x) => x.d));
    }
  } catch (err) {
    vecErr = err.message;
    console.error(`[bench] 嵌入失败：${vecErr}`);
  }
}

// 混合（RRF k=60，报告 §0/D3 口径）
const byId = new Map(docs.map((d) => [d.id, d]));
const hybRank = (MODE === 'hybrid' && embRank.length)
  ? EVAL_SET.map((_, qi) => rrf(lexRank[qi].map((d) => d.id), embRank[qi].map((d) => d.id)).map((id) => byId.get(id)).filter(Boolean))
  : [];

const mk = (rank) => EVAL_SET.map((e, i) => ({ q: e.q, gold: e.gold, rank: rank[i] || [] }));
const rows = [['lexical', evaluate(mk(lexRank))]];
if (embRank.length) rows.push(['vector', evaluate(mk(embRank))]);
if (hybRank.length) rows.push(['hybrid', evaluate(mk(hybRank))]);
if (fusedRank.length) rows.push(['index-hybrid', evaluate(mk(fusedRank))]);

console.log(`\n=== 汇总（${EVAL_SET.length} 道题，recall@2 为主指标）===`);
console.table(rows.map(([tag, r]) => ({ 方案: tag, 'recall@2': r['recall@2'], 'recall@5': r['recall@5'], MRR: r.mrr })));

console.log('\n=== 分题型 recall@2 ===');
const byTag = {};
for (const e of EVAL_SET) (byTag[e.tag] ||= []).push(e);
console.table(Object.entries(byTag).map(([tag, list]) => {
  const sub = (rank) => {
    if (!rank.length) return '—';
    const idx = list.map((e) => EVAL_SET.indexOf(e));
    return evaluate(idx.map((i) => ({ q: EVAL_SET[i].q, gold: EVAL_SET[i].gold, rank: rank[i] || [] })))['recall@2'];
  };
  const row = { 题型: tag, 题数: list.length, 词法: sub(lexRank) };
  if (embRank.length) row.嵌入 = sub(embRank);
  if (hybRank.length) row.混合 = sub(hybRank);
  if (fusedRank.length) row.融合 = sub(fusedRank);
  return row;
}));

console.log('\n=== 逐题首位命中 ===');
const perQuestion = [];
for (let i = 0; i < EVAL_SET.length; i++) {
  const e = EVAL_SET[i];
  const entry = { id: e.id, q: e.q, tag: e.tag };
  const mark = (rank) => {
    const top = rank?.[0];
    const ok = top ? e.gold.some((g) => isGold(top, g)) : false;
    return { hit: ok, top: top ? formatHit(top) : '(无)' };
  };
  entry.lexical = mark(lexRank[i]);
  if (embRank.length) entry.vector = mark(embRank[i]);
  if (hybRank.length) entry.hybrid = mark(hybRank[i]);
  if (fusedRank.length) entry['index-hybrid'] = mark(fusedRank[i]);
  perQuestion.push(entry);
  console.log(`[${e.tag}] ${e.q}`);
  console.log(`   词法 ${entry.lexical.hit ? 'OK ' : 'X  '} ${entry.lexical.top}`);
  if (entry.vector) console.log(`   嵌入 ${entry.vector.hit ? 'OK ' : 'X  '} ${entry.vector.top}`);
  if (entry.hybrid) console.log(`   混合 ${entry.hybrid.hit ? 'OK ' : 'X  '} ${entry.hybrid.top}`);
  if (entry['index-hybrid']) console.log(`   融合 ${entry['index-hybrid'].hit ? 'OK ' : 'X  '} ${entry['index-hybrid'].top}`);
}

console.log('\n[bench] 未命中题目（词法）：', JSON.stringify(evaluate(mk(lexRank)).misses));
if (embRank.length) console.log('[bench] 未命中题目（嵌入）：', JSON.stringify(evaluate(mk(embRank)).misses));
if (hybRank.length) console.log('[bench] 未命中题目（混合）：', JSON.stringify(evaluate(mk(hybRank)).misses));
if (fusedRank.length) console.log('[bench] 未命中题目（index-hybrid 融合）：', JSON.stringify(evaluate(mk(fusedRank)).misses));

if (JSON_OUT) {
  const payload = {
    fixture: path.relative(path.join(HERE, '..'), FIXTURE),
    corpus: { source, cards: cardList.length, facts: factList.length, docs: docs.length },
    mode: MODE, instruct: INSTRUCT, model: MODEL, endpoint: ENDPOINT,
    indexHybrid: MODE === 'index-hybrid' ? {
      error: fusedErr || null,
      note: fusedNote || null,
      noRows: NO_ROWS,
      rowWeight: ROW_WEIGHT,
      rowFloor: ROW_FLOOR,
      vectorWeight: VECTOR_WEIGHT,
      gistWeight: GIST_WEIGHT,
      factWeight: FACT_WEIGHT,
      noEntry: NO_ENTRY,
      noCollapse: NO_COLLAPSE
    } : undefined,
    results: Object.fromEntries(rows.map(([tag, r]) => [tag, { recallAt2: r['recall@2'], recallAt5: r['recall@5'], mrr: r.mrr, misses: r.misses }])),
    perTag: Object.fromEntries(Object.entries(byTag).map(([tag, list]) => {
      const idx = list.map((e) => EVAL_SET.indexOf(e));
      const sub = (rank) => rank.length ? evaluate(idx.map((i) => ({ q: EVAL_SET[i].q, gold: EVAL_SET[i].gold, rank: rank[i] || [] })))['recall@2'] : null;
      return [tag, { n: list.length, lexical: sub(lexRank), vector: embRank.length ? sub(embRank) : null, hybrid: hybRank.length ? sub(hybRank) : null, indexHybrid: fusedRank.length ? sub(fusedRank) : null }];
    })),
    perQuestion
  };
  const text = JSON.stringify(payload, null, 2) + '\n';
  if (JSON_OUT === '-') console.log('\n---JSON---\n' + text);
  else { fs.writeFileSync(JSON_OUT, text, 'utf8'); console.log(`[bench] JSON 已写 ${JSON_OUT}`); }
}

process.exit((MODE === 'vector' || MODE === 'hybrid') && vecErr ? 1 : 0);   // index-hybrid 拔线退词法是验收路径，exit 0（fusedNote 记录口径）
