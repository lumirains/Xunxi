// check-boundaries.mjs —— 边界门禁（v3 清单 §5 步骤② T2.1；门禁命令进 v3 每步清单）
//
// 职责：扫描 src/kernel/**、src/person/**、src/capabilities/**（前额叶 + 能力层，含子目录递归，
//       目录不存在则跳过）与 src/tools.js（皮层工具集，Phase 8b 移入扫描）下的 js 模块，
//       禁止 import 身体层：
//         · 身体模块基名（onebot.js / sender.js，Q11 起为 legacy/ 归档件）——相对说明符按
//           import 语义解析后基名命中即报（覆盖 ./、../、../../ 各深度与任意目录深度）；
//         · surfaces/ —— 以任何相对形式 import（路径段精确匹配 'surfaces'）。
//       大脑/前额叶不得触碰身体——合法耦合通道只有两条：调度器调用进来、前额叶 API（v3 §1）。
//
// 豁免登记（文件不在扫描范围内，登记在此显式声明而非沉默遗漏）：
//   src/app.js                    装配层（createApp；Q11 起 QQ 身体已归档，装配零身体依赖，
//                                 不在扫描目录——本条目为声明性登记）
//   Q11（2026-11-12）：src/sender.js / src/onebot.js 已 git mv 归档出 src 根
//   （legacy/sender-qq.js / legacy/onebot.js，night-plan §Q11）——原"身体本体不在扫描范围"
//   两条目随之注销。基名规则（base === 'onebot.js' / 'sender.js'）保留：对归档件的
//   import 边同样违法，不依赖目标文件存在。
//
// Phase 8b 变更（拆分表 #6/#7 消亡）：src/tools.js 自豁免清单移入扫描——原"过渡期直呼
// 身体模块（expandForwardNodes import）"的豁免随 Phase 8b 调用点转换（ctx.emit /
// ctx.surface）到期撤销，此后 tools.js 禁止 import 身体模块 / surfaces/。
// Q11 变更：身体本体归档 legacy/（sender-qq.js / onebot.js / qq-adapter/），基名与
// surfaces/ 规则保留（对归档件的 import 边同样违法）。
//
// P1 变更（架构清单 §6-P2「插件不是法外之地」/ night-plan §4.5）：扫描范围扩展到
//   plugins/ 与 skills/（代码根下的扩展目录，与 src/ 平行）。命中身体模块基名的
//   import → FAIL；确需旁路的在下方 EXT_WHITELIST（数组常量 + 注释原因）登记，
//   命中文件照常打印、不计违规。范围说明：本门禁查的是**模块依赖边**（import/require），
//   运行期句柄不是 import 边，不在本门禁射程内 —— 工具/插件侧的句柄收窄已在 P3 完成
//  （night-plan §6.3：工具 ctx 移除发送/协议句柄，读回走 ctx.surface.call 窄通道）。
//
// 形态：先做去注释词法（行/块注释替换为等长空白；识别单双引号串、模板串含 ${} 嵌套、
//       正则字面量启发式），再在净化文本上整体匹配——规定两种形态为
//       静态 import（含裸副作用式 `import 'x'`、多行命名导入）与动态 import('…')；
//       另兜住 export … from 与 require() 同类依赖边（超集，宁可多报不漏报）。
//       容忍 UTF-8 BOM；注释里出现禁词不报（不构成运行时依赖）。
//       计算型说明符（import(变量)、模板串插值路径）超出静态检查能力，不在此列。
//
// 输出：违规 → 逐条打印 `文件:行: import 内容` → exit 1；
//       全部干净 → 打印 `BOUNDARIES OK` + 豁免清单 + 扫描统计 → exit 0。
// 自测：argv[2] 可覆盖扫描根（默认 = 本文件所在目录的 ../src），供离线负例自测使用
//       （plugins/skills 扩展根随扫描根的父目录走，覆盖语义保持一致）。
//
// 零副作用：只读，不写任何文件，不调模型，不访问网络。
// 已知边界：正则字面量用启发式识别（前导为标点/关键字判正则、前导为标识符/)]/引号判除号），
//           `} / 2` 这类对象字面量后接除号可能误入正则态——只可能漏报该行，不会误报。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(process.argv[2] || path.join(TOOL_DIR, '..', 'src'));

const SCAN_DIRS = ['kernel', 'person', 'capabilities'];
// Phase 8b：皮层工具集移入扫描（src 根单文件；原豁免登记撤销，理由见文件头）。
const SCAN_ROOT_FILES = ['tools.js'];
const MODULE_EXT = /\.(js|mjs|cjs)$/i; // .mjs/.cjs 一并扫描（同为 js 模块；dev 脚本在内）

// P1（night-plan §4.5）：扩展扫描根 —— 代码根下的 plugins/ 与 skills/（与 src/ 平行，
// 不在 src 内）。随 SRC_ROOT 的父目录走：argv[2] 覆盖 src 时，扩展根 = 覆盖目录的兄弟目录。
const APP_ROOT = path.resolve(SRC_ROOT, '..');
const EXT_SCAN_ROOTS = [
  { root: path.join(APP_ROOT, 'plugins'), prefix: 'plugins' },
  { root: path.join(APP_ROOT, 'skills'), prefix: 'skills' },
];

const BODY_FILES = [
  // Q11：身体本体已归档出 src 根（legacy/）。基名规则（下方 classify）仍拦截对
  // 'onebot.js'/'sender.js' 的任意相对 import（不依赖本表文件存在）；本表保留解析
  // 路径兜底，若身体文件将来回迁 src 根即自动恢复深层路径拦截。
  { abs: path.resolve(SRC_ROOT, 'onebot.js'), label: 'onebot.js（身体，Q11 归档）' },
  { abs: path.resolve(SRC_ROOT, 'sender.js'), label: 'sender.js（身体，Q11 归档）' },
];
const SURFACES_DIR = path.resolve(SRC_ROOT, 'surfaces');

// —— 豁免登记（键 = 相对 src 根的 posix 路径）——
const EXEMPT = new Map([
  ['app.js', '装配层（createApp；Q11 起 QQ 身体已归档 legacy/，装配零身体依赖）'],
]);

// ── 扩展白名单（P1 · night-plan §4.5：数组常量 + 注释原因，不许沉默遗漏）──────
// 命中规则：被扫文件相对代码根的 posix 路径（'plugins/…' / 'skills/…'）以 entry.path
// 前缀开头（目录条目覆盖其下全部文件，含 selftest 等附属脚本）。命中照常打印、不计违规。
// 登记纪律：新增豁免必须写清原因与撤销条件；原因消失（重构完成）时删条目 ——
// 零命中的条目会在扫描末尾打"可清理"提示（提示不判失败）。
//
// Q5 注销留痕（night-plan-qq-exit.md §Q5，2026-11-12）：原唯一条目
//   { path: 'plugins/sticker-send-as-emoji/', reason: '原型补丁（OneBotClient.prototype.sendSticker
//    补 sub_type=1），登记待重构' }
// 已随条目原因未竟的重构一并按登记纪律注销——条目对扫描零命中：整目录 git mv 归档出
// 扫描根（plugins/ → legacy/，不在 EXT_SCAN_ROOTS），命中规则的前缀再无匹配。原件（含
// selftest.mjs 与本登记原因全文）原保留在 legacy/sticker-send-as-emoji/ 供对照——
// 2026-11-19 全库体检起 legacy/ 整目录 git rm（零引用实证，git 历史即归档，
// 内部文档 codebase-audit-20261119.md §五）；若将来回迁 plugins/ 复活该补丁，从 git 历史
// 取件并必须重新登记本条目（撤销条件不变：onebot.js 的 sendSticker 自己带
// sub_type，届时升级不再冲掉修正）。
const EXT_WHITELIST = [
  // daily-diary 的 cookies 用途：复核结果=不存在（T6.2 瘦身后该插件无 get_cookies 调用，
  // OneBotClient import 与实例构造已于 P1 删除，发送统一走 api.sendText）—— 无需登记。
  // skills/qqzone 的 get_cookies：P3 ctx 收窄后走 ctx.surface.call 窄通道（工具 ctx）与
  // api.onebot() 窄包装（定时任务，只带 call），不是 import 边，也不在工具 ctx 里留句柄本体。
  // （Q5 起该技能已 git mv 归档出扫描根 → legacy/qqzone/，同样从未需要登记条目。）
];

/* ================= 去注释词法 ================= */
// 注释替换为等长空白（保留换行，行号不漂移）；正则字面量内容同样抹除（其内部不可能携带合法
// import 说明符，抹除避免字面量里的引号/斜杠扰乱后续匹配）；字符串与模板内容保留——
// 动态 import('…') 的说明符就住在字符串里。

const REGEX_PRECEDERS = new Set(['(', '[', '{', ',', ';', '=', ':', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'case', 'do', 'else', 'yield', 'await', 'void', 'throw']);

function regexAllowedBefore(out, idx) {
  let j = idx - 1;
  while (j >= 0 && (out[j] === ' ' || out[j] === '\t' || out[j] === '\n' || out[j] === '\r')) j--;
  if (j < 0) return true;
  const c = out[j];
  if (/[\w$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[\w$]/.test(out[k])) k--;
    return REGEX_KEYWORDS.has(out.slice(k + 1, j + 1).join(''));
  }
  if (c === ')' || c === ']' || c === "'" || c === '"' || c === '`' || c === '/') return false; // 视为除号
  return true;
}

function stripComments(text) {
  const out = text.split('');
  const n = out.length;
  // 栈底恒为 code；'tpl' = 模板串体；'code'+depth = 模板 ${ } 插值（depth 记插值内大括号配对）
  const stack = [{ t: 'code' }];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < n) {
    const t = top();
    if (t.t === 'code') {
      if (t.depth !== undefined) { // 插值内大括号跟踪（对象字面量嵌套）
        if (out[i] === '{') { t.depth++; i++; continue; }
        if (out[i] === '}') {
          if (t.depth === 0) { stack.pop(); i++; continue; } // } 归还模板语法
          t.depth--; i++; continue;
        }
      }
      const c = out[i];
      const c2 = i + 1 < n ? out[i + 1] : '';
      if (c === '/' && c2 === '/') { // 行注释
        while (i < n && out[i] !== '\n') { out[i] = ' '; i++; }
        continue;
      }
      if (c === '/' && c2 === '*') { // 块注释
        out[i] = ' '; out[i + 1] = ' '; i += 2;
        while (i < n && !(out[i] === '*' && i + 1 < n && out[i + 1] === '/')) {
          if (out[i] !== '\n') out[i] = ' '; i++;
        }
        if (i + 1 < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
        continue;
      }
      if (c === '/' && regexAllowedBefore(out, i)) { // 正则字面量：保留两个 '/'，内容抹除
        i++;
        let inClass = false;
        while (i < n) {
          const rc = out[i];
          if (rc === '\\') { out[i] = ' '; if (i + 1 < n) out[i + 1] = ' '; i += 2; continue; }
          if (rc === '\n') break; // 未闭合跨行 → 交还 code 态（只可能漏报不误报）
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) { i++; break; }
          out[i] = ' '; i++;
        }
        continue;
      }
      if (c === "'") { stack.push({ t: 'sq' }); i++; continue; }
      if (c === '"') { stack.push({ t: 'dq' }); i++; continue; }
      if (c === '`') { stack.push({ t: 'tpl' }); i++; continue; }
      i++; continue;
    }
    if (t.t === 'sq' || t.t === 'dq') {
      const c = out[i];
      if (c === '\\') { i += 2; continue; }
      if ((t.t === 'sq' && c === "'") || (t.t === 'dq' && c === '"')) stack.pop();
      i++; continue;
    }
    // tpl：模板串体
    if (out[i] === '\\') { i += 2; continue; }
    if (out[i] === '`') { stack.pop(); i++; continue; }
    if (out[i] === '$' && i + 1 < n && out[i + 1] === '{') { stack.push({ t: 'code', depth: 0 }); i += 2; continue; }
    i++;
  }
  return out.join('');
}

/* ================= 说明符提取 ================= */
// 规定两种形态：静态 import（含裸副作用式/多行）与动态 import('…')；
// export…from / require() 为同类依赖边，兜底扫描。
const SPEC_PATTERNS = [
  { kind: 'import', re: /\bimport\b\s*(?:[\w$*{},\s]*?\s*from\s*)?(['"])((?:\\.|[^'\\\n])*)\1/g },
  { kind: 'import()', re: /\bimport\b\s*\(\s*(['"])((?:\\.|[^'\\\n])*)\1(?:\s*\))?/g },
  { kind: 'export-from', re: /\bexport\b\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^{}]*\})\s*from\s*(['"])((?:\\.|[^'\\\n])*)\1/g },
  { kind: 'require', re: /\brequire\b\s*\(\s*(['"])((?:\\.|[^'\\\n])*)\1(?:\s*\))?/g },
];

function lineOf(text, idx) {
  let line = 1;
  for (let k = 0; k < idx; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

/* ================= 违规判定 ================= */
// 仅相对说明符（'.' 开头）受门禁约束；裸说明符 = 内建/包，不受限。
function classify(spec, fileAbs) {
  const hits = [];
  if (!spec.startsWith('.')) return hits;
  const segs = spec.split('/');
  if (segs.includes('surfaces')) hits.push('surfaces/（身体层，任何相对形式）');
  const base = segs[segs.length - 1];
  if (base === 'onebot.js' || base === 'sender.js') {
    // T2.1 枚举的 './onebot.js'、'../onebot.js'（及 ./x、../x 同名末段）——先报，不依赖目标文件存在
    hits.push(`${base}（身体）`);
  } else {
    const resolved = path.resolve(path.dirname(fileAbs), spec);
    const withExt = /\.js$/i.test(resolved) ? resolved : `${resolved}.js`;
    for (const b of BODY_FILES) {
      if (resolved === b.abs || withExt === b.abs) hits.push(b.label); // 深层 ../../ 等，解析后命中身体本体
    }
    if (resolved === SURFACES_DIR || resolved.startsWith(SURFACES_DIR + path.sep) || withExt.startsWith(SURFACES_DIR + path.sep)) {
      hits.push('surfaces/（身体层）');
    }
  }
  return [...new Set(hits)];
}

function listModules(dir, prefix, relPrefix = 'src/') {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { files: [], missing: true };
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const e of entries) {
    if (e.isDirectory() && e.name === 'node_modules') continue; // 依赖包不是被审代码
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) files.push(...listModules(path.join(dir, e.name), rel, relPrefix).files);
    else if (e.isFile() && MODULE_EXT.test(e.name)) files.push({ abs: path.join(dir, e.name), rel: `${relPrefix}${rel}` });
  }
  return { files, missing: false };
}

function scanFile(item) {
  let raw;
  try {
    raw = fs.readFileSync(item.abs, 'utf8');
  } catch (err) {
    return { findings: [], error: `${item.rel} 读取失败：${err.message}` };
  }
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // 容忍 BOM
  const stripped = stripComments(text);
  const findings = [];
  for (const { kind, re } of SPEC_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(stripped)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; } // 防空匹配死循环
      findings.push({
        line: lineOf(stripped, m.index),
        spec: m[2],
        stmt: m[0].replace(/\s+/g, ' ').trim(),
        kind,
      });
    }
  }
  return { findings, error: null };
}

/* ================= 主流程 ================= */
const scannedDirs = [];
const scannedRootFiles = [];
const scannedExtRoots = [];
const violations = [];
const errors = [];
const exemptHits = [];
const whitelistedHits = [];
const wlMatchCount = new Map();
const seen = new Map();
let total = 0;

/** 单文件违规归并（目录扫描与 src 根文件扫描共用）。 */
function collectViolations(item) {
  // P1 扩展白名单（plugins/skills）：路径前缀命中 → 打印登记、不计违规。
  const wl = EXT_WHITELIST.find((w) => item.rel === w.path || item.rel.startsWith(w.path));
  if (wl) {
    wlMatchCount.set(wl, (wlMatchCount.get(wl) || 0) + 1);
    whitelistedHits.push(`${item.rel} —— ${wl.reason}`);
    return;
  }
  if (item.rel.startsWith('src/') && EXEMPT.has(item.rel.slice('src/'.length))) {
    exemptHits.push(`${item.rel} —— ${EXEMPT.get(item.rel.slice('src/'.length))}`);
    return;
  }
  const { findings, error } = scanFile(item);
  if (error) { errors.push(error); return; }
  for (const f of findings) {
    const labels = classify(f.spec, item.abs);
    if (labels.length === 0) continue;
    const key = `${item.rel}:${f.line}:${f.spec}`; // 同一处命中多条规则 → 合并为一行违规
    const known = seen.get(key);
    if (known) {
      for (const label of labels) if (!known.labels.includes(label)) known.labels.push(label);
      continue;
    }
    seen.set(key, { file: item.rel, line: f.line, stmt: f.stmt, spec: f.spec, labels });
    violations.push(seen.get(key));
  }
}

for (const sub of SCAN_DIRS) {
  const { files, missing } = listModules(path.join(SRC_ROOT, sub), sub);
  scannedDirs.push({ sub, count: files.length, missing });
  total += files.length;
  for (const item of files) collectViolations(item);
}

// Phase 8b：src 根单文件（tools.js）移入扫描 —— 原豁免（过渡期直呼 sender/onebot）
// 随拆分表 #6/#7 消亡而撤销；文件缺失按错误上报（清单登记了它就不该消失）。
for (const name of SCAN_ROOT_FILES) {
  const abs = path.join(SRC_ROOT, name);
  const item = { abs, rel: `src/${name}` };
  if (!fs.existsSync(abs)) {
    errors.push(`${item.rel} 不存在（已登记进扫描清单）`);
    scannedRootFiles.push({ name, missing: true });
    continue;
  }
  scannedRootFiles.push({ name, missing: false });
  total += 1;
  collectViolations(item);
}

// P1（night-plan §4.5）：plugins/ 与 skills/ 纳入扫描（身体禁令对扩展同样生效）。
for (const { root, prefix } of EXT_SCAN_ROOTS) {
  const { files, missing } = listModules(root, prefix, '');
  scannedExtRoots.push({ prefix, count: files.length, missing });
  total += files.length;
  for (const item of files) collectViolations(item);
}
violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.spec.localeCompare(b.spec));

const scannedScope = `${SCAN_DIRS.map((d) => `src/${d}/**`).join(' + ')} + ${SCAN_ROOT_FILES.map((f) => `src/${f}`).join(' + ')}`
  + ` + ${EXT_SCAN_ROOTS.map((r) => `${r.prefix}/**`).join(' + ')}`;
console.log('[boundary] 边界门禁 check-boundaries.mjs —— v3 清单 §5 步骤② T2.1');
console.log(`[boundary] 扫描根: ${SRC_ROOT}`);
for (const d of scannedDirs) {
  const note = d.missing ? '（目录不存在，跳过）' : d.count === 0 ? '（0 个 js 模块，当前为空）' : `${d.count} 个 js 模块`;
  console.log(`[boundary]   src/${d.sub}/**  ${note}`);
}
for (const f of scannedRootFiles) {
  const note = f.missing ? '（文件不存在，已报错）' : '1 个 js 模块（Phase 8b 移入扫描）';
  console.log(`[boundary]   src/${f.name}  ${note}`);
}
for (const d of scannedExtRoots) {
  const note = d.missing ? '（目录不存在，跳过）' : d.count === 0 ? '（0 个 js 模块，当前为空）' : `${d.count} 个 js 模块`;
  console.log(`[boundary]   ${d.prefix}/**  ${note}（P1 扩展扫描）`);
}
console.log('[boundary] 豁免登记（不在扫描范围；若扫描命中豁免文件则跳过并登记）:');
for (const [file, reason] of EXEMPT) console.log(`[boundary]   · src/${file} —— ${reason}`);
for (const h of exemptHits) console.log(`[boundary]   （扫描中命中豁免）${h}`);
console.log('[boundary] 扩展白名单（P1：plugins/skills 命中后不计违规，数组常量+注释原因）:');
for (const w of EXT_WHITELIST) console.log(`[boundary]   · ${w.path} —— ${w.reason}`);
for (const h of whitelistedHits) console.log(`[boundary]   （命中白名单）${h}`);
for (const w of EXT_WHITELIST) {
  if (!wlMatchCount.has(w)) console.log(`[boundary]   注意：白名单条目零命中（登记的原因可能已消失，可清理）：${w.path}`);
}

if (violations.length > 0 || errors.length > 0) {
  console.error(`[boundary] 边界违规 ${violations.length} 处${errors.length ? `、读取错误 ${errors.length} 处` : ''}（前额叶/皮层不得 import 身体——合法通道仅 调度器调用进来 + 前额叶 API）：`);
  for (const v of violations) {
    console.error(`[boundary] 违规 ${v.file}:${v.line}: ${v.stmt}   ← ${v.labels.join('；')}`);
  }
  for (const e of errors) console.error(`[boundary] 错误 ${e}`);
  process.exit(1);
}

console.log(`[boundary] BOUNDARIES OK —— ${scannedScope} 共 ${total} 个 js 模块，零身体依赖（onebot.js / sender.js / surfaces/）`);
process.exit(0);
