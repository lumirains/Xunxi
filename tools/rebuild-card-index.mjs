#!/usr/bin/env node
// rebuild-card-index.mjs —— 记忆卡向量索引维护工具（card-vector 夜1 T1.8 · 计划 §3.7）。
//
// "修索引数据永远不存在，只有重建。"——LM Studio 没开的夜晚索引滞后，一条命令补齐。
//
// 用法（cwd=代码根，Git Bash；数据根必须显式指到真实数据根）：
//   XUNXI_DATA_DIR=<数据根绝对路径> node tools/rebuild-card-index.mjs --stats
//   XUNXI_DATA_DIR=<数据根绝对路径> node tools/rebuild-card-index.mjs --backfill
//   XUNXI_DATA_DIR=<数据根绝对路径> node tools/rebuild-card-index.mjs --rebuild
//   XUNXI_DATA_DIR=<数据根绝对路径> node tools/rebuild-card-index.mjs --gist-backfill
//
// 四个子命令（计划 §3.7）：
//   --stats          观测面：行数 / 真身对照 / 滞后量 / 模型与维度 / 最后 backfill。零模型调用。
//   --backfill       增量：全卡 syncCard（gist hash 未变跳过、行级按 cardRows 行集 diff、
//                    无 gist 跳过）+ 全部 active 事实 syncFact（upsert + 对账修剪）。
//                    只调 embed() → LM Studio（本机零云端）。
//   --rebuild        清表全量重建（rebuildFromApi：gist/facts/rows；幂等）。只调 embed()。
//   --gist-backfill  ⚠️ 存量卡补 gist：对**无 gist 的卡**做**一次批量 chat 调用**
//                    （chatCompletionFully，走配置的 chat provider——执行纪律修订点 2b，
//                    可能是云端烧 token；生产默认 cfg.api，与 executor 巩固同源口径），
//                    产出 {date, gist, keywords} 经 memory.writeCard（唯一写者）落回卡，
//                    再逐卡 syncCard 建向量。已有 gist 的卡跳过（增量）。
//
// ⚠️ 嵌入开关口径（执行纪律 9）：memory.embedding.enabled 在磁盘 config.json 恒保持
//    false（缺省关闭态=系统行为零变化）。本工具对需要嵌入的子命令在**本进程内**临时
//    开启（setRuntimeConfig，仅本进程内存态）——磁盘配置与应用行为零触碰。索引是
//    派生物，本工具写 data/index/（唯一写者 card-index.js）与经 person API 补写卡
//    （--gist-backfill），不动 facts.jsonl。
//
// 成本口径：--backfill/--rebuild = 本机 LM Studio 零 token；--gist-backfill = 一次批量
// chat 调用（13 卡 ≈ 8KB 输入 / ~1KB 输出量级），provider 见 data/config.json 的
// api.provider（2026-11-15 实读 = custom_mwa6my8gssd4 "Google Gemini"，云端）。
import { getConfig, setRuntimeConfig } from '../src/config.js';
import { cardIndex, stampBackfill } from '../src/capabilities/reflection/card-index.js';
import * as memory from '../src/person/memory.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const MODE = has('--gist-backfill') ? 'gist-backfill'
  : has('--rebuild') ? 'rebuild'
  : has('--backfill') ? 'backfill'
  : has('--stats') ? 'stats'
  : '';

if (!MODE || argv.filter((a) => a.startsWith('--')).length > 1) {
  console.error('用法：node tools/rebuild-card-index.mjs --stats | --backfill | --rebuild | --gist-backfill（单选一）');
  console.error('     数据根：XUNXI_DATA_DIR 必须显式指向真实数据根（默认 <app>/data 非生产数据根）');
  process.exit(2);
}

/** 本进程内临时开启嵌入（仅内存态；磁盘 config.json 零触碰——纪律 9 口径，见文件头）。 */
function enableEmbeddingInProcess() {
  const cfg = getConfig();
  setRuntimeConfig({
    ...cfg,
    memory: {
      ...cfg.memory,
      embedding: { ...(cfg.memory?.embedding ?? {}), enabled: true }
    }
  });
}

/** 嵌入通道预检：一发 document 探针。拿不到向量 → LM Studio 未开/配置缺失，退出。 */
async function preflightEmbed() {
  const { embed } = await import('../src/llm.js');
  const vec = await embed('document', 'card-index preflight ping');
  if (!Array.isArray(vec) || !vec.length) {
    console.error('[card-index] 嵌入通道不可用（LM Studio 未启动 / provider 配置缺失）——索引保持滞后，补齐请启动 http://127.0.0.1:1234 后重跑');
    return false;
  }
  const cfg = getConfig();
  console.log(`[card-index] 嵌入通道 OK：provider=${cfg.memory?.embedding?.provider} model=${cfg.memory?.embedding?.model} dim=${vec.length}`);
  return true;
}

/** 卡片材料 → 补 gist 批量任务的 user 段（一卡一段；entry 截 400 字防任务膨胀）。 */
function renderCardMaterial(card) {
  const lines = [`【${card.date}】`];
  if (card.entry) lines.push(String(card.entry).slice(0, 400));
  for (const e of (Array.isArray(card.events) ? card.events : []).slice(0, 12)) lines.push(`- ${String(e).slice(0, 80)}`);
  for (const f of (Array.isArray(card.facts) ? card.facts : []).slice(0, 8)) lines.push(`- 事实：${String(f?.content ?? '').slice(0, 80)}`);
  for (const p of (Array.isArray(card.promises) ? card.promises : []).slice(0, 4)) lines.push(`- 约定：${String(p?.text ?? '').slice(0, 80)}`);
  if (card.mood) lines.push(`- 心情：${String(card.mood).slice(0, 40)}`);
  return lines.join('\n');
}

/**
 * 存量卡补 gist：一次批量 chat 调用（纪律修订点 2b——⚠️ 走配置 chat provider，可能云端烧 token）。
 * 返回 {date, gist, keywords} 数组（解析失败抛错给调用方）。
 */
async function generateGists(cards) {
  const { chatCompletionFully } = await import('../src/llm.js');
  const cfg = getConfig();
  const provider = (cfg.providers || []).find((p) => p?.id === cfg.api?.provider);
  console.log(`[card-index] --gist-backfill 成本口径：chat provider=${cfg.api?.provider}（${provider?.displayName ?? '?'}，baseURL=${provider?.baseURL ?? cfg.api?.baseUrl ?? '?'}）model=${cfg.api?.model} ——一次批量调用 ${cards.length} 张卡`);
  const system = [
    '你是记忆整理者。给定的每一张记忆卡都缺两样东西：gist（一句话概括）与 keywords（可检索关键词）。',
    '规则（与写卡协议同源）：',
    '1. gist=一句话概括这一天，≤40 字，用卡片主人的口吻（卡片主人是聊天机器人「她」自己，对话里的对方是她的主人），抓住当天最要紧的一件事或一种心情——是浓缩，不是把正文搅拌压缩。',
    '2. keywords=5-10 个可检索词，从日记正文与事实里挑（人名、称呼、做过的事、事物名……以后凭这些词能想起这一天），不要凑数。',
    '3. 只依据卡片自带的材料（entry/events/facts/promises/mood），绝不编造材料之外的内容。',
    '4. 只输出一个 JSON 数组，不要任何解释文字或 markdown 代码块，形如：',
    '   [{"date":"YYYY-MM-DD","gist":"…","keywords":["…","…"]}]',
    '   数组按输入顺序，每张卡一个元素，date 原样抄写。'
  ].join('\n');
  const user = [
    cards.map(renderCardMaterial).join('\n\n'),
    '请为以上每张卡输出 gist 与 keywords（JSON 数组）。'
  ].join('\n\n');
  const t0 = Date.now();
  const result = await chatCompletionFully({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.3,
    maxTokens: 2000
  });
  const raw = (Array.isArray(result?.message?.content)
    ? result.message.content.map((p) => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('')
    : String(result?.message?.content ?? '')).trim();
  const usage = result?.usage ?? {};
  console.log(`[card-index] 批量调用完成（${Date.now() - t0}ms，finish=${result?.finishReason ?? '?'}，truncated=${Boolean(result?.truncated)}，usage=${JSON.stringify(usage)}）`);
  if (!raw) throw new Error('chat 输出为空');
  let text = raw;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error(`chat 输出中没有 JSON 数组（前 120 字：${text.slice(0, 120)}）`);
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('解析结果不是数组');
  return arr
    .filter((x) => x && typeof x === 'object' && String(x?.date ?? '').trim())
    .map((x) => ({
      date: String(x.date).trim(),
      gist: String(x.gist ?? '').trim().slice(0, 40),
      keywords: (Array.isArray(x.keywords) ? x.keywords : []).map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 10)
    }))
    .filter((x) => x.gist);
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const cfg = getConfig();
console.log(`[card-index] 数据根=${process.env.XUNXI_DATA_DIR || '(默认 <app>/data)'} · 磁盘 enabled=${cfg.memory?.embedding?.enabled ?? '(缺省 false)'} · mode=${MODE}`);
cardIndex.open();

if (MODE === 'stats') {
  console.log(JSON.stringify(cardIndex.stats(), null, 2));
  process.exit(0);
}

// 需要嵌入的三个子命令：进程内临时开启（磁盘配置零触碰）→ 预检
enableEmbeddingInProcess();
if (!(await preflightEmbed())) process.exit(1);

if (MODE === 'rebuild') {
  const t0 = Date.now();
  const r = await cardIndex.rebuildFromApi();
  stampBackfill();
  console.log(`[card-index] --rebuild 完成（${Date.now() - t0}ms）：gist ${r.gists}/${r.cards} 卡（有 gist ${r.cards ? '真身含 gist 卡数见 --stats' : '-'}）· rows ${r.rows} 行 · facts ${r.facts}/${r.activeFacts} active`);
  console.log(JSON.stringify(cardIndex.stats(), null, 2));
  process.exit(0);
}

if (MODE === 'backfill') {
  const t0 = Date.now();
  const cards = memory.cards();
  let cardDone = 0;
  let cardSkipped = 0;
  const noGistDates = [];
  const rowStats = { added: 0, updated: 0, removed: 0, skipped: 0 };
  for (const card of cards) {
    const r = await cardIndex.syncCard(card);
    if (r?.rows) {
      rowStats.added += Number(r.rows.added) || 0;
      rowStats.updated += Number(r.rows.updated) || 0;
      rowStats.removed += Number(r.rows.removed) || 0;
      rowStats.skipped += Number(r.rows.skipped) || 0;
    }
    // gist hash 未变但行集有变（卡片正文/行文本变化）也算处理过——避免"行级已更新"
    // 被记成"整卡跳过"。
    const rowsTouched = Boolean(r?.rows && (r.rows.added || r.rows.updated || r.rows.removed));
    if (r?.ok && (!r.skipped || rowsTouched)) cardDone += 1;
    else cardSkipped += 1;
    if (r?.skipped === 'no-gist') noGistDates.push(String(card?.date ?? '?'));   // 旧格式卡：提示去 --gist-backfill
  }
  const facts = memory.facts({ status: 'active' });
  let factDone = 0;
  let pruned = 0;
  for (const f of facts) {
    const r = await cardIndex.syncFact(f);
    if (r?.ok) { factDone += 1; pruned += Number(r.pruned) || 0; }
  }
  stampBackfill();
  console.log(`[card-index] --backfill 完成（${Date.now() - t0}ms）：卡 ${cards.length} 张（嵌入 ${cardDone} / 跳过 ${cardSkipped}，跳过=hash 未变/无 gist/无向量）· 行级 +${rowStats.added}/~${rowStats.updated}/-${rowStats.removed}（跳过 ${rowStats.skipped}）· 事实 ${facts.length} 条 active（嵌入 ${factDone}，对账修剪 ${pruned} 行）`);
  if (noGistDates.length) console.log(`[card-index] 无 gist 未登记的卡 ${noGistDates.length} 张（${noGistDates.join(', ')}）——要建卡级向量请先 --gist-backfill`);
  console.log(JSON.stringify(cardIndex.stats(), null, 2));
  process.exit(0);
}

// --gist-backfill：无 gist 的存量卡 → 一次批量 chat → 落回卡（唯一写者 memory.writeCard）→ 逐卡建向量
const noGist = memory.cards().filter((c) => !String(c?.gist ?? '').trim());
if (!noGist.length) {
  console.log('[card-index] 所有卡已有 gist——无需补（增量语义）。要重建向量请用 --backfill / --rebuild。');
  console.log(JSON.stringify(cardIndex.stats(), null, 2));
  process.exit(0);
}
console.log(`[card-index] 待补 gist 的卡：${noGist.length} 张（${noGist.map((c) => c.date).join(', ')}）`);
let generated;
try {
  generated = await generateGists(noGist);
} catch (err) {
  console.error(`[card-index] gist 批量生成失败：${err?.message ?? err}——卡片与索引未改动（写回只在解析成功后发生）`);
  process.exit(1);
}
const byDate = new Map(noGist.map((c) => [String(c.date), c]));
let written = 0;
let synced = 0;
for (const g of generated) {
  const card = byDate.get(g.date);
  if (!card) { console.warn(`[card-index] 输出日期 ${g.date} 不在待补清单——跳过（不落卡）`); continue; }
  // 唯一写者 person/memory.writeCard（同日替换）；spread 保留 writtenAt——历史卡补 gist
  // 不改"过期"判据（executor.cardStale 口径不变）
  memory.writeCard({ ...card, gist: g.gist, keywords: g.keywords });
  written += 1;
  const r = await cardIndex.syncCard(memory.cards({ from: g.date, to: g.date })[0]);
  if (r?.ok) synced += 1;
  else console.warn(`[card-index] ${g.date} gist 已落卡但向量未建（${r?.skipped ?? '未知'}）——可稍后 --backfill 补齐`);
}
stampBackfill();
console.log(`[card-index] --gist-backfill 完成：落卡 ${written}/${noGist.length} · 向量 ${synced}/${written}（未建向量者 --backfill 补齐）`);
console.log(JSON.stringify(cardIndex.stats(), null, 2));
process.exit(0);
