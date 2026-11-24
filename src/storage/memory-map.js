// 存储层 v2 · memory 行映射（entry ↔ row；plan §3 facts/cards/staging DDL / §7-V3；执行清单 T3.1）
// ─────────────────────────────────────────────────────────────────────────────
// 这是 src/person/memory.js（API 写读侧）与 tools/migrate-storage-v2.mjs（迁移/校验侧）
// **共用**的唯一映射层（与 messages-map.js 同范式——两侧各自实现必然漂移，--verify 的
// 「逐行规范化 JSON 深度相等」就失去意义）。校验基准 = API 读回形态：verify 把 DB 行经
// rowTo* 重建后与旧文件条目逐行比对，等价于证明「切后端后 API 返回与文件时代逐字节一致」。
//
// 形状保真契约（全部经真实数据根普查实证，2026-11-17 夜，普查脚本输出见交接
// 内部文档 handoff-sqlite-v2.md 夜3 节；facts.jsonl 19 行 / cards 13 行 / staging 18 行）：
//
//   1. 顺序语义（本夜最强锚点，prompt.js:580-584 明文）：
//      · facts() 返回序 = 文件插入序（「最早事实在前」是提示词锚点稳定区的语义前提，
//        截断保靠前的 + 前缀缓存都不允许倒序）。DB 侧 = ORDER BY rowid：
//        supersede 用 UPDATE 就地翻转（rowid 不变）+ INSERT 追加（rowid 递增），
//        与文件「改写原行 + 新行追加末尾」逐字节同构。
//      · cards() 返回序 = 月文件名升序 × 文件行序（prompt.js:600 cards().slice(-2)
//        取「最新写的两张」）。DB 侧 = 迁移按该序插入（rowid 序=文件序）+ 写侧追加；
//        同日替换用 INSERT OR REPLACE——SQLite 的 REPLACE=删旧行+插新行，新行拿新
//        rowid（移到末尾），与文件「滤掉同日旧行 + 新卡追加末尾」语义逐字节同构。
//      · staging(day) 返回序 = 当日文件行序 = 时间序（prompt.js:651「staging 追加序
//        = 时间序」）。DB 侧 = (day, seq) 复合主键，ORDER BY seq；追加 = 事务内
//        MAX(seq)+1。
//
//   2. facts 多行同 key（DDL 修订依据，plan §3 原文 `key TEXT PRIMARY KEY` 与
//      「superseded 链保留」自相矛盾——真实 facts.jsonl 实证 `identity:other` 双行：
//      1 superseded（旧名）+ 1 active（新名））：key 不能做主键，降为
//      NOT NULL 普通列（不变式「同 key 至多一条 active」由 upsertFact 的顶旧逻辑
//      维护，非 schema 约束——文件时代同样不靠存储层强制）。
//
//   3. facts.v 可空（NULL=键缺失，读侧省略——messages.recalled 同款约定）：E3 起
//      新写条目才带 v:1；普查 19 行中 17 行无 v（E3 前历史行）。plan §3 原文
//      `v INTEGER NOT NULL DEFAULT 1` 会把缺键行伪造成 v:1 → 读侧形状漂移，故放宽。
//      cards.v 保持 NOT NULL DEFAULT 1（普查 13/13 全有 v；writeCard 恒写 v:1）。
//
//   4. 键序重建（JSON.stringify 字节级目标）：
//      · facts 重建序 = [v（有则居首）, key, kind, subject, content, status,
//        validFrom, supersededBy, mid, visibility, ...extra]。普查 19/19 逐字节命中
//        （17 行无 v：key 起；2 行有 v：v 起；extra 只有 source，恒居末）。
//      · cards 重建序 = 写入时键序（cardToRow 把 Object.keys(entry) 存进 extra 列的
//        __keyOrder 元数据，rowToCard 按序重建）——cards 历史写者键序异构（普查 13 行
//        三种序：executor 主序 12 行 / gist 回填序 1 行），单一固定序无法全字节复刻；
//        __keyOrder 使历史行 13/13 逐字节 + 未来任何写者顺序永久保真（文件时代
//        「读回序 = 最近一次写入的构造序」不变式的 DB 等价物）。无元数据的手插行
//        走固定列兜底序。
//      · staging 重建序 = [text, mid, source, at]。普查逐行命中（remember() 字面量序）。
//
//   5. NULL 语义：凡「live 数据全行都有、写入方恒写」的列（facts 的 kind/subject/
//      content/status/validFrom/supersededBy/mid/visibility，cards 除 date 外全部，
//      staging 全部），NULL = JS null（显式空值），读侧照常 emit 该键 = null——文件
//      时代显式 null 与缺键在 JSON 里是两种形状，本数据集这些列恒有键，读侧恒 emit。
//      唯二例外 = facts.v 与 cards.entry（live 有缺键行）→ NULL=键缺失（省略）。
//
//   6. 类型重建：staging.mid / facts.mid 走 INTEGER/TEXT 亲和——数字 mid 落库读回
//      纯整数文本 → Number（messages-map 纯整数文本约定同款）。安全性实证：staging
//      18 行 mid = 12 数字 + 6 null，facts 19 行 mid = 15 数字 + 4 null；现行写入方
//      （remember/upsertFact）mid 恒 number|null。facts/cards 的 JSON 列（events/
//      facts/promises/open_loops/keywords/range/extra）JSON 文本往返零语义损失。
//
// D4 边界：本模块是新地基内部件，不属于「逐字节不变的旧公开 API」面。
import { getDb } from './db.js';

// ── facts ────────────────────────────────────────────────────────────────────

/** facts 表列（factToRow 绑定值序与此一一对应；INSERT/SELECT 一律显式列名）。 */
export const FACT_COLUMNS = ['key', 'v', 'kind', 'subject', 'content', 'status', 'validFrom', 'supersededBy', 'mid', 'extra', 'visibility'];

/** 固定列字段集（之外的 entry 字段进 extra JSON 兜底——upsertFact 保留调用方额外
 *  字段的语义，如 fact-cleanup 写的 source）；v 是列不是 extra。 */
const FACT_FIXED_FIELDS = new Set(['v', 'key', 'kind', 'subject', 'content', 'status', 'validFrom', 'supersededBy', 'mid', 'visibility']);

// visibility 归一只发生在写入方（memory.js 的 normVisibility）；本映射层存取均原样
// （迁移存文件原值、读侧 emit 原值）——文件时代 readJsonl 是原样解析对象，归一不在读路径。

const PURE_INT_RE = /^-?\d+$/;

/**
 * fact entry → 绑定值组（列序同 FACT_COLUMNS）。
 * extra = 固定列放不下的字段（保 entry 的键插入序）整体 JSON，无 → null。
 * v 缺失/非法 → null（NULL=键缺失契约 3）。
 */
export function factToRow(entry) {
  const extra = {};
  let hasExtra = false;
  for (const [k, v] of Object.entries(entry)) {
    if (!FACT_FIXED_FIELDS.has(k)) { extra[k] = v; hasExtra = true; }
  }
  const vNum = entry.v == null ? NaN : Number(entry.v);   // 显式 null 同缺键（live 无此形态，防御口径）
  return [
    String(entry.key),
    Number.isFinite(vNum) ? vNum : null,
    String(entry.kind),
    String(entry.subject),
    String(entry.content),
    String(entry.status ?? 'active'),
    Number(entry.validFrom),
    entry.supersededBy === null || entry.supersededBy === undefined ? null : String(entry.supersededBy),
    entry.mid === null || entry.mid === undefined ? null : Number(entry.mid),
    hasExtra ? JSON.stringify(extra) : null,
    String(entry.visibility ?? 'private')   // 原样存（写入方已归一；迁移存文件原值）
  ];
}

/**
 * facts 行 → entry（契约 3/4/5 的重建；键序=普查实测序）。
 * 幂等短路（memory.upsertFact）返回此形态——与文件时代「返回已存在条目（文件解析
 * 对象）」逐字节一致。visibility 原样 emit（文件时代 readJsonl 是原样解析对象，归一
 * 只发生在写入方；DB 里存什么读什么——迁移存原值、API 写入方已归一）。
 */
export function rowToFact(row) {
  const entry = {};
  if (row.v !== null && row.v !== undefined) entry.v = Number(row.v);   // 缺键行省略（契约 3）
  entry.key = String(row.key);
  entry.kind = String(row.kind);
  entry.subject = String(row.subject);
  entry.content = String(row.content);
  entry.status = String(row.status ?? 'active');
  entry.validFrom = Number(row.validFrom);
  entry.supersededBy = row.supersededBy === null || row.supersededBy === undefined ? null : String(row.supersededBy);
  entry.mid = row.mid === null || row.mid === undefined ? null : Number(row.mid);
  entry.visibility = String(row.visibility ?? 'private');
  if (row.extra !== null && row.extra !== undefined) {
    const extras = JSON.parse(String(row.extra));
    for (const [k, v] of Object.entries(extras)) entry[k] = v;   // extra 键序=迁移时保序
  }
  return entry;
}

/**
 * 幂等短路查活条（memory.upsertFact 用）：同 key 且 status=active，rowid 序返回。
 * 「同 key 至多一条 active」由写入方维护（契约 2）；循环比对归一化 content 防指纹碰撞
 * 在调用方（memory.js）做——这里只负责取行。
 */
export function selectActiveFactsByKey(key) {
  return getDb()
    .prepare(`SELECT ${FACT_COLUMNS.join(', ')} FROM facts WHERE key = ? AND status = 'active' ORDER BY rowid`)
    .all(String(key))
    .map(rowToFact);
}

// ── cards ────────────────────────────────────────────────────────────────────

/** cards 表列（cardToRow 绑定值序与此一一对应）。 */
export const CARD_COLUMNS = ['date', 'v', 'source', 'salience', 'entry', 'mood', 'events', 'open_loops', 'promises', 'facts', 'episodes', 'gist', 'keywords', 'range', 'visibility', 'writtenAt', 'extra'];

/** 固定列字段集（之外的 entry 字段进 extra JSON 兜底——writeCard spread 语义）。 */
const CARD_FIXED_FIELDS = new Set(['date', 'v', 'source', 'salience', 'entry', 'mood', 'events', 'open_loops', 'promises', 'facts', 'episodes', 'gist', 'keywords', 'range', 'visibility', 'writtenAt']);

/** JSON 列（数组/对象保底；JSON.stringify 往返零语义损失）。 */
const CARD_JSON_FIELDS = new Set(['events', 'open_loops', 'promises', 'facts', 'episodes', 'keywords', 'range']);

/** 键序元数据键（extra 列内）：V3 cards 专用——cards 历史写者键序异构（普查 13 行
 *  三种序），单一固定重建序无法逐字节复刻全部历史行；把写入时 Object.keys 顺序存进
 *  extra 兜底列，读侧按序重建 = 历史行 13/13 逐字节 + 未来任何写者顺序永久保真
 *  （文件时代「读回序 = 最近一次写入的构造序」不变式的 DB 等价物）。facts/staging
 *  写者构造序固定，无需此机制（facts 普查 19/19 已逐字节命中）。 */
const CARD_KEY_ORDER = '__keyOrder';

/**
 * card entry → 绑定值组（列序同 CARD_COLUMNS）。
 * 缺键 → null（读侧省略——契约 5 唯二例外之一是 cards.entry；其余列 live 恒有键，
 * 写入方恒写，NULL 分支只服务"固定列兜不住的畸形卡"防御路径）。显式 null 与缺键
 * 不可区分是已知取舍（live 13 行无此形态、写入方恒写，契约 5 登记）。
 */
export function cardToRow(entry) {
  const extra = { [CARD_KEY_ORDER]: Object.keys(entry) };
  for (const [k, v] of Object.entries(entry)) {
    if (!CARD_FIXED_FIELDS.has(k)) extra[k] = v;
  }
  const at = (k) => {
    if (!(k in entry) || entry[k] === undefined) return null;
    const val = entry[k];
    if (CARD_JSON_FIELDS.has(k)) return JSON.stringify(val ?? null);
    if (k === 'salience' || k === 'writtenAt') return Number.isFinite(Number(val)) ? Number(val) : null;
    return String(val);
  };
  const vNum = Number(entry.v);
  return [
    String(entry.date),
    Number.isFinite(vNum) ? vNum : 1,   // writeCard 恒写 v（1 或调用方覆盖）；畸形防御落 1（契约 3）
    String(entry.source ?? 'model'),
    at('salience'),
    at('entry'),
    at('mood'),
    at('events'),
    at('open_loops'),
    at('promises'),
    at('facts'),
    at('episodes'),
    at('gist'),
    at('keywords'),
    at('range'),
    String(entry.visibility ?? 'private'),   // 原样存（写入方已归一；迁移存文件原值）
    at('writtenAt'),
    JSON.stringify(extra)
  ];
}

/**
 * cards 行 → entry。有 __keyOrder → 按写入时键序逐键重建（值从固定列/extra 取，
 * JSON 元数据自身不 emit）——文件时代字节级保真；无（手插行/外来行）→ 固定列
 * 兜底序（NULL=键缺失省略）。
 */
export function rowToCard(row) {
  const extras = row.extra === null || row.extra === undefined ? {} : JSON.parse(String(row.extra));
  const keyOrder = Array.isArray(extras[CARD_KEY_ORDER]) ? extras[CARD_KEY_ORDER] : null;
  const columnValue = (k) => {
    switch (k) {
      case 'v': return Number(row.v ?? 1);
      case 'source': return String(row.source ?? 'model');
      case 'date': return String(row.date);
      case 'salience': return row.salience === null || row.salience === undefined ? undefined : Number(row.salience);
      case 'entry': return row.entry === null || row.entry === undefined ? undefined : String(row.entry);
      case 'mood': return row.mood === null || row.mood === undefined ? undefined : String(row.mood);
      case 'events': return row.events === null || row.events === undefined ? undefined : JSON.parse(String(row.events));
      case 'open_loops': return row.open_loops === null || row.open_loops === undefined ? undefined : JSON.parse(String(row.open_loops));
      case 'promises': return row.promises === null || row.promises === undefined ? undefined : JSON.parse(String(row.promises));
      case 'facts': return row.facts === null || row.facts === undefined ? undefined : JSON.parse(String(row.facts));
      case 'episodes': return row.episodes === null || row.episodes === undefined ? undefined : JSON.parse(String(row.episodes));
      case 'gist': return row.gist === null || row.gist === undefined ? undefined : String(row.gist);
      case 'keywords': return row.keywords === null || row.keywords === undefined ? undefined : JSON.parse(String(row.keywords));
      case 'range': return row.range === null || row.range === undefined ? undefined : JSON.parse(String(row.range));
      case 'visibility': return String(row.visibility ?? 'private');   // 原样 emit（文件时代读=原样解析对象）
      case 'writtenAt': return row.writtenAt === null || row.writtenAt === undefined ? undefined : Number(row.writtenAt);
      default: return extras[k];
    }
  };
  const entry = {};
  if (keyOrder) {
    for (const k of keyOrder) {
      const v = columnValue(k);
      if (v !== undefined) entry[k] = v;
    }
    return entry;
  }
  // 兜底重建序（无键序元数据的行）：普查主序（12/13 行的文件序）
  entry.v = Number(row.v ?? 1);
  entry.source = String(row.source ?? 'model');
  entry.date = String(row.date);
  if (row.entry !== null && row.entry !== undefined) entry.entry = String(row.entry);
  if (row.salience !== null && row.salience !== undefined) entry.salience = Number(row.salience);
  if (row.events !== null && row.events !== undefined) entry.events = JSON.parse(String(row.events));
  if (row.facts !== null && row.facts !== undefined) entry.facts = JSON.parse(String(row.facts));
  if (row.episodes !== null && row.episodes !== undefined) entry.episodes = JSON.parse(String(row.episodes));
  if (row.promises !== null && row.promises !== undefined) entry.promises = JSON.parse(String(row.promises));
  if (row.open_loops !== null && row.open_loops !== undefined) entry.open_loops = JSON.parse(String(row.open_loops));
  if (row.mood !== null && row.mood !== undefined) entry.mood = String(row.mood);
  if (row.range !== null && row.range !== undefined) entry.range = JSON.parse(String(row.range));
  entry.visibility = String(row.visibility ?? 'private');
  if (row.gist !== null && row.gist !== undefined) entry.gist = String(row.gist);
  if (row.keywords !== null && row.keywords !== undefined) entry.keywords = JSON.parse(String(row.keywords));
  if (row.writtenAt !== null && row.writtenAt !== undefined) entry.writtenAt = Number(row.writtenAt);
  for (const [k, v] of Object.entries(extras)) {
    if (k !== CARD_KEY_ORDER) entry[k] = v;
  }
  return entry;
}

// ── staging ──────────────────────────────────────────────────────────────────

/** staging 表列（stagingToRow 绑定值序与此一一对应）。 */
export const STAGING_COLUMNS = ['day', 'seq', 'text', 'mid', 'source', 'at'];

/**
 * staging entry → 绑定值组（列序同 STAGING_COLUMNS）。seq 由调用方给
 * （迁移侧=文件序 1..N；写侧=事务内 COALESCE(MAX(seq),0)+1）。
 * mid：number|null → **先 String 化再绑定**（DDL mid TEXT 亲和：直绑整数会被
 * better-sqlite3 以 REAL 落列再转文本 '777.0'——messages-map 契约 3 同款教训，
 * 先 String 得 '777'）；读侧 rowToStaging 纯整数文本 → Number 重建。
 */
export function stagingToRow(entry, day, seq) {
  return [
    String(day),
    Number(seq),
    String(entry.text),
    entry.mid === null || entry.mid === undefined ? null : String(Number(entry.mid)),
    String(entry.source ?? 'chat'),
    Number(entry.at)
  ];
}

/** staging 行 → entry（remember() 字面量序 text,mid,source,at；契约 6 mid 重建）。 */
export function rowToStaging(row) {
  const midRaw = row.mid === null || row.mid === undefined ? null : String(row.mid);
  return {
    text: String(row.text),
    mid: midRaw === null ? null : (PURE_INT_RE.test(midRaw) ? Number(midRaw) : midRaw),
    source: String(row.source ?? 'chat'),
    at: Number(row.at)
  };
}
