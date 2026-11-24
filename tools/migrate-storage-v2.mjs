#!/usr/bin/env node
// migrate-storage-v2.mjs —— storage v2 迁移工具（plan §6 / 执行清单 T1.2）
//
// 用法（数据根动作一律显式带 XUNXI_DATA_DIR——真实数据根在仓库外）：
//   XUNXI_DATA_DIR=<数据根绝对路径> node tools/migrate-storage-v2.mjs --dry-run
//   XUNXI_DATA_DIR=… node tools/migrate-storage-v2.mjs --migrate --only <section[,section…]>
//   XUNXI_DATA_DIR=… node tools/migrate-storage-v2.mjs --verify --only <section[,section…]>
//   node tools/migrate-storage-v2.mjs --self-test        # 校验口径机器自检（零数据根依赖）
//
// 段（section）与目标表（plan §3/§4；每段唯一写者见 §4 表）：
//   messages → messages + meta(nextLocalId/chatKey)            （V2）
//   facts / cards / staging → 同名三表（别名 memory = 三段合称）（V3）
//   state    → state 表（mind/relationship/self/life 四个 key）（V4）
//   diary    → diary 表                                        （V4）
//   kv       → kv 表（reminders.json + cross-turn/main.json）  （V5）
//
// V2/V3/V4/V5 = 执行体已全部落地（messages 2135 行；memory 三段随夜3；state/diary 随夜4；
// kv 随夜4/5 收口）——不存在未实现段（--only 未知段名仍 exit 1，防拼写静默），
// **绝不静默 no-op**（校验失败三铁律：不切换、不删除、不上报成功）。
//
// 校验口径（plan §6）：**行数全等 + 逐行规范化 JSON 深度相等（键序无关）**。
//   normalizeStableJson：对象键排序后序列化（数组保序、值类型敏感）→ 字符串比对即深度相等。
//   V2+ 的 --verify 按"旧文件解析条数 == 目标表行数 && 逐条深度相等"执行。
//
// 铁律：旧文件一律只读——本工具对数据根只做 readdir/stat/read，是 plan §5-5 唯一合法的
//       "直读旧文件"场所；迁移前置（V2+ 生效）：应用未运行 + 全量归档 sha256 清单在位。
//
// 退出码：0 成功；1 用法/环境错误；2 校验失败；3 段未实现（V1 骨架曾对全部段如此；V2 起 messages 已实现）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function fail(msg, code = 1) {
  console.error(`[migrate-v2] ${msg}`);
  process.exit(code);
}
let mode = null;        // 'dry-run' | 'migrate' | 'verify' | 'self-test'
let onlyArg = null;
let archiveArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run' || a === '--migrate' || a === '--verify' || a === '--self-test') {
    if (mode) fail(`模式互斥：已给 --${mode === 'dry-run' ? 'dry-run' : mode} 又收到 ${a}`);
    mode = a.slice(2);
  } else if (a === '--only' || a.startsWith('--only=')) {
    onlyArg = a.includes('=') ? a.slice('--only='.length) : argv[++i];
    if (!onlyArg) fail('--only 需要一个段名参数');
  } else if (a === '--archive' || a.startsWith('--archive=')) {
    archiveArg = a.includes('=') ? a.slice('--archive='.length) : argv[++i];
  } else {
    fail(`未知参数：${a}`);
  }
}
if (!mode) fail('缺模式：--dry-run | --migrate --only <段> | --verify --only <段> | --self-test');

// ── 校验口径机器（--self-test 可自检；V2+ 的 --verify 复用）──────────────────
/** 规范化序列化：对象键排序（键序无关），数组保序，undefined→null（JSON 语义）。
 *  返回字符串——字符串相等 ⇔ 深度相等。 */
export function normalizeStableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(normalizeStableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${normalizeStableJson(value[k])}`).join(',')}}`;
}
/** 逐行深度相等（校验口径第二半句）。 */
export function rowDeepEqual(a, b) {
  return normalizeStableJson(a) === normalizeStableJson(b);
}

/** 读 jsonl：容忍 BOM；逐行 trim，空行跳过；坏行计入 badLines 不中断（与 memory.js
 *  readJsonl 同口径——坏行在迁移校验里显式可见，不静默吞掉）。 */
function readJsonlFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;   // 文件不存在由调用方标记 missing
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const entries = [];
  const badLines = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') entries.push(obj);
      else badLines.push(t.slice(0, 40));
    } catch {
      badLines.push(t.slice(0, 40));
    }
  }
  return { entries, badLines };
}

/** 读单对象 JSON（容忍 BOM）。 */
function readJsonObject(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? { obj, badLines: [] } : { obj: null, badLines: ['top-level 非 object'] };
  } catch (e) {
    return { obj: null, badLines: [`JSON.parse 失败: ${e?.message ?? e}`] };
  }
}

/** 读 diary.jsonl：diary.js 的读路径支持"一行粘多条 JSON"（splitJsonObjects 口径，
 *  2026-11-03 实测史），计数必须与其一致——否则行数全等校验在 V4 会假报。 */
function splitJsonObjects(line) {
  const out = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) { out.push(line.slice(start, i + 1)); start = -1; }
    }
  }
  return out;
}
function readDiaryFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const entries = [];
  const badLines = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const segs = splitJsonObjects(s);
    if (!segs.length) { badLines.push(s.slice(0, 40)); continue; }
    for (const seg of segs) {
      try {
        const obj = JSON.parse(seg);
        if (obj && typeof obj === 'object') entries.push(obj);
        else badLines.push(seg.slice(0, 40));
      } catch {
        badLines.push(seg.slice(0, 40));
      }
    }
  }
  return { entries, badLines };
}

// ── 段注册（V1 骨架 impl 全空 → V2 起 messages 段落地；V3/V4/V5 逐段填充）─────────
const SECTIONS = [
  {
    id: 'messages', label: 'messages（单一时间线）', phase: 'V2',
    impl: { migrate: migrateMessages, verify: verifyMessages },
    targets: 'messages + meta(nextLocalId/chatKey)',
    sources: [
      { rel: 'messages/main.json', kind: 'chat' }
    ]
  },
  { id: 'facts', label: 'facts（长期事实）', phase: 'V3', impl: { migrate: migrateFacts, verify: verifyFacts }, targets: 'facts', sources: [{ rel: 'person/facts.jsonl', kind: 'jsonl' }] },
  { id: 'cards', label: 'cards（记忆卡）', phase: 'V3', impl: { migrate: migrateCards, verify: verifyCards }, targets: 'cards', sources: [{ rel: 'person/cards', kind: 'monthly-jsonl' }] },
  { id: 'staging', label: 'staging（当日暂存）', phase: 'V3', impl: { migrate: migrateStaging, verify: verifyStaging }, targets: 'staging', sources: [{ rel: 'person/staging', kind: 'day-jsonl' }] },
  {
    id: 'state', label: 'state（mind/relationship/self/life）', phase: 'V4',
    impl: { migrate: migrateState, verify: verifyState }, targets: 'state',
    sources: [
      { rel: 'person/mind.json', kind: 'json' },
      { rel: 'person/relationship.json', kind: 'json' },
      { rel: 'person/self.json', kind: 'json' },
      { rel: 'person/life.json', kind: 'json' }
    ]
  },
  { id: 'diary', label: 'diary（私密日记）', phase: 'V4', impl: { migrate: migrateDiary, verify: verifyDiary }, targets: 'diary', sources: [{ rel: 'person/diary.jsonl', kind: 'diary' }] },
  {
    id: 'kv', label: 'kv（reminders/transition，旧键 cross-turn）', phase: 'V5', impl: { migrate: migrateKv, verify: verifyKv }, targets: 'kv',
    sources: [
      { rel: 'reminders.json', kind: 'json' },
      { rel: 'cross-turn/main.json', kind: 'json' }
    ]
  }
];
const ALIASES = { memory: ['facts', 'cards', 'staging'], all: SECTIONS.map((s) => s.id) };

function resolveSections(only) {
  if (!only) fail('--migrate/--verify 需要 --only <段[，段…]|memory|all>');
  const names = String(only).split(',').map((s) => s.trim()).filter(Boolean);
  const picked = [];
  for (const n of names) {
    const alias = ALIASES[n];
    if (alias) picked.push(...alias);
    else if (SECTIONS.some((s) => s.id === n)) picked.push(n);
    else fail(`未知段 "${n}"（可选：${SECTIONS.map((s) => s.id).join(', ')}；别名 memory/all）`);
  }
  return [...new Set(picked)].map((id) => SECTIONS.find((s) => s.id === id));
}

// ── 扫描（只读）──────────────────────────────────────────────────────────────
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function scanFile(dataRoot, src) {
  const abs = path.join(dataRoot, src.rel);
  const row = { rel: src.rel, kind: src.kind, exists: false, bytes: 0, sha: '', entries: 0, badLines: [], extra: null };
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return row;   // 缺文件：合法（reminders.json 可能不存在；cards/staging 目录可空）
  }
  row.exists = true;
  row.bytes = st.size;
  if (st.isFile()) row.sha = sha256(fs.readFileSync(abs)).slice(0, 16);   // 目录型源（cards/staging）逐子文件计数，不在目录上 read
  if (src.kind === 'monthly-jsonl' || src.kind === 'day-jsonl') {
    let files = [];
    try {
      files = fs.readdirSync(abs).filter((f) => /^\d{4}-\d{2}(-\d{2})?\.jsonl$/.test(f)).sort();
    } catch { /* 目录不存在 → 0 条 */ }
    let total = 0;
    row.files = [];
    for (const f of files) {
      const abs2 = path.join(abs, f);
      const st2 = fs.statSync(abs2);
      const parsed = readJsonlFile(abs2);
      const n = parsed ? parsed.entries.length : 0;
      total += n;
      row.files.push({ rel: `${src.rel}/${f}`, bytes: st2.size, entries: n, bad: parsed ? parsed.badLines.length : 0 });
      if (parsed) row.badLines.push(...parsed.badLines.slice(0, 3));
    }
    row.entries = total;
    row.subFiles = files.length;
  } else if (src.kind === 'jsonl') {
    const parsed = readJsonlFile(abs);
    row.entries = parsed ? parsed.entries.length : 0;
    row.badLines = parsed ? parsed.badLines.slice(0, 3) : [];
  } else if (src.kind === 'diary') {
    const parsed = readDiaryFile(abs);
    row.entries = parsed ? parsed.entries.length : 0;
    row.badLines = parsed ? parsed.badLines.slice(0, 3) : [];
  } else if (src.kind === 'json') {
    const parsed = readJsonObject(abs);
    row.entries = parsed && parsed.obj ? 1 : 0;
    row.badLines = parsed ? parsed.badLines.slice(0, 3) : [];
    row.extra = parsed && parsed.obj ? Object.keys(parsed.obj).length : null;
  } else if (src.kind === 'chat') {
    const parsed = readJsonObject(abs);
    row.badLines = parsed ? parsed.badLines.slice(0, 3) : [];
    if (parsed && parsed.obj) {
      const msgs = Array.isArray(parsed.obj.messages) ? parsed.obj.messages : null;
      row.entries = msgs ? msgs.length : 0;
      row.extra = { chatKey: parsed.obj.chatKey ?? null, nextLocalId: parsed.obj.nextLocalId ?? null, messagesShapeOk: !!msgs };
    } else {
      row.entries = 0;
    }
  }
  return row;
}

// ── 前置检查（dry-run 信息性；V2+ migrate/verify 作硬闸）─────────────────────
function checkAppClosed() {
  try {
    const r = spawnSync('tasklist', { encoding: 'utf8' });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const hit = out.split(/\r?\n/).filter((l) => /xunxi|electron/i.test(l));
    return { closed: hit.length === 0, processes: hit.slice(0, 5) };
  } catch (e) {
    return { closed: null, processes: [], error: String(e?.message ?? e) };
  }
}
function locateArchive() {
  const candidates = [];
  if (archiveArg) candidates.push(archiveArg);
  const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
  const appRoot = path.resolve(TOOLS_DIR, '..');   // resources/app（仓库根）
  // 归档可能的两层位置（夜0 drift①：真实归档在 D:/Projects/QQAgent/_archive-20261116，非仓库内）
  candidates.push(
    path.resolve(appRoot, '..', '..', '..', '_archive-20261116', 'pre-storage-v2'),   // D:/Projects/QQAgent/_archive-20261116（夜0 实际）
    path.resolve(appRoot, '..', '..', '_archive-20261116', 'pre-storage-v2')          // Xunxi/_archive-20261116（计划§6 名义位置）
  );
  for (const dir of candidates) {
    const manifest = path.join(dir, 'sha256sums.txt');
    if (fs.existsSync(manifest)) return { found: true, dir, manifest };
  }
  return { found: false, tried: candidates };
}

// ── 模式实现 ─────────────────────────────────────────────────────────────────
function runSelfTest() {
  let failed = 0;
  const t = (name, fn) => {
    try { fn(); console.log(`  ok  ${name}`); } catch (e) { failed++; console.error(`FAIL  ${name}: ${e?.message ?? e}`); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  console.log('[migrate-v2] 校验口径自检（normalizeStableJson / rowDeepEqual / 读文件器）');
  t('键序无关：{a:1,b:2} ≡ {b:2,a:1}', () => {
    assert(rowDeepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), '键序应无关');
    assert(!rowDeepEqual({ a: 1, b: 2 }, { a: 2, b: 1 }), '值不同必须不等');
  });
  t('嵌套深度相等 + 数组保序', () => {
    assert(rowDeepEqual({ x: [1, { p: 'q', r: [3] }] }, { x: [1, { r: [3], p: 'q' }] }), '嵌套应相等');
    assert(!rowDeepEqual([1, 2], [2, 1]), '数组必须保序');
  });
  t('类型敏感：1 ≋ "1" 不等；null/undefined 归一后相等', () => {
    assert(!rowDeepEqual(1, '1'), '数字与字符串不等');
    assert(normalizeStableJson(undefined) === 'null', 'undefined → null');
    assert(rowDeepEqual({ a: undefined }, { a: null }), 'undefined/null 归一后应相等（JSON 语义）');
  });
  t('BOM/坏行：readJsonlFile 容忍 BOM、坏行计数不中断', () => {
    const tmp = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || '.', 'mig-selftest-'));
    const f = path.join(tmp, 'a.jsonl');
    fs.writeFileSync(f, '\uFEFF{"a":1}\n坏行不是JSON\n{"a":2}\n\n', 'utf8');
    const parsed = readJsonlFile(f);
    assert(parsed.entries.length === 2, `应 2 条，实际 ${parsed.entries.length}`);
    assert(parsed.badLines.length === 1, '坏行应计 1');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  t('diary 粘行拆分：{"…"}{"…"} 两条都计', () => {
    const tmp = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || '.', 'mig-selftest-'));
    const f = path.join(tmp, 'd.jsonl');
    fs.writeFileSync(f, '{"at":1,"content":"甲"}{"at":2,"content":"乙"}\n', 'utf8');
    const parsed = readDiaryFile(f);
    assert(parsed.entries.length === 2, `粘行应拆 2 条，实际 ${parsed.entries.length}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  if (failed) { console.error(`[migrate-v2] 自检失败 ${failed} 项`); process.exit(2); }
  console.log('[migrate-v2] 自检全过');
  process.exit(0);
}

function runDryRun(dataRoot) {
  const app = checkAppClosed();
  const archive = locateArchive();
  console.log('═'.repeat(100));
  console.log('storage v2 迁移 · --dry-run 对照表（只读；旧文件零写入；已实现段：V2 messages + V3 memory 三段）');
  console.log(`数据根: ${dataRoot}`);
  console.log(`应用关闭态: ${app.closed === null ? `未知（${app.error ?? 'tasklist 失败'}）` : app.closed ? '关闭 ✓（无 xunxi/electron 进程）' : `⚠️ 运行中：${app.processes.join(' | ')}`}`);
  console.log(`全量归档: ${archive.found ? `${archive.dir} ✓` : '未找到（--archive 可显式指定；V2 migrate 前置硬闸）'}`);
  console.log(`校验口径: 行数全等 + 逐行规范化 JSON 深度相等（键序无关）`);
  console.log('═'.repeat(100));
  console.log('');
  console.log('段        阶段  源（数据根相对）                        条数  字节      sha256(前16)     目标表                      状态');
  console.log('-'.repeat(140));
  let totalEntries = 0;
  let warnings = 0;
  for (const sec of SECTIONS) {
    for (const src of sec.sources) {
      const row = scanFile(dataRoot, src);
      totalEntries += row.entries;
      const rel = src.kind === 'monthly-jsonl' || src.kind === 'day-jsonl'
        ? `${src.rel}/ (${row.subFiles ?? 0} 文件)`
        : src.rel;
      const statusBits = [];
      if (!row.exists) statusBits.push('缺文件');
      if (row.badLines.length) { statusBits.push(`坏行${row.badLines.length}+`); warnings++; }
      if (src.kind === 'chat' && row.extra && row.extra.messagesShapeOk === false) { statusBits.push('messages 数组缺失!'); warnings++; }
      statusBits.push(`${sec.phase} 待迁移`);
      console.log(
        sec.id.padEnd(9) + sec.phase.padEnd(5)
        + rel.padEnd(38)
        + String(row.entries).padStart(5) + '  '
        + String(row.bytes).padStart(8) + '  '
        + (row.sha || '-').padEnd(16) + ' '
        + sec.targets.padEnd(26)
        + statusBits.join(' / ')
      );
      if (src.kind === 'chat' && row.exists) {
        console.log(`${' '}↳ meta 值: chatKey=${row.extra?.chatKey} nextLocalId=${row.extra?.nextLocalId}（V2 迁移取原值入 meta 表）`);
      }
      for (const b of row.badLines.slice(0, 3)) console.log(`  ⚠️ 坏行: ${b}`);
    }
  }
  console.log('-'.repeat(140));
  const dbPath = path.join(dataRoot, 'xunxi.db');
  console.log(`合计源条目: ${totalEntries}；坏行告警段数: ${warnings}；目标库: ${dbPath}（${fs.existsSync(dbPath) ? '已存在' : '尚未创建'}）`);
  console.log('');
  console.log('阶段边界：--dry-run 只读对照；已实现段：V2(messages)+V3(memory)+V4(state/diary)+V5(kv)——全段可 --migrate/--verify。');
  console.log('回滚保险丝：迁移前旧 JSON 已由迁移工具就地改名 *.pre-storage-v2 归档（sha256 清单见迁移输出；迁移口径见内部文档 handoff-sqlite-v2.md）。');
}

// ── V2 messages 段执行体（执行清单 T2.2；plan §3 messages DDL / §12-2 meta）──────
// 映射层与 store.js 共用（src/storage/messages-map.js）——verify 把 DB 行经 rowToEntry
// 重建后与旧文件条目逐行比对，等价于证明「切后端后 API 返回与文件时代逐字节一致」。

/** 归档 sha256sums.txt 解析（sha256sum 格式：`<hash>  <relpath>`）。 */
function archiveManifest(archive) {
  const text = fs.readFileSync(archive.manifest, 'utf8');
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) map.set(m[2].replace(/\\/g, '/'), m[1].toLowerCase());
  }
  return map;
}

/** 读旧 chat 文件并做形状校验（迁移写入前的硬校验——坏数据绝不进 DB）。 */
function readChatSource(dataRoot) {
  const abs = path.join(dataRoot, 'messages/main.json');
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    fail(`源文件不存在：${abs}`, 2);
  }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    fail(`源文件 JSON.parse 失败：${e?.message ?? e}`, 2);
  }
  if (!obj || !Array.isArray(obj.messages)) fail('源文件形状非法：messages 数组缺失', 2);
  if (!Number.isInteger(obj.nextLocalId) || obj.nextLocalId < 1) {
    fail(`源文件形状非法：nextLocalId=${JSON.stringify(obj.nextLocalId)}（须 ≥1 整数——精确计数器原值落 meta）`, 2);
  }
  // 逐条硬校验：id 唯一且 ≥1 整数、ts 数字（NaN 绑定会被 better-sqlite3 转成 NULL——
  // 绝不允许静默进库）。其余字段由 entryToRow 的 String()/JSON 兜底口径处理。
  const seenIds = new Set();
  for (let i = 0; i < obj.messages.length; i++) {
    const m = obj.messages[i];
    if (!m || typeof m !== 'object') fail(`第 ${i} 条非对象`, 2);
    if (!Number.isInteger(m.id) || m.id < 1) fail(`第 ${i} 条 id 非法：${JSON.stringify(m.id)}`, 2);
    if (seenIds.has(m.id)) fail(`第 ${i} 条 id 重复：${m.id}`, 2);
    seenIds.add(m.id);
    if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) fail(`第 ${i} 条（id=${m.id}）ts 非法：${JSON.stringify(m.ts)}`, 2);
  }
  return obj;
}

function openV2Modules() {
  // 动态 import：--self-test 保持零数据根依赖（不触 db.js/config.js 解析链）
  return Promise.all([
    import('../src/storage/db.js'),
    import('../src/storage/messages-map.js')
  ]).then(([dbmod, map]) => ({ dbmod, map }));
}

async function migrateMessages(dataRoot, archive) {
  // 前置铁律 3（所有者强调）：夜0 全量归档是一切切换的前提——当前真身 sha256 必须与
  // 归档清单逐字节一致，漂移即停（先重新归档，绝不带着未归档的增量切换）。
  const file = path.join(dataRoot, 'messages/main.json');
  const manifest = archiveManifest(archive);
  const expected = manifest.get('messages/main.json');
  if (!expected) fail(`归档清单缺 messages/main.json 条目（${archive.manifest}）`, 1);
  const currentSha = sha256(fs.readFileSync(file));
  if (currentSha !== expected) {
    fail(`真身漂移：data/messages/main.json sha256=${currentSha.slice(0, 16)}… 与夜0 归档 ${expected.slice(0, 16)}… 不一致——先重新归档再迁移`, 1);
  }
  const obj = readChatSource(dataRoot);
  const { dbmod, map } = await openV2Modules();
  const t0 = Date.now();
  const db = dbmod.getDb();
  const insertSql = `INSERT INTO messages (${map.MESSAGE_COLUMNS.join(', ')}) VALUES (${map.MESSAGE_COLUMNS.map(() => '?').join(', ')})`;
  try {
    dbmod.transaction(() => {
      // 幂等重跑口径：先清段再全量写（失败 → DB 删重建重来，纪律 3）
      db.prepare('DELETE FROM messages').run();
      db.prepare("DELETE FROM meta WHERE key IN ('chatKey', 'nextLocalId')").run();
      const insert = db.prepare(insertSql);
      obj.messages.forEach((entry, i) => insert.run(...map.entryToRow(entry, i + 1)));
      // meta 精确计数器：nextLocalId 取旧文件原值（≠ MAX(id)+1——本数据集 2169 vs 2135 行
      // 实证删过消息）；chatKey 归一 'main'（W5/Q10 口径）。与行写入同一事务。
      db.prepare("INSERT INTO meta (key, value) VALUES ('chatKey', 'main') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
      db.prepare("INSERT INTO meta (key, value) VALUES ('nextLocalId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(obj.nextLocalId));
    });
  } finally {
    dbmod.closeDb();   // WAL checkpoint 落盘；连接关闭（重开走幂等 DDL 路径）
  }
  console.log(`[migrate-v2] messages 迁移完成：${obj.messages.length} 行（seq=1..${obj.messages.length}，按文件序=插入序）`);
  console.log(`[migrate-v2] meta: chatKey='main' nextLocalId=${obj.nextLocalId}（旧文件原值）`);
  console.log(`[migrate-v2] 用时 ${Date.now() - t0}ms；旧文件未动（--verify 通过后才允许改名 .pre-storage-v2）`);
}

async function verifyMessages(dataRoot) {
  const obj = readChatSource(dataRoot);
  const { dbmod, map } = await openV2Modules();
  const db = dbmod.getDb();
  let mismatches = 0;
  try {
    const rows = db.prepare(`SELECT ${map.MESSAGE_COLUMNS.join(', ')} FROM messages ORDER BY seq`).all();
    console.log(`[migrate-v2] verify messages：源 ${obj.messages.length} 条 vs DB ${rows.length} 行（ORDER BY seq 位置化比对）`);
    if (rows.length !== obj.messages.length) {
      console.error(`[migrate-v2] ✗ 行数不等：源 ${obj.messages.length} vs DB ${rows.length}`);
      mismatches++;
    }
    // 逐行规范化 JSON 深度相等（键序无关，校验口径机器 rowDeepEqual）+ 位置对位
    // （DB seq 序必须与旧文件数组序逐位一致——recent() 返回序语义保真）
    for (let i = 0; i < Math.min(rows.length, obj.messages.length); i++) {
      const dbEntry = map.rowToEntry(rows[i]);
      if (!rowDeepEqual(obj.messages[i], dbEntry)) {
        mismatches++;
        if (mismatches <= 5) {
          console.error(`[migrate-v2] ✗ 第 ${i} 位（源 id=${obj.messages[i].id} vs DB id=${rows[i].id}）深度不等：`);
          console.error(`    源: ${normalizeStableJson(obj.messages[i]).slice(0, 240)}`);
          console.error(`    DB: ${normalizeStableJson(dbEntry).slice(0, 240)}`);
        }
      }
    }
    // meta 校验（plan §12-2：nextLocalId 原值落点）
    const metaNext = db.prepare("SELECT value FROM meta WHERE key = 'nextLocalId'").get();
    const metaChat = db.prepare("SELECT value FROM meta WHERE key = 'chatKey'").get();
    if (!metaNext || metaNext.value !== String(obj.nextLocalId)) {
      mismatches++;
      console.error(`[migrate-v2] ✗ meta.nextLocalId：DB=${metaNext ? metaNext.value : '<缺>'} vs 源 ${obj.nextLocalId}`);
    }
    if (!metaChat || metaChat.value !== 'main') {
      mismatches++;
      console.error(`[migrate-v2] ✗ meta.chatKey：DB=${metaChat ? metaChat.value : '<缺>'} vs 'main'`);
    }
    // FTS 行数校验（plan §12 执行注意：FTS 触发器与行数校验同时验证）
    const ftsCount = db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get().n;
    if (ftsCount !== obj.messages.length) {
      mismatches++;
      console.error(`[migrate-v2] ✗ messages_fts 行数 ${ftsCount} ≠ 源 ${obj.messages.length}（触发器/索引不同步）`);
    }
  } finally {
    dbmod.closeDb();
  }
  if (mismatches) {
    console.error(`[migrate-v2] verify 失败：${mismatches} 处不等——不切换、不删除、不上报成功（DB 删重建重来）`);
    process.exit(2);
  }
  console.log(`[migrate-v2] verify 通过：${obj.messages.length} 行逐位深度相等 + meta(nextLocalId=${obj.nextLocalId}/chatKey='main') + FTS 行数同步 ✓`);
}

// ── V3 memory 三段执行体（执行清单 T3.2；plan §3 facts/cards/staging DDL / §7-V3）──────
// 映射层与 person/memory.js 共用（src/storage/memory-map.js）——verify 把 DB 行经
// rowTo* 重建后与旧文件条目逐行比对，等价于证明「切后端后 API 返回与文件时代逐字节
// 一致」（含顺序语义：facts/cards 按 rowid 序=迁移插入序=文件序，staging 按 (day,seq)）。
// 硬校验纪律与 V2 readChatSource 同款：坏数据绝不进库（fail-fast），NaN 绑定会变 NULL。

function openV3Modules() {
  return Promise.all([
    import('../src/storage/db.js'),
    import('../src/storage/memory-map.js')
  ]).then(([dbmod, map]) => ({ dbmod, map }));
}

/** 逐文件归档 sha 校验（目录型源：清单里每个子文件都要对上——漂移即拒迁）。 */
function checkArchiveShaForFiles(archive, dataRoot, relFiles) {
  const manifest = archiveManifest(archive);
  for (const rel of relFiles) {
    const expected = manifest.get(rel);
    if (!expected) fail(`归档清单缺 ${rel} 条目（${archive.manifest}）`, 1);
    const currentSha = sha256(fs.readFileSync(path.join(dataRoot, rel)));
    if (currentSha !== expected) {
      fail(`真身漂移：data/${rel} sha256=${currentSha.slice(0, 16)}… 与夜0 归档 ${expected.slice(0, 16)}… 不一致——先重新归档再迁移`, 1);
    }
  }
}

const FACT_SUBJECTS = ['other', 'self', 'we'];
const FACT_STATUSES = ['active', 'superseded'];
const CARD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** facts 源硬校验（写入前逐条——坏数据绝不进 DB）。返回规范条目数组（原样值，仅 status 补缺省）。 */
function checkFactEntries(entries) {
  for (let i = 0; i < entries.length; i++) {
    const f = entries[i];
    const at = `facts 第 ${i + 1} 条（key=${JSON.stringify(f?.key ?? null).slice(0, 30)}）`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) fail(`${at}：非对象`, 2);
    if (typeof f.key !== 'string' || !f.key) fail(`${at}：key 非非空字符串`, 2);
    if (typeof f.kind !== 'string' || !f.kind) fail(`${at}：kind 非非空字符串`, 2);
    if (!FACT_SUBJECTS.includes(f.subject)) fail(`${at}：subject=${JSON.stringify(f.subject)} ∉ other|self|we`, 2);
    if (typeof f.content !== 'string') fail(`${at}：content 非字符串`, 2);
    const status = f.status ?? 'active';
    if (!FACT_STATUSES.includes(status)) fail(`${at}：status=${JSON.stringify(f.status)} ∉ active|superseded`, 2);
    if (typeof f.validFrom !== 'number' || !Number.isFinite(f.validFrom)) fail(`${at}：validFrom 非有限数字（NaN 绑定会变 NULL）`, 2);
    if (f.mid !== undefined && f.mid !== null && (typeof f.mid !== 'number' || !Number.isFinite(f.mid))) {
      fail(`${at}：mid=${JSON.stringify(f.mid)} 须数字或 null`, 2);
    }
    if (typeof f.visibility !== 'string') fail(`${at}：visibility 缺失或非字符串（NOT NULL 列；live 19/19 全有）`, 2);
    if (f.v !== undefined && f.v !== null && (typeof f.v !== 'number' || !Number.isFinite(f.v))) {
      fail(`${at}：v=${JSON.stringify(f.v)} 须数字或 null（缺键=pre-E3 历史行）`, 2);
    }
  }
  return entries;
}

function readFactsSource(dataRoot) {
  const abs = path.join(dataRoot, 'person/facts.jsonl');
  if (!fs.existsSync(abs)) fail(`源文件不存在：${abs}`, 2);
  const parsed = readJsonlFile(abs);
  return { entries: checkFactEntries(parsed.entries), badLines: parsed.badLines };
}

function listMonthOrDayFiles(dataRoot, rel, re) {
  const abs = path.join(dataRoot, rel);
  let files = [];
  try {
    files = fs.readdirSync(abs).filter((f) => re.test(f)).sort();
  } catch {
    fail(`源目录不存在：${abs}`, 2);
  }
  return files.map((f) => ({ name: f, abs: path.join(abs, f) }));
}

/** cards 源硬校验：月文件升序 × 文件行序（= cards() 返回序）；无 date 字符串的条目跳过
 *  （cards() API 对其不可见——原样保留在归档文件里，跳过数显式回报）。 */
function readCardsSource(dataRoot) {
  const files = listMonthOrDayFiles(dataRoot, 'person/cards', /^\d{4}-\d{2}\.jsonl$/);
  const out = [];
  let skippedDateless = 0;
  const seenDates = new Set();
  for (const f of files) {
    const parsed = readJsonlFile(f.abs);
    for (let i = 0; i < parsed.entries.length; i++) {
      const c = parsed.entries[i];
      const at = `cards ${f.name} 第 ${i + 1} 条`;
      if (!c || typeof c !== 'object' || Array.isArray(c)) fail(`${at}：非对象`, 2);
      if (typeof c.date !== 'string') { skippedDateless++; continue; }   // API 不可见 → 跳过（显式登记）
      if (!CARD_DATE_RE.test(c.date)) fail(`${at}：date=${JSON.stringify(c.date)} 非 YYYY-MM-DD`, 2);
      if (seenDates.has(c.date)) fail(`${at}：date=${c.date} 重复（cards.date 主键；文件机制 writeCard 本就会滤同日旧卡）`, 2);
      seenDates.add(c.date);
      if (typeof c.source !== 'string') fail(`${at}：source 缺失或非字符串（NOT NULL 列）`, 2);
      if (c.v !== undefined && (typeof c.v !== 'number' || !Number.isFinite(c.v))) fail(`${at}：v=${JSON.stringify(c.v)} 须数字`, 2);
      if (c.writtenAt !== undefined && c.writtenAt !== null && (typeof c.writtenAt !== 'number' || !Number.isFinite(c.writtenAt))) {
        fail(`${at}：writtenAt=${JSON.stringify(c.writtenAt)} 须数字或 null`, 2);
      }
      if (c.salience !== undefined && c.salience !== null && (typeof c.salience !== 'number' || !Number.isFinite(c.salience))) {
        fail(`${at}：salience=${JSON.stringify(c.salience)} 须数字或 null`, 2);
      }
      if (c.visibility !== undefined && typeof c.visibility !== 'string') fail(`${at}：visibility 非字符串`, 2);
      out.push(c);
    }
  }
  return { entries: out, files, skippedDateless };
}

/** staging 源硬校验：日文件升序 × 文件行序（= staging(day) 的当日行序=时间序）。 */
function readStagingSource(dataRoot) {
  const files = listMonthOrDayFiles(dataRoot, 'person/staging', /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  const out = [];   // { day, entry }
  for (const f of files) {
    const day = f.name.slice(0, 10);
    const parsed = readJsonlFile(f.abs);
    for (let i = 0; i < parsed.entries.length; i++) {
      const e = parsed.entries[i];
      const at = `staging ${f.name} 第 ${i + 1} 条`;
      if (!e || typeof e !== 'object' || Array.isArray(e)) fail(`${at}：非对象`, 2);
      if (typeof e.text !== 'string') fail(`${at}：text 非字符串（NOT NULL 列）`, 2);
      if (e.mid !== undefined && e.mid !== null && (typeof e.mid !== 'number' || !Number.isFinite(e.mid))) {
        fail(`${at}：mid=${JSON.stringify(e.mid)} 须数字或 null`, 2);
      }
      if (typeof e.source !== 'string') fail(`${at}：source 缺失或非字符串`, 2);
      if (typeof e.at !== 'number' || !Number.isFinite(e.at)) fail(`${at}：at 非有限数字`, 2);
      out.push({ day, entry: e });
    }
  }
  return { items: out, files };
}

async function migrateFacts(dataRoot, archive) {
  const file = path.join(dataRoot, 'person/facts.jsonl');
  checkArchiveShaForFiles(archive, dataRoot, ['person/facts.jsonl']);
  const { entries } = readFactsSource(dataRoot);
  const { dbmod, map } = await openV3Modules();
  const t0 = Date.now();
  try {
    const db = dbmod.getDb();
    const insertSql = `INSERT INTO facts (${map.FACT_COLUMNS.join(', ')}) VALUES (${map.FACT_COLUMNS.map(() => '?').join(', ')})`;
    dbmod.transaction(() => {
      db.prepare('DELETE FROM facts').run();   // 幂等重跑口径：先清段再全量写（失败 → DB 删重建重来）
      const insert = db.prepare(insertSql);
      entries.forEach((entry) => insert.run(...map.factToRow(entry)));
    });
  } finally {
    dbmod.closeDb();
  }
  console.log(`[migrate-v2] facts 迁移完成：${entries.length} 行（按文件序=插入序；含 superseded 链同 key 多行——facts.key 非 PK）`);
  console.log(`[migrate-v2] 用时 ${Date.now() - t0}ms；旧文件未动（--verify 通过后才允许改名 .pre-storage-v2）`);
}

async function verifyFacts(dataRoot) {
  const { entries } = readFactsSource(dataRoot);
  const { dbmod, map } = await openV3Modules();
  let mismatches = 0;
  try {
    const db = dbmod.getDb();
    const rows = db.prepare(`SELECT ${map.FACT_COLUMNS.join(', ')} FROM facts ORDER BY rowid`).all();
    console.log(`[migrate-v2] verify facts：源 ${entries.length} 条 vs DB ${rows.length} 行（ORDER BY rowid 位置化比对=插入序语义）`);
    if (rows.length !== entries.length) {
      console.error(`[migrate-v2] ✗ 行数不等：源 ${entries.length} vs DB ${rows.length}`);
      mismatches++;
    }
    for (let i = 0; i < Math.min(rows.length, entries.length); i++) {
      const dbEntry = map.rowToFact(rows[i]);
      if (!rowDeepEqual(entries[i], dbEntry)) {
        mismatches++;
        if (mismatches <= 5) {
          console.error(`[migrate-v2] ✗ facts 第 ${i + 1} 位深度不等：`);
          console.error(`    源: ${normalizeStableJson(entries[i]).slice(0, 240)}`);
          console.error(`    DB: ${normalizeStableJson(dbEntry).slice(0, 240)}`);
        }
      }
    }
    // 顺序语义锚点：active 子序必须与文件过滤序逐位一致（prompt.js:587「最早事实在前」）
    const srcActive = entries.filter((f) => (f?.status ?? 'active') === 'active');
    const dbActive = rows.map(map.rowToFact).filter((f) => f.status === 'active');
    if (srcActive.length !== dbActive.length
      || srcActive.some((f, i) => !rowDeepEqual(f, dbActive[i]))) {
      mismatches++;
      console.error('[migrate-v2] ✗ active 子序与文件过滤序不一致（提示词锚点顺序语义被破坏）');
    }
  } finally {
    dbmod.closeDb();
  }
  if (mismatches) failVerify('facts', mismatches);
  console.log(`[migrate-v2] verify 通过：facts ${entries.length} 行逐位深度相等（含 active 子序锚点）✓`);
}

async function migrateCards(dataRoot, archive) {
  const files = listMonthOrDayFiles(dataRoot, 'person/cards', /^\d{4}-\d{2}\.jsonl$/);
  checkArchiveShaForFiles(archive, dataRoot, files.map((f) => `person/cards/${f.name}`));
  const { entries, skippedDateless } = readCardsSource(dataRoot);
  const { dbmod, map } = await openV3Modules();
  const t0 = Date.now();
  try {
    const db = dbmod.getDb();
    const insertSql = `INSERT INTO cards (${map.CARD_COLUMNS.join(', ')}) VALUES (${map.CARD_COLUMNS.map(() => '?').join(', ')})`;
    dbmod.transaction(() => {
      db.prepare('DELETE FROM cards').run();
      const insert = db.prepare(insertSql);
      entries.forEach((entry) => insert.run(...map.cardToRow(entry)));
    });
  } finally {
    dbmod.closeDb();
  }
  console.log(`[migrate-v2] cards 迁移完成：${entries.length} 行（月文件升序×文件行序=插入序；date 主键=同日替换）${skippedDateless ? `；跳过无 date 条目 ${skippedDateless}（API 不可见，归档文件保留）` : ''}`);
  console.log(`[migrate-v2] 用时 ${Date.now() - t0}ms；旧文件未动（--verify 通过后才允许改名 .pre-storage-v2）`);
}

async function verifyCards(dataRoot) {
  const { entries } = readCardsSource(dataRoot);
  const { dbmod, map } = await openV3Modules();
  let mismatches = 0;
  try {
    const db = dbmod.getDb();
    const rows = db.prepare(`SELECT ${map.CARD_COLUMNS.join(', ')} FROM cards ORDER BY rowid`).all();
    console.log(`[migrate-v2] verify cards：源 ${entries.length} 卡 vs DB ${rows.length} 行（ORDER BY rowid 位置化比对=月文件序×行序语义）`);
    if (rows.length !== entries.length) {
      console.error(`[migrate-v2] ✗ 行数不等：源 ${entries.length} vs DB ${rows.length}`);
      mismatches++;
    }
    for (let i = 0; i < Math.min(rows.length, entries.length); i++) {
      const dbEntry = map.rowToCard(rows[i]);
      if (!rowDeepEqual(entries[i], dbEntry)) {
        mismatches++;
        if (mismatches <= 5) {
          console.error(`[migrate-v2] ✗ cards 第 ${i + 1} 位（date=${entries[i].date}）深度不等：`);
          console.error(`    源: ${normalizeStableJson(entries[i]).slice(0, 240)}`);
          console.error(`    DB: ${normalizeStableJson(dbEntry).slice(0, 240)}`);
        }
      }
    }
  } finally {
    dbmod.closeDb();
  }
  if (mismatches) failVerify('cards', mismatches);
  console.log(`[migrate-v2] verify 通过：cards ${entries.length} 卡逐位深度相等 ✓`);
}

async function migrateStaging(dataRoot, archive) {
  const files = listMonthOrDayFiles(dataRoot, 'person/staging', /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  checkArchiveShaForFiles(archive, dataRoot, files.map((f) => `person/staging/${f.name}`));
  const { items } = readStagingSource(dataRoot);
  const { dbmod, map } = await openV3Modules();
  const t0 = Date.now();
  try {
    const db = dbmod.getDb();
    const insertSql = `INSERT INTO staging (${map.STAGING_COLUMNS.join(', ')}) VALUES (${map.STAGING_COLUMNS.map(() => '?').join(', ')})`;
    dbmod.transaction(() => {
      db.prepare('DELETE FROM staging').run();
      const insert = db.prepare(insertSql);
      // seq 按日文件内行序 1..N（文件时代无 seq 列——插入序即时间序）
      let currentDay = null;
      let seq = 0;
      for (const { day, entry } of items) {
        if (day !== currentDay) { currentDay = day; seq = 0; }
        seq += 1;
        insert.run(...map.stagingToRow(entry, day, seq));
      }
    });
  } finally {
    dbmod.closeDb();
  }
  console.log(`[migrate-v2] staging 迁移完成：${items.length} 行（日文件升序×文件行序；seq=日文件内 1..N）`);
  console.log(`[migrate-v2] 用时 ${Date.now() - t0}ms；旧文件未动（--verify 通过后才允许改名 .pre-storage-v2）`);
}

async function verifyStaging(dataRoot) {
  const { items } = readStagingSource(dataRoot);
  const { dbmod, map } = await openV3Modules();
  let mismatches = 0;
  try {
    const db = dbmod.getDb();
    const rows = db.prepare(`SELECT ${map.STAGING_COLUMNS.join(', ')} FROM staging ORDER BY day, seq`).all();
    console.log(`[migrate-v2] verify staging：源 ${items.length} 条 vs DB ${rows.length} 行（ORDER BY day,seq 位置化比对=日文件序×行序语义）`);
    if (rows.length !== items.length) {
      console.error(`[migrate-v2] ✗ 行数不等：源 ${items.length} vs DB ${rows.length}`);
      mismatches++;
    }
    for (let i = 0; i < Math.min(rows.length, items.length); i++) {
      const dbEntry = map.rowToStaging(rows[i]);
      if (!rowDeepEqual(items[i].entry, dbEntry)) {
        mismatches++;
        if (mismatches <= 5) {
          console.error(`[migrate-v2] ✗ staging 第 ${i + 1} 位（day=${items[i].day}）深度不等：`);
          console.error(`    源: ${normalizeStableJson(items[i].entry).slice(0, 240)}`);
          console.error(`    DB: ${normalizeStableJson(dbEntry).slice(0, 240)}`);
        }
      }
    }
  } finally {
    dbmod.closeDb();
  }
  if (mismatches) failVerify('staging', mismatches);
  console.log(`[migrate-v2] verify 通过：staging ${items.length} 行逐位深度相等 ✓`);
}

// ── V4 state/diary + V5 kv 三段执行体（执行清单 T4.1/T4.2/T4.4；plan §3 state/diary/kv DDL）──────
// 映射层与 person 模块共用（src/storage/state-map.js + diary-map.js）——verify 把 DB 行
// json 解析后与旧文件对象深度比对，等价于证明「切后端后 API 返回与文件时代逐字节一致」。
// 硬校验纪律与 V2/V3 同款：坏数据绝不进库（fail-fast），归档 sha 漂移即拒迁。

function openV4Modules() {
  return Promise.all([
    import('../src/storage/db.js'),
    import('../src/storage/state-map.js'),
    import('../src/storage/diary-map.js')
  ]).then(([dbmod, stateMap, diaryMap]) => ({ dbmod, stateMap, diaryMap }));
}

/** state 段源读取（4 个单对象 JSON；缺文件 = 合法，verify 按「行不存在」比对）。 */
function readStateSource(dataRoot, rel) {
  const abs = path.join(dataRoot, rel);
  if (!fs.existsSync(abs)) return null;
  const parsed = readJsonObject(abs);
  if (!parsed || !parsed.obj) fail(`源文件形状非法：${rel}（${parsed ? parsed.badLines.join('; ') : '读失败'}）`, 2);
  return parsed.obj;
}

async function migrateState(dataRoot, archive) {
  checkArchiveShaForFiles(archive, dataRoot, ['person/mind.json', 'person/relationship.json', 'person/self.json', 'person/life.json']);
  const { dbmod, stateMap } = await openV4Modules();
  const t0 = Date.now();
  const objs = stateMap.STATE_KEYS.map((key) => {
    const rel = `person/${key}.json`;
    return { key, rel, obj: readStateSource(dataRoot, rel) };
  });
  try {
    const db = dbmod.getDb();
    dbmod.transaction(() => {
      // 幂等重跑口径：先清段（只清本段四 key）再全量写
      db.prepare(`DELETE FROM state WHERE key IN (${stateMap.STATE_KEYS.map(() => '?').join(', ')})`).run(...stateMap.STATE_KEYS);
      const insert = db.prepare('INSERT INTO state (key, json, updatedAt) VALUES (?, ?, ?)');
      for (const { key, obj } of objs) {
        if (!obj) continue;   // 缺文件（如数据根无该状态）→ 无行，与「读侧回落空态」语义一致
        // updatedAt 归一 = state-map 契约 2：对象自带有限数字 updatedAt → 原值，否则迁移时刻
        const n = Number(obj.updatedAt);
        const updatedAt = Number.isFinite(n) ? n : Date.now();
        insert.run(key, JSON.stringify(obj), updatedAt);   // 紧凑序列化（键序=文件键序，state-map 契约 1）
      }
    });
  } finally {
    dbmod.closeDb();
  }
  const written = objs.filter((o) => o.obj).map((o) => o.key);
  const absent = objs.filter((o) => !o.obj).map((o) => o.rel);
  console.log(`[migrate-v2] state 迁移完成：${written.join('/') || '（无文件）'} 共 ${written.length} 行（整对象 JSON 列）`);
  if (absent.length) console.log(`[migrate-v2] state 缺文件（合法，无行）：${absent.join(', ')}`);
  console.log(`[migrate-v2] 用时 ${Date.now() - t0}ms；旧文件未动（--verify 通过后才允许改名 .pre-storage-v2）`);
}

async function verifyState(dataRoot) {
  const { dbmod, stateMap } = await openV4Modules();
  let mismatches = 0;
  try {
    const db = dbmod.getDb();
    for (const key of stateMap.STATE_KEYS) {
      const rel = `person/${key}.json`;
      const src = readStateSource(dataRoot, rel);
      const row = db.prepare('SELECT key, json, updatedAt FROM state WHERE key = ?').get(key);
      if (!src) {
        if (row) {
          mismatches++;
          console.error(`[migrate-v2] ✗ ${rel} 源文件不存在但 state 表有 '${key}' 行（不应迁移）`);
        } else {
          console.log(`[migrate-v2] verify state：${rel} 缺文件 ↔ DB 无行 ✓`);
        }
        continue;
      }
      if (!row) {
        mismatches++;
        console.error(`[migrate-v2] ✗ ${rel} 存在但 state 表缺 '${key}' 行`);
        continue;
      }
      if (!rowDeepEqual(src, JSON.parse(String(row.json)))) {
        mismatches++;
        console.error(`[migrate-v2] ✗ state '${key}' json 深度不等：`);
        console.error(`    源: ${normalizeStableJson(src).slice(0, 240)}`);
        console.error(`    DB: ${normalizeStableJson(JSON.parse(String(row.json))).slice(0, 240)}`);
      }
      const u = Number(row.updatedAt);
      if (!Number.isFinite(u)) {
        mismatches++;
        console.error(`[migrate-v2] ✗ state '${key}' updatedAt 非有限数字（NOT NULL 语义破坏）：${JSON.stringify(row.updatedAt)}`);
      }
    }
  } finally {
    dbmod.closeDb();
  }
  if (mismatches) failVerify('state', mismatches);
  console.log('[migrate-v2] verify 通过：state 四 key 逐对象深度相等 + updatedAt 有限 ✓');
}

/** diary 段源读取（readDiaryFile 的 seg 原样版——json 列存文件原文，diary-map 契约 1）。 */
function readDiarySource(dataRoot) {
  const abs = path.join(dataRoot, 'person/diary.jsonl');
  if (!fs.existsSync(abs)) fail(`源文件不存在：${abs}`, 2);
  let text = fs.readFileSync(abs, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const items = [];
  const badLines = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const segs = splitJsonObjects(s);
    if (!segs.length) { badLines.push(s.slice(0, 40)); continue; }
    for (const seg of segs) {
      try {
        const obj = JSON.parse(seg);
        if (obj && typeof obj === 'object') items.push({ obj, seg });
        else badLines.push(seg.slice(0, 40));
      } catch {
        badLines.push(seg.slice(0, 40));
      }
    }
  }
  return { items, badLines };
}

async function migrateDiary(dataRoot, archive) {
  checkArchiveShaForFiles(archive, dataRoot, ['person/diary.jsonl']);
  const { items, badLines } = readDiarySource(dataRoot);
  const { dbmod, diaryMap } = await openV4Modules();
  const t0 = Date.now();
  try {
    const db = dbmod.getDb();
    dbmod.transaction(() => {
      db.prepare('DELETE FROM diary').run();   // 幂等重跑口径：先清段再全量写
      // AUTOINCREMENT 计数归零（重跑 id 从 1 起，导出/序稳定）。sqlite_sequence 表只在
      // 首个 AUTOINCREMENT 插入后才存在——从未插入过的库先探测再删，绝不让迁移因它失败。
      const hasSeq = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get();
      if (hasSeq) db.prepare("DELETE FROM sqlite_sequence WHERE name = 'diary'").run();
      const insert = db.prepare(`INSERT INTO diary (${diaryMap.DIARY_COLUMNS.join(', ')}) VALUES (${diaryMap.DIARY_COLUMNS.map(() => '?').join(', ')})`);
      // 插入序 = 文件行序（粘行拆分序）——id 序 = 文件序，ORDER BY ts,id = readAll 读序（diary-map 契约 3）
      for (const { obj, seg } of items) insert.run(...diaryMap.diaryToRow(obj, seg));
    });
  } finally {
    dbmod.closeDb();
  }
  if (badLines.length) console.log(`[migrate-v2] ⚠️ diary 坏行 ${badLines.length}（未入库，归档文件原样保留）：${badLines.slice(0, 2).join(' | ')}`);
  console.log(`[migrate-v2] diary 迁移完成：${items.length} 行（json=文件原文 seg 原样；ts/mode/title/entry 提取列随行落库；id=文件行序）`);
  console.log(`[migrate-v2] 用时 ${Date.now() - t0}ms；旧文件未动（--verify 通过后才允许改名 .pre-storage-v2）`);
}

async function verifyDiary(dataRoot) {
  const { items, badLines } = readDiarySource(dataRoot);
  const { dbmod, diaryMap } = await openV4Modules();
  let mismatches = 0;
  try {
    const db = dbmod.getDb();
    const rows = db.prepare(`SELECT id, ${diaryMap.DIARY_COLUMNS.join(', ')} FROM diary ORDER BY ts, id`).all();
    console.log(`[migrate-v2] verify diary：源 ${items.length} 条 vs DB ${rows.length} 行（ORDER BY ts,id 位置化比对=readAll 读序语义）`);
    if (rows.length !== items.length) {
      console.error(`[migrate-v2] ✗ 行数不等：源 ${items.length} vs DB ${rows.length}`);
      mismatches++;
    }
    // 读序对位：源按 (at||0) 稳定排序（文件时代 readAll 口径）——真实文件已升序，此处同构实现
    const srcOrdered = [...items].sort((a, b) => (Number(a.obj.at) || 0) - (Number(b.obj.at) || 0));
    for (let i = 0; i < Math.min(rows.length, srcOrdered.length); i++) {
      const { obj } = srcOrdered[i];
      const row = rows[i];
      const dbJson = JSON.parse(String(row.json));
      // ① json 列原文深度相等（零语义损失主口径）
      if (!rowDeepEqual(obj, dbJson)) {
        mismatches++;
        if (mismatches <= 5) {
          console.error(`[migrate-v2] ✗ diary 第 ${i + 1} 位（at=${obj.at}）json 深度不等：`);
          console.error(`    源: ${normalizeStableJson(obj).slice(0, 200)}`);
          console.error(`    DB: ${normalizeStableJson(dbJson).slice(0, 200)}`);
        }
      }
      // ② 提取列派生正确（ts = 读序键——错会直接改变 API 读序）
      const [ts, mode, title, entryCol] = diaryMap.diaryToRow(obj, '');
      if (Number(row.ts) !== ts) { mismatches++; console.error(`[migrate-v2] ✗ diary 第 ${i + 1} 位 ts 提取不等：DB ${row.ts} vs 派生 ${ts}`); }
      if ((row.mode ?? null) !== (mode ?? null)) { mismatches++; console.error(`[migrate-v2] ✗ diary 第 ${i + 1} 位 mode 提取不等`); }
      if ((row.title ?? null) !== (title ?? null)) { mismatches++; console.error(`[migrate-v2] ✗ diary 第 ${i + 1} 位 title 提取不等`); }
      if (String(row.entry) !== entryCol) { mismatches++; console.error(`[migrate-v2] ✗ diary 第 ${i + 1} 位 entry 提取不等`); }
      // ③ API 读回口径二次比对（rowToDiaryEntry 归一 vs 源归一——rowid 序在 (at) 并列时的决胜一致）
      const dbEntry = diaryMap.rowToDiaryEntry(row);
      const srcNorm = diaryMap.rowToDiaryEntry({ json: JSON.stringify(obj) });
      if ((dbEntry === null) !== (srcNorm === null) || (dbEntry && srcNorm && !rowDeepEqual(srcNorm, dbEntry))) {
        mismatches++;
        console.error(`[migrate-v2] ✗ diary 第 ${i + 1} 位 API 读回口径不等（guard/归一漂移）`);
      }
    }
  } catch (e) {
    mismatches++;
    console.error(`[migrate-v2] ✗ diary verify 异常：${e?.message ?? e}`);
  } finally {
    dbmod.closeDb();
  }
  if (badLines.length) console.log(`[migrate-v2] ⚠️ diary 坏行 ${badLines.length}（不入库，与迁移口径一致）`);
  if (mismatches) failVerify('diary', mismatches);
  console.log('[migrate-v2] verify 通过：diary 逐条 json 原文深度相等 + 提取列派生 + API 读回口径 ✓');
}

/** kv 段源读取：reminders.json（缺文件合法——夜0 时数据根即无此文件）+ cross-turn/main.json。 */
function readKvSource(dataRoot, rel, shape) {
  const abs = path.join(dataRoot, rel);
  if (!fs.existsSync(abs)) return null;
  const parsed = readJsonObject(abs);
  if (!parsed || !parsed.obj) fail(`源文件形状非法：${rel}（${parsed ? parsed.badLines.join('; ') : '读失败'}）`, 2);
  if (shape === 'reminders' && !Array.isArray(parsed.obj.reminders)) {
    fail(`源文件形状非法：${rel}（reminders 数组缺失）`, 2);
  }
  return parsed.obj;
}

async function migrateKv(dataRoot, archive) {
  // reminders.json 不在夜0 归档清单（当时不存在）——若现在出现，说明迁移窗口内有新写入：
  // 按「先归档再迁移」铁律拒绝（夜0 drift③ 登记：出现时按迁移前现采快照处理）。
  const manifest = archiveManifest(archive);
  const rels = [
    { rel: 'reminders.json', key: 'reminders', shape: 'reminders' },
    { rel: 'cross-turn/main.json', key: 'transition', shape: 'plain' }   // W6-②：kv 行键 cross-turn→transition（源文件名不变=历史布局）
  ];
  for (const { rel } of rels) {
    if (fs.existsSync(path.join(dataRoot, rel)) && !manifest.has(rel)) {
      fail(`真身漂移：data/${rel} 存在但夜0 归档清单无此条目——先重新归档（迁移前现采快照）再迁移`, 1);
    }
  }
  checkArchiveShaForFiles(archive, dataRoot, rels.filter((r) => fs.existsSync(path.join(dataRoot, r.rel))).map((r) => r.rel));
  const { dbmod, stateMap } = await openV4Modules();
  const t0 = Date.now();
  const rows = [];
  for (const { rel, key, shape } of rels) {
    const obj = readKvSource(dataRoot, rel, shape);
    if (!obj) continue;
    const n = Number(obj.at);   // cross-turn 载荷自带 at（业务字段）→ 作 updatedAt；reminders 容器无 → 迁移时刻
    rows.push({ key, obj, updatedAt: Number.isFinite(n) ? n : Date.now() });
  }
  try {
    const db = dbmod.getDb();
    dbmod.transaction(() => {
      db.prepare(`DELETE FROM kv WHERE k IN (${stateMap.KV_KEYS.map(() => '?').join(', ')})`).run(...stateMap.KV_KEYS);   // 幂等重跑：只清本段两 k
      const insert = db.prepare('INSERT INTO kv (k, v, updatedAt) VALUES (?, ?, ?)');
      for (const { key, obj, updatedAt } of rows) insert.run(key, JSON.stringify(obj), updatedAt);
    });
  } finally {
    dbmod.closeDb();
  }
  const written = rows.map((r) => r.key);
  console.log(`[migrate-v2] kv 迁移完成：${written.join('/') || '（两源均缺文件，无行）'} 共 ${written.length} 行（v=原文件整对象）`);
  console.log(`[migrate-v2] 用时 ${Date.now() - t0}ms；旧文件未动（--verify 通过后才允许改名 .pre-storage-v2）`);
}

async function verifyKv(dataRoot) {
  const { dbmod, stateMap } = await openV4Modules();
  let mismatches = 0;
  try {
    const db = dbmod.getDb();
    const cases = [
      { rel: 'reminders.json', key: 'reminders', shape: 'reminders' },
      { rel: 'cross-turn/main.json', key: 'transition', shape: 'plain' }   // W6-② 同上
    ];
    for (const { rel, key, shape } of cases) {
      const src = readKvSource(dataRoot, rel, shape);
      const row = db.prepare('SELECT k, v, updatedAt FROM kv WHERE k = ?').get(key);
      if (!src) {
        if (row) { mismatches++; console.error(`[migrate-v2] ✗ ${rel} 缺文件但 kv 表有 '${key}' 行（不应迁移）`); }
        else console.log(`[migrate-v2] verify kv：${rel} 缺文件 ↔ DB 无行 ✓`);
        continue;
      }
      if (!row) { mismatches++; console.error(`[migrate-v2] ✗ ${rel} 存在但 kv 表缺 '${key}' 行`); continue; }
      if (!rowDeepEqual(src, JSON.parse(String(row.v)))) {
        mismatches++;
        console.error(`[migrate-v2] ✗ kv '${key}' v 深度不等：`);
        console.error(`    源: ${normalizeStableJson(src).slice(0, 240)}`);
        console.error(`    DB: ${normalizeStableJson(JSON.parse(String(row.v))).slice(0, 240)}`);
      }
      if (!Number.isFinite(Number(row.updatedAt))) { mismatches++; console.error(`[migrate-v2] ✗ kv '${key}' updatedAt 非有限数字`); }
    }
  } finally {
    dbmod.closeDb();
  }
  if (mismatches) failVerify('kv', mismatches);
  console.log('[migrate-v2] verify 通过：kv 两 k 逐对象深度相等 + updatedAt 有限 ✓');
}

function failVerify(section, mismatches) {
  console.error(`[migrate-v2] verify ${section} 失败：${mismatches} 处不等——不切换、不删除、不上报成功（DB 删重建重来）`);
  process.exit(2);
}

async function runMigrateOrVerify(dataRoot, mode) {
  const sections = resolveSections(onlyArg);
  // 前置硬闸（V2+ 起生效；V1 骨架先于 impl 检查就位——顺序保证"未实现"优先报，不误触真实数据）
  for (const sec of sections) {
    if (!sec.impl) {
      console.error(`[migrate-v2] --${mode} --only ${sec.id}：该段迁移执行体属 ${sec.phase}（本骨架未实现）——不做任何写入，exit 3。`);
      process.exit(3);
    }
  }
  // 前置硬闸（plan §6 + 执行纪律 3）：应用未运行 + 全量归档在位
  const app = checkAppClosed();
  if (app.closed !== true) {
    fail(`应用关闭硬闸未过：检测到 xunxi/electron 进程：${(app.processes || []).join(' | ')}`, 1);
  }
  const archive = locateArchive();
  if (!archive.found) {
    fail(`归档硬闸未过：找不到 pre-storage-v2/sha256sums.txt（试过：${(archive.tried || []).join(' | ')}）——全量归档是一切切换的前提`, 1);
  }
  console.log(`[migrate-v2] 前置硬闸：应用关闭 ✓  归档 ${archive.dir} ✓`);
  for (const sec of sections) {
    if (mode === 'migrate') await sec.impl.migrate(dataRoot, archive);
    else await sec.impl.verify(dataRoot, archive);
  }
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
if (mode === 'self-test') runSelfTest();

// 数据根显式纪律（ask 硬规则 5）：真实数据根在仓库外，资源目录里的 data/ 是历史残留——
// 缺显式 env 一律拒绝，防止误把 resources/app/data 当真身。
const DATA_ROOT = process.env.XUNXI_DATA_DIR || '';
if (!DATA_ROOT) {
  fail('必须显式设置 XUNXI_DATA_DIR（数据根动作显式化纪律）——例：XUNXI_DATA_DIR=<数据根绝对路径> node tools/migrate-storage-v2.mjs --dry-run');
}
if (!fs.existsSync(DATA_ROOT)) fail(`数据根不存在：${DATA_ROOT}`);

if (mode === 'dry-run') runDryRun(DATA_ROOT);
else await runMigrateOrVerify(DATA_ROOT, mode);
