// 人格内核 · 私密日记（步骤⑥ / T6.1）
// storage-v2 V4 起后端 = xunxi.db **diary 表**（json 列复合对象保底 + ts/mode/title/entry
// 提取列；读序 = ORDER BY ts, id——文件时代「按 at 升序、并列保文件行序」的等价物，
// 见 src/storage/diary-map.js 形状保真契约）。（原 data/person/diary.jsonl 已随迁移改为
// .pre-storage-v2 原位归档。）
//
// 本文件是私密日记的**唯一写者**。"两本日记"之一（v3 §0 词汇表）：
// 私密日记给人看、不进记忆；记忆卡片（person/cards + facts）才是她自己的记忆。
//
// 写方（都只经本 API，不许绕）：
//   · src/capabilities/reflection/diary.js —— 晚安后自动写（ReflectionSpec 'diary'，T6.2）；
//   · src/tools.js —— write_one / recent_diary 工具（Q15 起由原插件壳收编）。
// 读者：recent_diary 工具、UI（旧私密日记表现层已随 Q15 扩展禁用移入 legacy，不再是读者）。
//
// 历史格式：一行一条 JSON（jsonl）。2026-11-03 踩过的「一行粘多条 JSON」容错
//（splitJsonObjects）随文件机制退役——diary 表一行 = 一个对象（json 列单对象），
// 迁移工具侧保留同口径拆分（tools/migrate-storage-v2.mjs readDiaryFile）。
// 字段 time/title/mood/content/at/source/mode 不增不减——旧条目与新条目同构，
// 读路径原样兼容（rowToDiaryEntry 逐字段归一口径与文件时代 readAll 逐字节同源）。
//
// 硬规矩（用户原话，随存储一起从前额叶外搬进来，别拧）：
//   · 只给"写一条、看几条"，不给删除、不给改某一天 —— 那是主人的活；
//   · 字数上限是**软目标**：不按上限拒收，也绝不 slice（日记最怕半句话：
//     「主人说想学计算机是为了帮我拓展功能。笨蛋，那种理由撑不久」这种截断比不写还伤）；
//     只留 4000 字疯跑护栏，防模型抽风把一整篇对话塞进本子。

import path from 'node:path';
import { DATA_DIR as DATA_ROOT } from '../config.js';
import { getDb, transaction } from '../storage/db.js';
import { DIARY_COLUMNS, diaryToRow, rowToDiaryEntry, selectDiaryRowsOrdered } from '../storage/diary-map.js';

// V4 前的唯一真身路径（现 = .pre-storage-v2 原位归档；仅诊断/状态面板/迁移脚本用）。
const FILE = path.join(DATA_ROOT, 'person', 'diary.jsonl');

const MAX_RUNAWAY_CHARS = 4000;   // 疯跑护栏（不是内容上限——上限是提示词里的软目标）

const pad2 = (n) => String(n).padStart(2, '0');
function dayKeyOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function stampOf(ms) {
  const d = new Date(ms);
  return `${dayKeyOf(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 读全部条目（按时间升序）。json 解析失败/无 content 的行跳过（rowToDiaryEntry 守卫），
 *  绝不因为一行坏了就整体读不出来；再按 (at||0) 稳定排序一次——与文件时代 readAll
 *  逐字节同构（ORDER BY ts,id 已给出同序，此处排序是防御性同构，零成本）。 */
function readAll() {
  const out = [];
  for (const row of selectDiaryRowsOrdered()) {
    const entry = rowToDiaryEntry(row);
    if (entry) out.push(entry);
  }
  out.sort((a, b) => (a.at || 0) - (b.at || 0));
  return out;
}

/** 全部条目（升序）。诊断/状态面板用；大文件场景先走 recent/entriesBetween。 */
export function entries() {
  return readAll();
}

/** 最近 n 条（升序；n 兜底 8、上限 200——本子是翻的，不是导出的）。 */
export function recent(n = 8) {
  return readAll().slice(-Math.max(1, Math.min(200, Number(n) || 8)));
}

/**
 * [from, to] 毫秒**闭区间**内的条目（按排序键 at 过滤，含两端）。
 * 判重/素材窗口用（如 writeGate 的"这次晚安已经写过了"：lastAt >= goodbyeAt）。
 */
export function entriesBetween({ from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
  const f = Number(from) || 0;
  const t = Number.isFinite(Number(to)) ? Number(to) : Number.MAX_SAFE_INTEGER;
  return readAll().filter((e) => (e.at || 0) >= f && (e.at || 0) <= t);
}

/** 某一天（YYYY-MM-DD）的条目 —— 按 time 前缀匹配，与旧 entriesToday 口径一致。 */
export function entriesOn(day) {
  const d = String(day ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return [];
  return readAll().filter((e) => (e.time || '').startsWith(d));
}

/**
 * 追加一条。返回落库的那一条。
 *
 * ⚠️ 字数上限是**软目标**（用户定的：250 字，可以适当超出），所以这里**不按上限拒收**。
 * 但也绝不 slice —— 只留 4000 字疯跑护栏。落库 = 单 INSERT（事务内；json 列序列化与
 * 文件时代 appendFileSync 的行内容逐字节同源——diary-map 契约 1）。
 */
export function append({ content, title = '', mood = '', at = Date.now(), source = 'tool', mode = '' } = {}) {
  // 保留换行（分段是日记的一部分），只做空白规范化
  const text = String(content ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw new Error('内容为空，没写进去');
  if (text.length > MAX_RUNAWAY_CHARS) {
    throw new Error(`这条 ${text.length} 字，明显是抽风了，没写进去`);
  }
  const atMs = Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : Date.now();
  const entry = {
    time: stampOf(atMs),
    // 标题是 2026-11-03 加的：只做展示与"别写重样"，不参与字数统计。
    title: String(title ?? '').replace(/^[#\s]+/, '').replace(/^[「『"“]+/u, '').replace(/[」』"”]+$/u, '').trim().slice(0, 24),
    mood: String(mood ?? '').trim().slice(0, 12),
    content: text,
    at: atMs,
    source: String(source ?? 'tool'),
    ...(mode ? { mode } : {})
  };
  transaction(() => {
    getDb()
      .prepare(`INSERT INTO diary (${DIARY_COLUMNS.join(', ')}) VALUES (${DIARY_COLUMNS.map(() => '?').join(', ')})`)
      .run(...diaryToRow(entry));
  });
  console.log(`[person/diary] 写了一条（${entry.time}${entry.mode ? ' · ' + entry.mode : ''}${entry.mood ? ' · ' + entry.mood : ''}）：${text.slice(0, 40)}`);
  return entry;
}

/** V4 前状态文件绝对路径（诊断/迁移脚本/状态面板用；V4 起真身 = xunxi.db diary 表）。 */
export const diaryFile = FILE;
