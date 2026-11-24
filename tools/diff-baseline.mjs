// diff-baseline.mjs —— Phase 0 基线对比（重构执行清单-细化.md T0.3）
//
// 用法：node tools/diff-baseline.mjs [old.json] <new.json>
//   · old 缺省为 tools/baseline.json；new 必填。
//   · 无差异 → stdout 打 `BASELINE IDENTICAL`，exit 0；
//   · 有差异 → 逐条打印，exit 2；
//   · 用法/读取错误（文件缺失、JSON 坏）→ exit 1。
//
// 报告五类差异：
//   1. sysHash / usrHash 变化（含会话只在单侧出现的"无法比较"）
//   2. sections 新增 / 消失
//   3. tools 新增 / 消失
//   4. chars 变化 > 10%（sysChars / usrChars 分开算）
//   5. renderSmoke 变化
// 另打印「会话集合差异」（新增/消失的会话本身），它必然伴随 1~3 类差异，只是显式列出。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OLD = path.join(TOOLS_DIR, 'baseline.json');

const argv = process.argv.slice(2);
let oldFile, newFile;
if (argv.length >= 2) {
  oldFile = argv[0];
  newFile = argv[1];
} else if (argv.length === 1) {
  oldFile = DEFAULT_OLD;
  newFile = argv[0];
} else {
  console.error('用法：node tools/diff-baseline.mjs [old.json] <new.json>（old 缺省 tools/baseline.json）');
  process.exit(1);
}

function readBaseline(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`[diff] 读不到基线文件 ${file}：${String(error?.message ?? error)}`);
    process.exit(1);
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // 容忍 BOM
  try {
    const j = JSON.parse(text);
    if (!Array.isArray(j.sessions)) throw new Error('顶层 sessions 不是数组');
    return j;
  } catch (error) {
    console.error(`[diff] 基线 JSON 解析失败 ${file}：${String(error?.message ?? error)}`);
    process.exit(1);
  }
}

const old = readBaseline(path.resolve(oldFile));
const neu = readBaseline(path.resolve(newFile));
const oldById = new Map(old.sessions.map((s) => [String(s.id), s]));
const newById = new Map(neu.sessions.map((s) => [String(s.id), s]));

const lines = [];
const push = (msg) => lines.push(msg);

// ── 会话集合差异（显式列出）────────────────────────────────────────────────
for (const [id] of oldById) if (!newById.has(id)) push(`会话消失：${id}（只在 old 中）`);
for (const [id] of newById) if (!oldById.has(id)) push(`会话新增：${id}（只在 new 中）`);

// ── 1. sysHash / usrHash 变化 ──────────────────────────────────────────────
for (const [id, o] of oldById) {
  const n = newById.get(id);
  if (!n) continue;
  if (o.sysHash !== n.sysHash) push(`sysHash 变化：${id} ${o.sysHash} → ${n.sysHash}`);
  if (o.usrHash !== n.usrHash) push(`usrHash 变化：${id} ${o.usrHash} → ${n.usrHash}`);
}

// ── 2. sections 新增 / 消失 ────────────────────────────────────────────────
for (const [id, o] of oldById) {
  const n = newById.get(id);
  if (!n) continue;
  const os = new Set(o.sections || []);
  const ns = new Set(n.sections || []);
  const added = [...ns].filter((x) => !os.has(x));
  const removed = [...os].filter((x) => !ns.has(x));
  for (const s of added) push(`sections 新增：${id} +${s}`);
  for (const s of removed) push(`sections 消失：${id} -${s}`);
}

// ── 3. tools 新增 / 消失 ───────────────────────────────────────────────────
for (const [id, o] of oldById) {
  const n = newById.get(id);
  if (!n) continue;
  const ot = new Set(o.tools || []);
  const nt = new Set(n.tools || []);
  const added = [...nt].filter((x) => !ot.has(x));
  const removed = [...ot].filter((x) => !nt.has(x));
  for (const t of added) push(`tools 新增：${id} +${t}`);
  for (const t of removed) push(`tools 消失：${id} -${t}`);
}

// ── 4. chars 变化 > 10%（sysChars / usrChars 分开算）──────────────────────
const pctChanged = (id, label, o, n) => {
  const a = Number(o), b = Number(n);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    push(`chars 变化：${id} ${label} 取值非法（old=${o} new=${n}）`);
    return;
  }
  if (a === b) return;
  const ratio = a === 0 ? Number.POSITIVE_INFINITY : Math.abs(b - a) / a;
  if (ratio > 0.1) {
    const pct = a === 0 ? '∞' : `${Math.round(ratio * 100)}%`;
    push(`chars 变化 >10%：${id} ${label} ${a} → ${b}（${pct}）`);
  }
};
for (const [id, o] of oldById) {
  const n = newById.get(id);
  if (!n) continue;
  pctChanged(id, 'sysChars', o.sysChars, n.sysChars);
  pctChanged(id, 'usrChars', o.usrChars, n.usrChars);
}

// ── 5. renderSmoke 变化 ────────────────────────────────────────────────────
{
  const o = old.renderSmoke ?? {};
  const n = neu.renderSmoke ?? {};
  const fields = ['ok', 'chars', 'hash', 'error'];
  for (const f of fields) {
    if (String(o[f]) !== String(n[f])) push(`renderSmoke 变化：${f} ${JSON.stringify(o[f] ?? null)} → ${JSON.stringify(n[f] ?? null)}`);
  }
}

if (lines.length === 0) {
  console.log('BASELINE IDENTICAL');
  process.exit(0);
}

console.log(`BASELINE DIFFERENCES（${lines.length} 条，old=${path.resolve(oldFile)} new=${path.resolve(newFile)}）`);
for (const l of lines) console.log('  ' + l);
process.exit(2);
