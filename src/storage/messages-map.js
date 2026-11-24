// 存储层 v2 · messages 行映射（entry ↔ row；plan §3 messages DDL / §7-V2；执行清单 T2.1）
// ─────────────────────────────────────────────────────────────────────────────
// 这是 store.js（API 写读侧）与 tools/migrate-storage-v2.mjs（迁移/校验侧）**共用**的
// 唯一映射层。两侧若各自实现必然漂移，--verify 的「逐行规范化 JSON 深度相等」就失去
// 意义——校验基准必须是「API 读回形态」：verify 把 DB 行经 rowToEntry 重建后与旧文件
// 条目比对，等价于证明「切后端后 API 返回与文件时代逐字节一致」。
//
// 形状保真契约（全部经真实 main.json 2135 条普查实证，2026-11-17，普查脚本输出见
// 交接 内部文档 handoff-sqlite-v2.md 夜2 节）：
//   1. 键序：写入方字面量序 id,mid,ts,senderId,senderName,text,self,read,reply,media
//      [,isPoke,atMe,atNames（仅非 self 行）][,recalled（仅历史撤回行）]。文件内所有
//      2135 条键序与此完全一致；rowToEntry 按同一键序构造 → JSON.stringify(entry)
//      与文件时代逐字节一致（含键序）。
//   2. self 行缺 isPoke/atMe/atNames 三键：appendSelf 从不写三键、appendIncoming 恒写
//      （写入方契约），普查 1454/1454 self 行缺键、681/681 非 self 行全有。DB 侧
//      isPoke/atMe/atNames 为 NULL 的「缺失」与 atMe 的「显式 null」（1 条历史值）不可
//      用 NULL 区分——以 self 旗标为重建判据（self=1 → 省略三键；self=0 → 恒含三键）。
//   3. mid 类型重建：DDL mid TEXT 有 TEXT 亲和，数字 mid（QQ 时代 1583 条，32 位整数）
//      落库变文本。读侧重建约定：纯整数文本 → Number。安全性实证：475 个字符串 mid
//      全部 'web-' 前缀（web 时代写入方恒 'web-…' / 'web:…' 格式），纯数字字符串 mid
//      为 0 条——该约定对本数据集 100% 无损，且对现行写入方恒真。
//   4. recalled：NULL=键缺失（读侧省略）；非 NULL=Boolean（普查仅 true×2；写入方已不写）。
//   5. reply/media：JSON 文本列保底（reply 历史 null×2135；media 数组×2135，元素形状
//      kind/faceId/file/url/summary/id 异构共存——JSON 列零语义损失）。
//   6. seq：插入序（旧文件数组序 = recent() 返回序语义）。普查实证 id 有 3 处历史倒序
//      （22→21 / 1133→974 / 998→997）而 ts 零倒序——序不能用 id 推。
//
// D4 边界：本模块是新地基内部件，不属于「逐字节不变的旧公开 API」面。
import { getDb, getMeta } from './db.js';

/** messages 表列（entryToRow 绑定值序与此一一对应；INSERT/SELECT 一律显式列名）。 */
export const MESSAGE_COLUMNS = [
  'id', 'mid', 'ts', 'self', 'senderId', 'senderName', 'text', 'reply', 'media',
  'isPoke', 'atMe', 'atNames', 'read', 'day', 'seq', 'recalled'
];

/** 本地日键 YYYY-MM-DD（与 executor.js localDayKey / util.js todayKey 同口径：本地时区）。 */
export function dayKeyOf(ts = Date.now()) {
  const d = new Date(Number(ts));
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const PURE_INT_RE = /^-?\d+$/;

/**
 * entry → 绑定值组（列序同 MESSAGE_COLUMNS）。seq = 插入序（迁移侧=文件序 1..N；
 * store 写侧=事务内 COALESCE(MAX(seq),0)+1，由调用方算好传入）。
 * 一律绑定 number/string/null（better-sqlite3 不接受 boolean 绑定）。
 */
export function entryToRow(entry, seq) {
  return [
    Number(entry.id),
    entry.mid === null || entry.mid === undefined ? null : String(entry.mid),
    Number(entry.ts),
    entry.self ? 1 : 0,
    String(entry.senderId ?? ''),
    String(entry.senderName ?? ''),
    String(entry.text ?? ''),
    entry.reply === null || entry.reply === undefined ? null : JSON.stringify(entry.reply),
    JSON.stringify(Array.isArray(entry.media) ? entry.media : []),
    'isPoke' in entry ? (entry.isPoke ? 1 : 0) : null,
    'atMe' in entry ? (entry.atMe === null || entry.atMe === undefined ? null : (entry.atMe ? 1 : 0)) : null,
    'atNames' in entry ? JSON.stringify(Array.isArray(entry.atNames) ? entry.atNames : []) : null,
    entry.read ? 1 : 0,
    dayKeyOf(entry.ts),   // day = 本地日键（由 ts 派生，写入方/迁移统一走这里）
    Number(seq),
    'recalled' in entry ? (entry.recalled ? 1 : 0) : null
  ];
}

/**
 * row → entry（形状保真契约 1-4 的重建；键序=写入方字面量序）。
 * row 为 better-sqlite3 .get()/.all() 的对象（列名键）。
 */
export function rowToEntry(row) {
  const midText = row.mid === null || row.mid === undefined ? null : String(row.mid);
  const entry = {
    id: Number(row.id),
    mid: midText === null ? null : (PURE_INT_RE.test(midText) ? Number(midText) : midText),
    ts: Number(row.ts),
    senderId: row.senderId === null || row.senderId === undefined ? '' : String(row.senderId),
    senderName: row.senderName === null || row.senderName === undefined ? '' : String(row.senderName),
    text: row.text === null || row.text === undefined ? '' : String(row.text),
    self: !!row.self,
    read: !!row.read,
    reply: row.reply === null || row.reply === undefined ? null : JSON.parse(String(row.reply)),
    media: row.media === null || row.media === undefined ? [] : JSON.parse(String(row.media))
  };
  if (!entry.self) {
    entry.isPoke = !!row.isPoke;
    entry.atMe = row.atMe === null || row.atMe === undefined ? null : !!row.atMe;
    entry.atNames = row.atNames === null || row.atNames === undefined ? [] : JSON.parse(String(row.atNames));
  }
  if (row.recalled !== null && row.recalled !== undefined) entry.recalled = !!row.recalled;
  return entry;
}

/**
 * 单一时间线读回：messages 全量按插入序 + meta 精确计数器。
 * 返回 { chatKey:'main', nextLocalId, messages }（旧 loadChat 的状态形状）。
 * - chatKey 无论 meta 存什么（历史迁移残留旧键）一律归一 'main'（W5 教训/Q10 口径延续）；
 * - 计数器真身 = meta.nextLocalId（迁移取旧文件原值、INSERT 同事务递增）；meta 缺失时的
 *   兜底 MAX(id)+1 仅作最后防线——plan §3 meta 注明它在删过消息时会复用 id，正常不可达
 *   （迁移与每次写入都落 meta），在此显式登记而非静默。
 */
export function loadTimelineFromDb() {
  const db = getDb();
  const rows = db.prepare(`SELECT ${MESSAGE_COLUMNS.join(', ')} FROM messages ORDER BY seq`).all();
  const messages = rows.map(rowToEntry);
  const raw = getMeta('nextLocalId');
  const nextLocalId = raw !== null && raw !== undefined
    ? Number(raw)
    : (messages.length ? Math.max(...messages.map((m) => m.id)) + 1 : 1);
  void getMeta('chatKey');   // 归一口径：键值不参与寻址（单一时间线），读出即弃
  return { chatKey: 'main', nextLocalId, messages };
}
