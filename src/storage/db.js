// 存储层 v2 · 数据库地基（plan §3/§7-V1；执行清单 T1.1）
// ─────────────────────────────────────────────────────────────────────────────
// 职责（V1 地基，零行为变化——本阶段无任何模块切后端，本模块尚无运行时调用方）：
//   1. D9 双运行时加载器：`process.versions.electron` 存在 → createRequire 加载
//      vendor/better-sqlite3-electron/（better-sqlite3@12.11.1 全量副本，electron-130
//      二进制）；否则 require('better-sqlite3')（node_modules，node-137 构建）。
//      探测谓词在打包壳 GUI 与 ELECTRON_RUN_AS_NODE 探针两形态下均存在（V1 实证：
//      _archive-20261116/probe-electron-versions.out.json，electron 33.4.11/modules 130）。
//      版本红线：钉 12.11.1 不升级（v13 打包壳段错误实锤，plan §13）。
//   2. 连接单例**懒开**：模块加载期零副作用（不开库、不建目录、不加载原生驱动）——
//      首次 getDb() 才连。DATA_DIR 经 src/config.js（XUNXI_DATA_DIR，旧名 QQ_AGENT_DATA_DIR 兼容 fallback——优先级链在彼处
//      解析一次）；person-tests「先设 env 后动态 import」的沙箱纪律对本模块同样成立，
//      DB 一律建在临时数据根（T1.3 断言）。
//   3. pragma：journal_mode=WAL（plan D2）、foreign_keys=ON。
//   4. DDL 全量建表 = plan §3 原文 + §12 四处补全（meta 表 / messages_fts 三触发器+
//      rebuild / cards gist·keywords·range / facts extra）+ 执行清单 T1.1 追加的
//      cards.extra 兜底列（writeCard spread 语义对齐 facts.extra——调用方多余字段零损失）
//      + V2 执行夜补全（§12 同款流程）：messages.seq（插入序）/ messages.recalled
//      （历史撤回标记）——依据与普查数据见 DDL 内注释。
//      + V3 执行夜补全（§12 同款流程）：facts.key 降 PK（superseded 链=同 key 多行）、
//      facts.v 可空（NULL=pre-E3 历史行缺键）+ 既有旧库空表 DROP 重建升级路径
//      （upgradeV3Schema）——依据 = 真实 facts.jsonl 19 行普查（identity:other 双行 / 17 行缺 v）。
//      全部 IF NOT EXISTS 幂等（应用每次启动都重开同一库）；空库建表后对 messages_fts
//      执行一次 rebuild（plan §3/§12：外部内容 FTS5 必须显式同步，之后靠三触发器增量）。
//   5. transaction(fn) 助手 + meta 精确计数器助手（V2 store 的 nextLocalId 落点——
//      plan §3 注：MAX(id)+1 在删过消息/空库时会复用 id，计数器必须独立于行集）。
//
// D4 API 不变原则的边界：本模块是新地基，不属于"逐字节不变的旧公开 API"面；
// store/person 各模块 V2+ 切后端时经 getDb()/transaction() 取连接，调用方零感知。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 数据库文件落点（plan §3：全部建在 data/xunxi.db，WAL）。 */
export const dbFile = path.join(DATA_DIR, 'xunxi.db');

/** vendored electron-130 副本目录（D9：与 node_modules 的 node-137 构建按运行时二选一）。 */
const VENDOR_DIR = path.resolve(__dirname, '..', '..', 'vendor', 'better-sqlite3-electron');

let driverCache = null;   // { ctor, runtime, source } —— 原生驱动按运行时只加载一次
let dbInstance = null;    // Database 连接单例（懒开；closeDb() 置空可重开）

/** D9 运行时探测加载（首次调用时执行并记忆；模块加载期不触碰任何 IO）。 */
function loadDriver() {
  if (driverCache) return driverCache;
  const runtime = process.versions.electron ? 'electron' : 'node';
  const source = runtime === 'electron' ? 'vendor' : 'node_modules';
  const require = createRequire(import.meta.url);
  let ctor;
  try {
    ctor = source === 'vendor' ? require(VENDOR_DIR) : require('better-sqlite3');
  } catch (err) {
    throw new Error(
      `[storage/db] better-sqlite3 加载失败（runtime=${runtime}，source=${source}，`
      + `${source === 'vendor' ? VENDOR_DIR : 'node_modules/better-sqlite3'}）——ABI 变更属显式升级步骤（plan §11-6）：${err?.message ?? err}`
    );
  }
  driverCache = { ctor, runtime, source };
  return driverCache;
}

/** 诊断信息（person-tests 加载器探测断言用）。触发驱动加载，但不开库、不落任何文件。 */
export function driverInfo() {
  const { runtime, source } = loadDriver();
  return { runtime, source, vendorDir: VENDOR_DIR, dbFile };
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// plan §3 DDL 原文 + §12 补全 + 执行清单 T1.1 cards.extra。列名 `range`/`key`/`read`
// 在 SQLite 语法下均可作裸标识符（V1 建表探针逐字实证，_archive-20261116/probe-ddl-verbatim.cjs）。
const DDL = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  mid TEXT,
  ts INTEGER NOT NULL,
  self INTEGER NOT NULL DEFAULT 0,
  senderId TEXT, senderName TEXT,
  text TEXT, reply TEXT,
  media TEXT,
  isPoke INTEGER DEFAULT 0, atMe INTEGER DEFAULT 0,
  atNames TEXT,
  read INTEGER DEFAULT 1,
  day TEXT NOT NULL,
  -- V2 执行夜 DDL 补全（plan §12 同款流程，2026-11-17；依据 = 真实 main.json 2135 条字段普查）：
  --   seq：插入序（旧文件 messages 数组序 = loadChat 原样序 = recent() 的返回序语义）。
  --     普查实证：文件内 id 有 3 处历史倒序（idx21: 22→21 / idx974: 1133→974 / idx998: 998→997）
  --     而 ts 零倒序——id ≠ 插入序，ORDER BY id 会改变 recent() 返回顺序（提示词渲染序），
  --     故插入序必须独立成列。迁移按文件序写 seq=1..N；新行取事务内 COALESCE(MAX(seq),0)+1。
  --   recalled：历史撤回标记（store.js 写入方 API 已删、prompt.js:350 仍按该字段过滤历史条目）。
  --     普查实证：2135 条中 2 条 recalled:true、其余缺键——NULL=键缺失（读侧重建时省略键，
  --     保持 JSON 形状逐字节），非 NULL=Boolean。写入方永远不再写该字段。
  seq INTEGER NOT NULL,
  recalled INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_messages_day ON messages(day);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE IF NOT EXISTS facts (
  -- V3 执行夜 DDL 补全（plan §12 同款流程，2026-11-17；依据 = 真实 facts.jsonl 19 行普查）：
  --   key 降 PK → NOT NULL：plan §3 原文「key TEXT PRIMARY KEY」与「superseded 链保留」
  --     自相矛盾——唯一类 kind 顶旧后旧行原地变 superseded 保留（同 key 多行存活）。
  --     普查实证：identity:other 双行（1 superseded + 1 active）真实在册，PK 会拒迁。
  --     「同 key 至多一条 active」的不变式由 upsertFact 顶旧逻辑维护（文件时代同样
  --     不靠存储层强制），非 schema 约束。
  --   v 可空：E3（2026-11-11）起新写条目才带 v:1；普查 19 行中 17 行缺 v（历史行）。
  --     原文「v INTEGER NOT NULL DEFAULT 1」会把缺键行伪造成 v:1 → facts() 读侧形状
  --     漂移。NULL=键缺失（读侧省略，messages.recalled 同款约定）。
  key TEXT NOT NULL,
  v INTEGER,
  kind TEXT NOT NULL, subject TEXT NOT NULL, content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  validFrom INTEGER NOT NULL, supersededBy TEXT,
  mid INTEGER,
  extra TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status);
CREATE TABLE IF NOT EXISTS cards (
  date TEXT PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL,
  salience REAL, entry TEXT, mood TEXT,
  events TEXT, open_loops TEXT, promises TEXT, facts TEXT, episodes TEXT,
  gist TEXT,
  keywords TEXT,
  range TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  writtenAt INTEGER,
  extra TEXT
);
CREATE TABLE IF NOT EXISTS staging (
  day TEXT NOT NULL, seq INTEGER NOT NULL,
  text TEXT NOT NULL, mid TEXT, source TEXT, at INTEGER,
  PRIMARY KEY (day, seq)
);
CREATE TABLE IF NOT EXISTS diary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, mode TEXT, title TEXT, entry TEXT, json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diary_ts ON diary(ts);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, json TEXT NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updatedAt INTEGER NOT NULL);
`;

/**
 * V3 schema 升级（2026-11-17 夜）：V1/V2 夜已按 plan §3 原文建出的旧 facts 表
 * （key TEXT PRIMARY KEY + v NOT NULL DEFAULT 1）与新 DDL 不兼容——旧 PK 会拒绝
 * superseded 链的同 key 多行（真实 facts.jsonl 已有 identity:other 双行），旧 NOT NULL
 * 会把 17 条历史行的缺 v 伪造成 v:1。SQLite 不能 ALTER 列约束 → 空表 DROP 重建：
 * V3 迁移尚未执行、表内恒 0 行（V2 只写过 messages/meta）；若发现旧形状且非空，
 * 拒绝自动重建并抛错（绝不静默毁数据——人工介入口径）。
 */
function upgradeV3Schema(db) {
  const info = db.pragma('table_info(facts)');
  if (!info.length) return;   // 表不存在 → 紧随其后的 DDL 直接建新形状
  const keyCol = info.find((c) => c.name === 'key');
  const vCol = info.find((c) => c.name === 'v');
  const oldShape = (keyCol && keyCol.pk !== 0) || (vCol && vCol.notnull !== 0);
  if (!oldShape) return;
  const rows = db.prepare('SELECT COUNT(*) AS n FROM facts').get().n;
  if (rows > 0) {
    throw new Error(
      `[storage/db] facts 表为旧 schema（key PK/v NOT NULL）且已有 ${rows} 行——拒绝自动重建。`
      + '人工介入：先备份 xunxi.db，再按内部文档 handoff-sqlite-v2.md 夜3 的迁移口径处理。'
    );
  }
  db.exec('DROP TABLE facts');
}

/** 建表（幂等）+ 空库建表后一次 FTS rebuild（plan §12-4：外部内容 FTS5 必须显式同步）。 */
function ensureSchema(db) {
  const freshMessages = !tableExists(db, 'messages');
  const freshFts = !tableExists(db, 'messages_fts');
  upgradeV3Schema(db);
  db.exec(DDL);
  if (freshMessages || freshFts) {
    db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run();
  }
}

/**
 * 连接单例（懒开）：首次调用才加载驱动、连库、设 pragma、建表。
 * 同一进程内后续调用复用同一连接（单进程单用户，plan D2/WAL 口径）。
 * 测试/迁移脚本收尾可 closeDb() 后重开（重开走同一 DDL 幂等路径）。
 */
export function getDb() {
  if (dbInstance) return dbInstance;
  const { ctor } = loadDriver();
  fs.mkdirSync(DATA_DIR, { recursive: true });   // 数据根兜底建目录（只在首用路径，不在模块加载期）
  let db;
  try {
    db = new ctor(dbFile);
  } catch (err) {
    throw new Error(`[storage/db] 打开 ${dbFile} 失败：${err?.message ?? err}`);
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  dbInstance = db;
  return dbInstance;
}

/**
 * 事务助手（闭包风格）：transaction(() => { ...多条写... }) —— fn 抛错整体 ROLLBACK，
 * 返回 fn 的返回值。嵌套调用由 better-sqlite3 自动降级为 savepoint。
 * V2 起的写路径纪律：计数器递增与 INSERT 必须同一事务（plan §3 meta 注）。
 */
export function transaction(fn) {
  return getDb().transaction(fn)();
}

/** meta 精确计数器读（plan §3：nextLocalId 等单行 kv；无值返回 null）。 */
export function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(String(key));
  return row ? row.value : null;
}

/** meta 精确计数器写（UPSERT；调用方负责在事务内与行写入同批递增）。 */
export function setMeta(key, value) {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(String(key), String(value));
}

/** 关闭连接（迁移工具/测试收尾用；重开走 getDb() 幂等路径）。 */
export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
