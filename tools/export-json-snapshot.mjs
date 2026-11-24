#!/usr/bin/env node
// export-json-snapshot.mjs —— storage v2 全库 JSON 快照导出（plan D8 / §7-V5；执行清单 T4.5）
//
// 用途（plan D8「JSONL 导出命令作为备份/检视格式——文件世界的『幽灵保留』」）：
//   备份 / 人工检视 / 未来公开时的数据可携性。把 xunxi.db 全部业务表导出为**原文件形态**
//   快照（迁移前的相对路径镜像）：单对象 .json（indent=1，文件时代 writeRaw 口径）、
//   追加账本 .jsonl（一行一条紧凑 JSON；diary 行 = json 列原文，近乎逐字节还原）。
//
// 用法（数据根动作显式带 XUNXI_DATA_DIR——与 migrate-storage-v2 同纪律）：
//   XUNXI_DATA_DIR=<数据根绝对路径> node tools/export-json-snapshot.mjs
//   XUNXI_DATA_DIR=… node tools/export-json-snapshot.mjs --out D:/somewhere/snapshot
//
// 口径：
//   · 只读：对 DB 全程只 SELECT（readonly 连接），对源数据根零写入（导出目录缺省在
//     数据根下 json-snapshot-<时间戳>/，拒绝覆盖已存在目录）；
//   · 形状 = 模块映射层读回形态（messages-map/memory-map/state-map/diary-map）——
//     与 API 返回逐字节同源，导出物可直接 diff 迁移前归档；
//   · 缺表/缺行 → 对应文件跳过并在 index.json 登记（空库可导出为空快照）；
//   · 非业务表（meta/FTS 虚表）不导出（meta 是精确计数器元数据，消息文件形态已含
//     nextLocalId；FTS 是派生索引，M1 才消费）。
//
// 退出码：0 成功；1 用法/环境错误；2 导出中途失败（已写文件保留，供人工检视）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
function fail(msg, code = 1) {
  console.error(`[export-snapshot] ${msg}`);
  process.exit(code);
}
let outArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out' || a.startsWith('--out=')) {
    outArg = a.includes('=') ? a.slice('--out='.length) : argv[++i];
    if (!outArg) fail('--out 需要一个目录参数');
  } else {
    fail(`未知参数：${a}`);
  }
}

const DATA_ROOT = process.env.XUNXI_DATA_DIR || '';
if (!DATA_ROOT) fail('必须显式设置 XUNXI_DATA_DIR（数据根动作显式化纪律）——例：XUNXI_DATA_DIR=<数据根绝对路径> node tools/export-json-snapshot.mjs');
if (!fs.existsSync(DATA_ROOT)) fail(`数据根不存在：${DATA_ROOT}`);
const DB_FILE = path.join(DATA_ROOT, 'xunxi.db');
if (!fs.existsSync(DB_FILE)) fail(`数据库不存在：${DB_FILE}（先完成 migrate-storage-v2 迁移）`);

// 输出目录：--out 显式指定，否则数据根下带时间戳的新目录（拒绝覆盖）
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = outArg ? path.resolve(outArg) : path.join(DATA_ROOT, `json-snapshot-${stamp}`);
if (fs.existsSync(OUT_DIR)) fail(`输出目录已存在（拒绝覆盖）：${OUT_DIR}——换 --out 或清理后重试`);
fs.mkdirSync(OUT_DIR, { recursive: true });

// readonly 连接：导出绝不写库（WAL 只读并发安全）
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(DB_FILE, { readonly: true });

const { MESSAGE_COLUMNS, rowToEntry } = await import('../src/storage/messages-map.js');
const { FACT_COLUMNS, rowToFact, CARD_COLUMNS, rowToCard, STAGING_COLUMNS, rowToStaging } = await import('../src/storage/memory-map.js');
const { DIARY_COLUMNS } = await import('../src/storage/diary-map.js');

const index = { generatedAt: new Date().toISOString(), dbFile: DB_FILE, outDir: OUT_DIR, files: [] };
const counts = {};

function tableRows(table, orderBy, cols) {
  return db.prepare(`SELECT ${cols.join(', ')} FROM ${table}${orderBy ? ` ORDER BY ${orderBy}` : ''}`).all();
}

/** 单对象 .json（indent=1——文件时代 writeRaw/atomicWrite 的落盘口径）。 */
function writeJson(rel, obj) {
  const abs = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(obj, null, 1), 'utf8');
  index.files.push({ rel, kind: 'json', bytes: fs.statSync(abs).size });
}

/** 追加账本 .jsonl（一行一条紧凑 JSON + \n 行尾——文件时代 appendFileSync 口径）。 */
function writeJsonl(rel, lines) {
  const abs = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (lines.length ? '\n' : ''), 'utf8');
  index.files.push({ rel, kind: 'jsonl', entries: lines.length, bytes: fs.statSync(abs).size });
  counts[rel] = lines.length;
}

try {
  // ── messages/main.json（原 store.js ChatStore 形态：chatKey/nextLocalId/messages）──
  const msgRows = tableRows('messages', 'seq', MESSAGE_COLUMNS);
  const metaGet = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null;
  const chatKey = metaGet('chatKey') ?? 'main';
  const nextLocalIdRaw = metaGet('nextLocalId');
  writeJson('messages/main.json', {
    chatKey,
    nextLocalId: nextLocalIdRaw !== null ? Number(nextLocalIdRaw) : (msgRows.length ? Math.max(...msgRows.map((r) => r.id)) + 1 : 1),
    messages: msgRows.map(rowToEntry)
  });

  // ── person/facts.jsonl（rowid 序 = 插入序 = 文件序）──
  const factRows = tableRows('facts', 'rowid', FACT_COLUMNS);
  writeJsonl('person/facts.jsonl', factRows.map(rowToFact));

  // ── person/cards/YYYY-MM.jsonl（rowid 序 = 月文件序×行序；按 date 月份归位）──
  const cardRows = tableRows('cards', 'rowid', CARD_COLUMNS);
  const cardsByMonth = new Map();
  for (const row of cardRows) {
    const month = `${String(row.date).slice(0, 7)}.jsonl`;
    if (!cardsByMonth.has(month)) cardsByMonth.set(month, []);
    cardsByMonth.get(month).push(rowToCard(row));
  }
  if (cardRows.length) {
    for (const month of [...cardsByMonth.keys()].sort()) writeJsonl(`person/cards/${month}`, cardsByMonth.get(month));
  }

  // ── person/staging/YYYY-MM-DD.jsonl（day,seq 序 = 日文件行序）──
  const stagingRows = tableRows('staging', 'day, seq', STAGING_COLUMNS);
  const stagingByDay = new Map();
  for (const row of stagingRows) {
    if (!stagingByDay.has(row.day)) stagingByDay.set(row.day, []);
    stagingByDay.get(row.day).push(rowToStaging(row));
  }
  for (const day of [...stagingByDay.keys()].sort()) writeJsonl(`person/staging/${day}.jsonl`, stagingByDay.get(day));

  // ── person/diary.jsonl（id 序 = 文件行序；行 = json 列原文——迁移存 seg 原样，
  //    导出近乎逐字节还原；API 新写行 = 写入方序列化，与文件时代行内容同源）──
  const diaryRows = tableRows('diary', 'id', ['id', ...DIARY_COLUMNS]);
  writeJsonl('person/diary.jsonl', diaryRows.map((r) => String(r.json)));

  // ── person/{mind,relationship,self,life}.json（state 表四 key；indent=1 文件形态）──
  for (const key of ['mind', 'relationship', 'self', 'life']) {
    const row = db.prepare('SELECT json FROM state WHERE key = ?').get(key);
    if (!row) continue;   // 缺行（未写过）→ 文件跳过，与文件时代「无文件」一致
    writeJson(`person/${key}.json`, JSON.parse(String(row.json)));
  }

  // ── reminders.json / transition（kv 表两 k）──
  for (const k of ['reminders', 'transition']) {
    const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
    if (!row) continue;
    writeJson(k === 'reminders' ? 'reminders.json' : 'transition/main.json', JSON.parse(String(row.v)));
  }

  // ── index.json（快照清单：行数/字节/缺项登记——备份完整性的自查锚点）──
  index.counts = {
    messages: msgRows.length,
    facts: factRows.length,
    cards: cardRows.length,
    staging: stagingRows.length,
    diary: diaryRows.length,
    state: db.prepare('SELECT COUNT(*) AS n FROM state').get().n,
    kv: db.prepare('SELECT COUNT(*) AS n FROM kv').get().n
  };
  const indexAbs = path.join(OUT_DIR, 'index.json');
  fs.writeFileSync(indexAbs, JSON.stringify(index, null, 1), 'utf8');
} finally {
  db.close();
}

console.log('═'.repeat(96));
console.log(`storage v2 JSON 快照导出完成 → ${OUT_DIR}`);
console.log(`行数: messages=${index.counts.messages} facts=${index.counts.facts} cards=${index.counts.cards} staging=${index.counts.staging} diary=${index.counts.diary} state=${index.counts.state} kv=${index.counts.kv}`);
for (const f of index.files) console.log(`  ${f.rel.padEnd(36)} ${f.kind.padEnd(5)} ${(f.entries ?? '-').toString().padStart(5)} 条  ${f.bytes} B`);
console.log('═'.repeat(96));
console.log('[export-snapshot] 只读导出：DB 零写入、数据根零改动；导出物为原文件形态（可 diff 迁移前归档）。');
