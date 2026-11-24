// replay.mjs —— Phase 0 基线回放（重构执行清单-细化.md T0.2）
//
// 职责：只读 <数据根>/sessions/*.json，选 10 个有效会话，固化「现在的提示词/工具
// 行为」为可比较的基线 tools/baseline.json。后续每个 Phase 结束后重跑一遍，
// 用 diff-baseline.mjs 对比，任何提示词组装层/工具层的意外变化都会被抓出来。
//
// 硬约束：
//   · 只读数据根，不写 data/ 下任何运行数据；
//   · 0 次模型调用、0 次网络请求（不 import llm.js / 任何协议端模块）；
//   · 输出原子写（tmp + rename），读取容忍 BOM；
//   · 确定性：除 generatedAt 外，两次运行输出必须逐字节一致。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url)); // .../resources/app/tools
const APP_ROOT = path.resolve(TOOLS_DIR, '..');                 // .../resources/app

// ── 数据根解析 ──────────────────────────────────────────────────────────────
// 语义与 src/config.js:24 一致：XUNXI_DATA_DIR 优先，否则从脚本位置推导。
// ⚠️ 细化清单 §0 写的 "../../data" 少算了一级：本脚本在 resources/app/tools，
// 距真实数据根 <应用根>/data 实际是三级（tools → app → resources → Xunxi）。
// 因此这里按 "../../../data" 推导，并在解析后校验 sessions/ 目录存在且非空，
// 解析不到真实数据根就立刻报错退出 —— 绝不静默指向空目录读出 0 个会话。
const ENV_DATA_ROOT = process.env.XUNXI_DATA_DIR || '';
const DATA_ROOT = path.resolve(ENV_DATA_ROOT || path.join(TOOLS_DIR, '..', '..', '..', 'data'));
const SESSIONS_DIR = path.join(DATA_ROOT, 'sessions');

function fail(msg) {
  console.error(`[replay] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(SESSIONS_DIR)) {
  fail(`数据根解析失败：${SESSIONS_DIR} 不存在（XUNXI_DATA_DIR=${ENV_DATA_ROOT || '<未设置>'}）。`);
}

// ── renderSmoke 的环境隔离（确定性关键）────────────────────────────────────
// prompt.js → config.js 在被 import 时用 XUNXI_DATA_DIR 推导 DATA_DIR。
// 若放任环境变量生效，buildSystemPrompt({}) 会读到「当时那台机器的活配置」，
// 两次运行（或换一个环境再跑）就可能不一致。这里把变量固定指向一个**不存在**
// 的目录：config.js 的 loadConfig 对 ENOENT 的处理是纯回落 DEFAULT_CONFIG、
// 无任何写盘副作用（config.js:415-441 只在文件存在且损坏时才改名备份），
// 于是 renderSmoke 只依赖代码里的默认值，跨环境逐字节稳定。
const RENDER_SMOKE_DATA_DIR = path.join(TOOLS_DIR, '.tmp', 'render-smoke-no-config');

// ── 小工具 ─────────────────────────────────────────────────────────────────
const sha1 = (text) => crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpNum = (a, b) => a - b;
// 组内统一兜底排序键：id 升序，保证任何并列都有确定次序。
const byId = (a, b) => cmpStr(a.id, b.id);

function readJsonTolerantBom(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

// 【记忆】段的结束边界：按 prompt.js buildUserPrompt 的段序，记忆段之后只会
// 出现这些顶层标题。⚠️ 对 T0.2 原文「到下一个【标题之间」的一处必要修正：
// 记忆段内部自带子标题（【对群友的印象】，现行 memory.js 为【对聊天对象的印象】），
// 按"下一个【"截断会把段内所有条目截掉 —— 实测 418 个会话全部因此恒为 0，
// "注入的记忆行数"作为回归信号就废了。故边界取"下一个顶层段标题"。
const MEM_SECTION_ENDERS = ['【已读信息】', '【新已读信息】', '【未读信息】', '【新加入的人】', '【活跃模式】', '【当前时间】'];

/** 【记忆】标题后到下一个顶层段标题之间的非空行数（无该段记 0）。 */
function countMemoryLines(userPrompt) {
  const s = String(userPrompt ?? '');
  const start = s.indexOf('【记忆】');
  if (start < 0) return 0;                       // 无该段记 0
  const close = s.indexOf('】', start);
  if (close < 0) return 0;
  let end = s.length;
  for (const h of MEM_SECTION_ENDERS) {
    const i = s.indexOf(h, close + 1);
    if (i >= 0 && i < end) end = i;
  }
  return s.slice(close + 1, end).split('\n').filter((line) => line.trim().length > 0).length;
}

// ── 第 1 步：扫描会话目录（每文件读+解析一次，只保留小摘要）───────────────
const t0 = Date.now();
const errors = [];   // { file, error }，按 file 排序后输出
const scan = [];     // 候选摘要

const files = fs.readdirSync(SESSIONS_DIR)
  .filter((f) => f.toLowerCase().endsWith('.json'))
  .sort(cmpStr);

for (const file of files) {
  let j;
  try {
    j = readJsonTolerantBom(path.join(SESSIONS_DIR, file));
  } catch (error) {
    errors.push({ file, error: String(error?.message ?? error) });
    continue;
  }
  // 候选条件（T0.2 选样规则 1）：status ∈ {done, noreply} 且 systemPrompt 非空
  // 且 messages 为数组。不满足的文件只是「非候选」，不算错误。
  const status = j?.status;
  if (status !== 'done' && status !== 'noreply') continue;
  if (typeof j.systemPrompt !== 'string' || j.systemPrompt.length === 0) continue;
  if (!Array.isArray(j.messages)) continue;

  // 工具名收集（容错：tool_calls / function / name 可能缺失）
  const toolSet = new Set();
  for (const m of j.messages) {
    if (m && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const name = tc?.function?.name;
        if (name) toolSet.add(String(name));
      }
    }
  }

  scan.push({
    file,
    id: j.id == null ? '' : String(j.id),
    chatKey: j.chatKey == null ? '' : String(j.chatKey),
    startedAt: j.startedAt,
    rounds: j.rounds,
    pam: j.promptAnchorMode,
    sysPrompt: j.systemPrompt,
    usrPrompt: j.userPrompt,
    toolNames: [...toolSet].sort(cmpStr)
  });
}

// 记录必需字段校验：任何取不到（undefined/null/空串）→ 记入 errors[] 并继续。
// 校验通过后才进入选样池，保证选出来的 10 个一定构得出完整记录。
const pool = [];
for (const s of scan) {
  const bad = [];
  if (!s.id) bad.push('id');
  if (!s.chatKey) bad.push('chatKey');
  if (typeof s.startedAt !== 'number') bad.push('startedAt');
  if (typeof s.rounds !== 'number') bad.push('rounds');
  if (typeof s.pam !== 'string' || !s.pam) bad.push('promptAnchorMode');
  if (typeof s.usrPrompt !== 'string') bad.push('userPrompt');
  if (bad.length) {
    errors.push({ file: s.file, error: `字段取不到：${bad.join('/')}` });
    continue;
  }
  pool.push(s);
}

// ── 第 2 步：选样（互斥去重，一个会话只进一组）────────────────────────────
const privates = pool.filter((s) => s.chatKey.startsWith('private:'));
const groups = pool.filter((s) => !s.chatKey.startsWith('private:'));

// 规则 2：优先私聊；group: 只在私聊不足 10 时补位（按 startedAt 最新补）。
let candidates = privates.slice();
if (candidates.length < 10) {
  candidates = candidates.concat(
    groups.slice().sort((a, b) => cmpNum(b.startedAt, a.startedAt) || byId(a, b))
  );
}

const taken = new Set();
const pickFrom = (list, n) => {
  const out = [];
  for (const s of list) {
    if (out.length >= n) break;
    if (taken.has(s.id)) continue;
    taken.add(s.id);
    out.push(s);
  }
  return out;
};

const toolCount = (s) => s.toolNames.length;
const coverage = {};   // 各组合实际选到几个，用于 selectionNote

// 长会话 2：rounds ≥ 8，取 rounds 最大（并列按 id 升序）
coverage.long = pickFrom(
  candidates.filter((s) => s.rounds >= 8).sort((a, b) => cmpNum(b.rounds, a.rounds) || byId(a, b)),
  2
).length;
// 短会话 2：rounds ≤ 2，取 rounds 最小（并列按 id 升序）
coverage.short = pickFrom(
  candidates.filter((s) => s.rounds <= 2).sort((a, b) => cmpNum(a.rounds, b.rounds) || byId(a, b)),
  2
).length;
// 有工具调用 3：取工具种类最多（并列按 id 升序）
coverage.withTools = pickFrom(
  candidates.filter((s) => toolCount(s) > 0).sort((a, b) => cmpNum(toolCount(b), toolCount(a)) || byId(a, b)),
  3
).length;
// 无工具调用 2：同上相反（本数据集里 0 个 —— 所有候选的 messages 都含非空
// tool_calls，因为 finish / send_message 等都记为 tool_calls；差额走末尾补齐）
coverage.noTools = pickFrom(
  candidates.filter((s) => toolCount(s) === 0).sort(byId),
  2
).length;
// 近期会话 1：startedAt 最新（并列按 id 升序）
coverage.recent = pickFrom(
  candidates.slice().sort((a, b) => cmpNum(b.startedAt, a.startedAt) || byId(a, b)),
  1
).length;

// 不足 10 个时从剩余候选按 startedAt 最新补齐
let selected = [...taken].length ? candidates.filter((s) => taken.has(s.id)) : [];
if (selected.length < 10) {
  const rest = candidates
    .filter((s) => !taken.has(s.id))
    .sort((a, b) => cmpNum(b.startedAt, a.startedAt) || byId(a, b));
  for (const s of rest) {
    if (selected.length >= 10) break;
    taken.add(s.id);
    selected.push(s);
  }
  coverage.fill = selected.length - (coverage.long + coverage.short + coverage.withTools + coverage.noTools + coverage.recent);
} else {
  coverage.fill = 0;
}

// 输出顺序确定性：按 startedAt 升序、id 升序
selected.sort((a, b) => cmpNum(a.startedAt, b.startedAt) || byId(a, b));

const shortfall = [];
if (coverage.long < 2) shortfall.push(`长会话 ${coverage.long}/2`);
if (coverage.short < 2) shortfall.push(`短会话 ${coverage.short}/2`);
if (coverage.withTools < 3) shortfall.push(`有工具 ${coverage.withTools}/3`);
if (coverage.noTools < 2) shortfall.push(`无工具 ${coverage.noTools}/2（候选池中没有 messages 全部不含非空 tool_calls 的会话）`);
if (coverage.recent < 1) shortfall.push(`近期 ${coverage.recent}/1`);
const selectionNote = [
  `候选 ${pool.length} 个（私聊 ${privates.length}，群聊 ${groups.length}）`,
  `组合覆盖：长${coverage.long} 短${coverage.short} 有工具${coverage.withTools} 无工具${coverage.noTools} 近期${coverage.recent}`,
  coverage.fill > 0 ? `按 startedAt 最新补 ${coverage.fill} 个` : '无需补齐',
  shortfall.length ? `未达标组：${shortfall.join('；')}` : '全部组合达标'
].join('；');

// ── 第 3 步：构建每会话记录（T0.2 字段清单）────────────────────────────────
const SECTION_RE = /【[^】]{1,12}】/g;
const sessions = selected.map((s) => ({
  id: s.id,
  chatKey: s.chatKey,
  startedAt: s.startedAt,
  rounds: s.rounds,
  sysHash: sha1(s.sysPrompt),
  usrHash: sha1(s.usrPrompt),
  sysChars: s.sysPrompt.length,
  usrChars: s.usrPrompt.length,
  sections: [...new Set((s.sysPrompt + '\n' + s.usrPrompt).match(SECTION_RE) || [])].sort(cmpStr),
  tools: s.toolNames.slice(),
  memoryLines: countMemoryLines(s.usrPrompt),
  promptAnchorMode: s.pam
}));

// ── 第 4 步：renderSmoke（动态 import 当前 src/prompt.js，异常不崩溃）──────
let renderSmoke;
try {
  process.env.XUNXI_DATA_DIR = RENDER_SMOKE_DATA_DIR;   // 先固定环境，再 import
  const promptModule = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'prompt.js')).href);
  const rendered = promptModule.buildSystemPrompt({});
  renderSmoke = { ok: true, chars: String(rendered).length, hash: sha1(rendered) };
} catch (error) {
  renderSmoke = { ok: false, error: String(error?.message ?? error) };
}

// ── 第 5 步：输出（原子写 tmp + rename）────────────────────────────────────
const argv = process.argv.slice(2);
let outArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') {
    if (i + 1 >= argv.length) fail('--out 需要一个路径参数');
    outArg = argv[++i];
  } else if (argv[i]?.startsWith('--out=')) {
    outArg = argv[i].slice('--out='.length);
  }
}
const OUT_FILE = path.resolve(outArg || path.join(TOOLS_DIR, 'baseline.json'));

const doc = {
  generatedAt: Date.now(),
  dataRoot: DATA_ROOT,
  selectionNote,
  sessions,
  errors: errors.slice().sort((a, b) => cmpStr(a.file, b.file) || cmpStr(a.error, b.error)),
  renderSmoke
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
const tmpFile = `${OUT_FILE}.${process.pid}.tmp`;
fs.writeFileSync(tmpFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
fs.renameSync(tmpFile, OUT_FILE);

const ms = Date.now() - t0;
const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
console.error(`[replay] sessions=${sessions.length} errors=${errors.length} ` +
  `renderSmoke=${renderSmoke.ok ? 'ok' : 'FAIL'} elapsed=${ms}ms rss=${rssMb}MB -> ${OUT_FILE}`);
if (!renderSmoke.ok) console.error('[replay] renderSmoke 失败：' + renderSmoke.error);
