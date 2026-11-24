// 存储层 v2 · diary 行映射（plan §3 diary DDL / §4 模块表 diary 行 / §7-V4；执行清单 T4.2）
// ─────────────────────────────────────────────────────────────────────────────
// 这是 src/person/diary.js（API 写读侧）与 tools/migrate-storage-v2.mjs（迁移/校验侧）
// **共用**的唯一映射层（messages-map/memory-map/state-map 同范式）。校验基准 = API 读回
// 形态 + json 列原文：verify 把 DB 行 json 解析后与旧文件条目深度比对（另做 API 读回
// 口径二次比对），等价于证明「切后端后 API 返回与文件时代逐字节一致」。
//
// 形状保真契约（真实数据根普查实证，2026-11-17 夜，普查见交接 内部文档 handoff-sqlite-v2.md 夜4；
// person/diary.jsonl 15 条 0 坏行 0 粘行，at 全升序，行尾有换行）：
//
//   1. json 列 = 复合对象保底（plan §3 头注「复杂/低频对象 = JSON 列保底零语义损失」）：
//      · 迁移 = 文件原文 **seg 原样**（历史行键序/空格风格各异——普查实证旧行
//        `{"time": "…"}` 带空格、新行紧凑 `{"time":"…"}`，原文入库 = 导出工具可近乎
//        逐字节还原文件形态；未知字段零丢失）；
//      · API 写入 = append 的字面量序列化 `JSON.stringify({...entry, mode: entry.mode
//        || undefined})`——与文件时代 appendFileSync 的行内容逐字节同源（mode 空串时
//        mode 键省略，与文件行为一致）。
//
//   2. 提取列为派生索引列（api 语义只在 json）：ts = Number(at)||0（读序键，DDL NOT
//      NULL——缺 at/非法的历史行落 0，与 readAll 的 (at||0) 排序键同口径）；mode 空串/
//      缺键 → NULL（读侧 String(j.mode||'') 归 ''，两种形态等价）；title 缺键 → NULL、
//      空串原样；entry = content（text 回退）——供未来 FTS/查询直取，读面不消费。
//
//   3. 读序 = ORDER BY ts, id：ts 升序 + id（AUTOINCREMENT 插入序）决胜——文件时代
//      readAll 的「stable sort by (at||0)」等价物（at 并列时保持文件行序 = 迁移插入序）。
//      读侧保留一次 JS 稳定排序（与文件时代逐字节同构，防 ts 列与 json.at 理论漂移）。
//
//   4. 行→条目重建 = diary.js readAll 的逐字段归一口径（键序 time,title,mood,content,
//      mode,at,source；content||text 双认；无 content/text 的行跳过——文件时代 readAll
//      的垃圾行守卫，迁移照常入库（json 原文零丢失）但 API 读回不可见，verify 双口径核对）。
//
// D4 边界：本模块是新地基内部件，不属于「逐字节不变的旧公开 API」面。
import { getDb } from './db.js';

/** diary 表列（绑定值序与此一一对应；id 为 AUTOINCREMENT 不在写列内，SELECT/ORDER BY 可用）。 */
export const DIARY_COLUMNS = ['ts', 'mode', 'title', 'entry', 'json'];

/**
 * diary 条目 → 绑定值组（列序同 DIARY_COLUMNS）。
 * @param {object} entry 原始条目对象（迁移=文件解析对象；写入=append 构造对象）
 * @param {string|null} [jsonText] json 列原文（迁移传文件 seg 原样；缺省=按契约 1 写入侧序列化）
 */
export function diaryToRow(entry, jsonText = null) {
  return [
    Number(entry.at) || 0,                                  // ts（契约 2：readAll 排序键同口径）
    entry.mode ? String(entry.mode) : null,                 // mode（空串/缺键 → NULL）
    entry.title === undefined || entry.title === null ? null : String(entry.title),
    String(entry.content ?? entry.text ?? ''),              // entry 提取列（content|text）
    jsonText ?? JSON.stringify({ ...entry, mode: entry.mode || undefined })   // json 保底（契约 1）
  ];
}

/**
 * diary 行 → API 读回条目（readAll 归一口径逐字段复刻，键序契约 4）。
 * json 解析失败 / 非 object / 无 content 且无 text → null（readAll 守卫：该行对 API 不可见）。
 */
export function rowToDiaryEntry(row) {
  let j = null;
  try {
    j = JSON.parse(String(row.json));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || !(j.content || j.text)) return null;
  return {
    time: String(j.time || ''),
    title: String(j.title || ''),
    mood: String(j.mood || ''),
    content: String(j.content || j.text || ''),
    mode: String(j.mode || ''),
    at: Number(j.at) || 0,
    source: String(j.source || '')   // 写入来源（tool/timer/reply/provider…）随读带回
  };
}

/** 按 API 读序取全部行（ORDER BY ts, id——契约 3；person/diary.js readAll 消费）。 */
export function selectDiaryRowsOrdered() {
  return getDb()
    .prepare(`SELECT id, ${DIARY_COLUMNS.join(', ')} FROM diary ORDER BY ts, id`)
    .all();
}
