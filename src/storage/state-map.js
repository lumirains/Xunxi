// 存储层 v2 · state/kv 行映射（plan §3 state/kv DDL / §4 模块表 V4+V5 行 / §7-V4+V5；执行清单 T4.1/T4.4）
// ─────────────────────────────────────────────────────────────────────────────
// 这是 person 小状态模块（mind/life；relationship/self 已于 2026-11-21 丢弃）、reminders.js 与
// tools/migrate-storage-v2.mjs（迁移/校验侧）**共用**的映射层（messages-map/memory-map
// 同范式——两侧各自实现必然漂移）。校验基准 = API 读回形态：verify 把 DB 行 json 解析后
// 与旧文件对象逐个深度比对，等价于证明「切后端后 API 返回与文件时代逐字节一致」。
//
// 形状保真契约（真实数据根普查实证，2026-11-17 夜，普查见交接 内部文档 handoff-sqlite-v2.md 夜4）：
//
//   1. json 列 = 整对象 JSON（键序保真）：JSON.parse 往返保序——state 存「文件时代
//      writeRaw(state, null, 1) 的解析对象」（mind/life 各自唯一形状；relationship/self 已弃），
//      kv 存「原文件整对象」（reminders={reminders:[…]} / transition=载荷对象）。
//      API 读回 = JSON.parse(json) → 键序与文件时代逐字节一致（byte 级探针口径）。
//      写入侧统一 **紧凑序列化**（JSON.stringify(obj)）——文件时代的 indent=1 是落盘
//      形态不是数据语义；导出工具（export-json-snapshot）按原文件形态重排 indent=1。
//
//   2. updatedAt 归一（DDL NOT NULL；文件时代无此元数据列）：对象自带有限数字
//      updatedAt → 原值（mind 的种子与 apply 都写该键）；
//      否则 Date.now()。普查实证：life.json（旧日程时代形状）**无 updatedAt 顶层键**
//      → 迁移行落迁移时刻。verify 只校验 updatedAt 为有限数字（NOT NULL 语义），不与源比对。
//
//   3. NULL 语义：json NOT NULL / updatedAt NOT NULL / state.key 与 kv.k 主键——
//      本层无 NULL 分支（与 facts.v/messages.recalled 的「NULL=键缺失」不同类）。
//
//   4. state key 词表 = ['mind','life']（plan §4 原 mind/relationship/self/life 四行；
//      'relationship' 与 'self' 已于 2026-11-21 随丢弃裁定移出词表，state 行删除记录
//      见 内部文档 state-ownership.md）；
//      kv k 词表 = ['reminders','transition']（plan §4 末两行）。
//      旧跨轮插件 2026-11-13 起禁用（legacy/disabled-20261113/），其数据仍按 §4 迁入 kv（执行
//      清单 T4.4「禁用中也迁数据」）；插件本体不改造（legacy 退役件，登记 drift）。
//
// D4 边界：本模块是新地基内部件，不属于「逐字节不变的旧公开 API」面。
import { getDb } from './db.js';

/** state 表 key 词表（plan §4 原 mind/relationship/self/life 四行；relationship/self
 *  已于 2026-11-21 丢弃移除）。 */
export const STATE_KEYS = ['mind', 'life'];

/** kv 表两个 k（plan §4 原两键；第二键 W6-② 更名 'transition'，旧键名已入 _archive-20261120/MANIFEST.md）。 */
export const KV_KEYS = ['reminders', 'transition'];

/** state 行 raw 读（json 原文 + updatedAt）——self.js 的「损坏抛错绝不静默重建」
 *  用 raw（JSON.parse 抛错上抛，与文件时代 readRaw 的抛错口径同源）；宽容口径用 stateGet。 */
export function stateRowRaw(key) {
  return getDb()
    .prepare('SELECT key, json, updatedAt FROM state WHERE key = ?')
    .get(String(key)) ?? null;
}

/** 读 state 对象：缺行 → null；json 解析失败/非对象 → null（宽容口径，mind/
 *  relationship/life 用——文件时代这三处对「读不到/坏档」都是回落空态/null）。 */
export function stateGet(key) {
  const row = stateRowRaw(key);
  if (!row) return null;
  try {
    const obj = JSON.parse(String(row.json));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** updatedAt 归一（契约 2）：对象自带有限数字 updatedAt → 原值；否则 Date.now()。 */
function updatedAtOf(obj) {
  const n = Number(obj?.updatedAt);
  return Number.isFinite(n) ? n : Date.now();
}

/**
 * 整对象写入（UPSERT，单语句原子）。**不自带事务**——调用方决定：
 * 单写直接调（autocommit 单语句与文件时代 tmp+rename 原子写同强度）；
 * 巩固事务等嵌套场景在外层 db.transaction 内调用（better-sqlite3 自动 savepoint）。
 */
export function statePut(key, obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`statePut(${String(key)}) 需要 plain object`);
  }
  getDb()
    .prepare('INSERT INTO state (key, json, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updatedAt = excluded.updatedAt')
    .run(String(key), JSON.stringify(obj), updatedAtOf(obj));
}

// ── kv ───────────────────────────────────────────────────────────────────────

/** 读 kv 对象：缺行 → null；解析失败/非对象 → null（宽容口径，与 reminders 文件时代
 *  load() 的 catch 一致——坏档回落空态）。 */
export function kvGet(k) {
  const row = getDb().prepare('SELECT k, v, updatedAt FROM kv WHERE k = ?').get(String(k));
  if (!row) return null;
  try {
    const obj = JSON.parse(String(row.v));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/** 整对象写入 kv（UPSERT）。updatedAt 语义 = 本次写时刻（kv 值对象无统一 updatedAt
 *  字段：reminders 是数组容器、transition 的 at 是业务字段不改列）。 */
export function kvPut(k, value, updatedAt = Date.now()) {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new Error(`kvPut(${String(k)}) 需要 object 值`);
  }
  const n = Number(updatedAt);
  getDb()
    .prepare('INSERT INTO kv (k, v, updatedAt) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updatedAt = excluded.updatedAt')
    .run(String(k), JSON.stringify(value), Number.isFinite(n) ? n : Date.now());
}
