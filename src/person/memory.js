// 人格内核 · 长期记忆（Phase 3 / T3.4；storage-v2 V3 起后端 = SQLite 三表）
//   facts 表（原 data/person/facts.jsonl）          长期事实（追加 + 同 key 顶旧）
//   cards 表（原 data/person/cards/YYYY-MM.jsonl）  记忆卡（同日替换）
//   staging 表（原 data/person/staging/YYYY-MM-DD.jsonl）当日暂存（remember 只追加，不调模型）
//     ⚠️ 保留期 = **仅当天**（所有者 2026-11-18 定稿）：remember 与 stagingDays() 都会
//     清掉 day ≠ today 的行。原料进卡片后即无保留价值，不做长期归档、也不在 UI 里展示
//     历史天（旧实现 append-only 永久留存，被误读成"积压未巩固"）。
// 本文件是这三处状态的**唯一写者**；全部经 src/storage/db.js（WAL 单例）+
// src/storage/memory-map.js（与迁移工具共用的行映射层，形状保真契约在那边）。
// 旧文件机制时代（BOM 容忍 / tmp+rename 原子写 / 坏行保留）已随 V3 切换退役——
// 等价 DB 断言（事务回滚 / extra 兜底 / 约束）见 person-tests memory 组与
// 内部文档 handoff-sqlite-v2.md 夜3 的「文件级测试退役对照表」。
//
// key 规则（2026-11-11 修订，见 factKey()）：唯一类 kind 用 `${kind}:${subject}`，
// 可累积类 kind 用 `${kind}:${subject}:${内容指纹}`。kind 必须在 PERSON_FACT_KINDS 内。
//
// ⚠️ 顺序语义（提示词锚点，prompt.js:580-584 明文「文件追加序 = 最早的事实在前」）：
//   facts() 返回序 = 插入序（ORDER BY rowid）。supersede = 事务内 UPDATE 原行就地翻转
//   （rowid 不变）+ INSERT 追加（rowid 递增）——与文件时代「改写原行 + 新行追加末尾」
//   逐字节同构。倒序 = 提示词锚点区全字节位移 = 前缀缓存全废，绝不允许。
//   cards()（月文件序×文件行序）与 staging(day)（当日行序=时间序）同理，见 memory-map.js 头注。
import { PERSON_FACT_KINDS } from './contracts.js';
import { DATA_DIR as DATA_ROOT } from '../config.js';
import { getDb, transaction } from '../storage/db.js';
import {
  FACT_COLUMNS, factToRow, rowToFact, selectActiveFactsByKey,
  CARD_COLUMNS, cardToRow, rowToCard,
  STAGING_COLUMNS, stagingToRow, rowToStaging
} from '../storage/memory-map.js';
import path from 'node:path';

// 旧文件绝对路径（V3 前的唯一真身，现 = .pre-storage-v2 原位归档；memoryFiles 保留为
// dev/诊断面——routes /api/person/staging 的目录列举已切 stagingDays() API）。
const DIR = path.join(DATA_ROOT, 'person');
const FACTS_FILE = path.join(DIR, 'facts.jsonl');
const CARDS_DIR = path.join(DIR, 'cards');
const STAGING_DIR = path.join(DIR, 'staging');

const SUBJECTS = ['other', 'self', 'we'];

/**
 * 校验类错误标记（storage-v2 V4 · 巩固事务收口配套）：upsertFact 的**入参校验**抛错带
 * `validation: true`——executor.upsertCardFacts 只吞带标记的错误（无效候选逐条丢弃，
 * 文件时代语义原样保留）；未带标记的（DB/基础设施级失败）上抛 → 巩固事务整体 ROLLBACK
 * （绝无半截巩固状态，执行清单 T4.3）。消息文本不变，仅加性属性，直接调用方零感知。
 */
function validationError(message) {
  const err = new Error(message);
  err.validation = true;
  return err;
}

/**
 * 唯一类 kind：同一 (kind, subject) 只存活一条**active**事实，新条顶旧条（"当前值"语义）。
 *
 * 只有真正"一人一值"的字段才该在此：身份（他叫 X / 平台账号号）与职业。
 * 其余全部可累积 —— 一个人可以有多个称呼、多条承诺、多个关系侧面。
 *
 * ── 为什么改（2026-11-11）──────────────────────────────────────────────
 * 原规则一律 `${kind}:${subject}`，而 executor 落库时 subject 恒为 'other'，
 * 于是每种 kind 只能活一条：实测 18 条事实被顶掉 12 条（prompt 只读 active，
 * 等于永久遗忘）。丢的正是最该记住的——「他一直都在，哪儿也不走」
 * 「就算我不可爱了也把我当他的小鱼」「我是他的例外」，全被后来的同类盖掉。
 * 唯一类保留顶替是为了让"改名/换工作"能覆盖旧值，旧的留 superseded 链可查。
 */
const SINGULAR_KINDS = new Set(['identity', 'job']);

/**
 * 内容指纹：djb2 + 长度混合，用于可累积类 kind 的 key。
 * 归一化（trim + 连续空白折叠）保证"喜欢 星空"与"喜欢  星空"同 key（幂等去重）。
 * 32 位 + 长度后缀，在"单人几十条事实"的规模下碰撞概率可忽略。
 */
function contentFingerprint(content) {
  const s = String(content ?? '').trim().replace(/\s+/g, ' ');
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}${s.length.toString(36)}`;
}

/**
 * 事实 key 的唯一推导口（upsertFact 与迁移/自测共用，禁止各处自己拼）。
 * @param {string} kind
 * @param {'other'|'self'|'we'} subject
 * @param {string} content
 */
export function factKey(kind, subject, content) {
  const base = `${kind}:${subject}`;
  return SINGULAR_KINDS.has(kind) ? base : `${base}:${contentFingerprint(content)}`;
}

// visibility 词表（P3 · night-plan §6.2 / 整改清单 §7-P3）：与 surfaces/contracts.js
// InboundEvent.visibility 同源三值。默认 'private'——记忆本体诞生在主人会话里，
// 桌宠等别的身体默认看不到；调用方显式传 'ambient'/'shared' 才放开。
const VISIBILITY_LEVELS = ['private', 'ambient', 'shared'];
/** 归一化：词表外的值（含 undefined）一律落 'private'（保守默认）。 */
function normVisibility(v) {
  return VISIBILITY_LEVELS.includes(v) ? v : 'private';
}

function localDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 暂存一条记忆候选到今天的 staging（只追加，不调模型，不进 facts）。
 * 追加失败只 console.warn 并返回 null（staging 是热路径旁路，失败不能打断聊天）。
 * @param {{text: string, mid?: number|null, source?: string}} input
 * @returns {import('./contracts.js').StagingEntry|null}
 */
export function remember({ text, mid = null, source = 'chat' } = {}) {
  try {
    if (typeof text !== 'string' || !text.trim()) throw new Error('remember 需要 non-empty text');
    if (mid !== null && !Number.isFinite(Number(mid))) throw new Error(`mid 必须是数字或 null，收到 ${mid}`);
    const entry = { text, mid: mid === null ? null : Number(mid), source: String(source ?? 'chat'), at: Date.now() };
    const day = localDayKey();
    transaction(() => {
      // 海马体只留今天（所有者 2026-11-18 定稿）：非当天的原料在巩固后即无保留价值，
      // 旧实现 append-only 永久留存 → UI 会把历史行显示成"积压未巩固"，语义是错的。
      // 与追加同一事务：要么"旧行清掉+新行写入"都成，要么都不成。
      getDb().prepare('DELETE FROM staging WHERE day <> ?').run(day);
      // 追加 = 事务内 MAX(seq)+1（(day,seq) 复合主键防重；文件时代=appendFileSync 追加行）
      const seq = (getDb()
        .prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM staging WHERE day = ?')
        .get(day).maxSeq) + 1;
      getDb().prepare(`INSERT INTO staging (${STAGING_COLUMNS.join(', ')}) VALUES (${STAGING_COLUMNS.map(() => '?').join(', ')})`)
        .run(...stagingToRow(entry, day, seq));
    });
    return entry;
  } catch (err) {
    console.warn('[memory] remember failed', err?.message ?? err);
    return null;
  }
}

/**
 * 读长期事实，按 status 过滤。
 * 返回序 = 插入序（ORDER BY rowid）——「最早事实在前」是 prompt.js 记忆段（锚点稳定区、
 * 截断保靠前的）的语义前提，绝不倒序（见文件头注）。
 * @param {{status?: 'active'|'superseded'|'all'}} [opts]
 * @returns {Array<import('./contracts.js').Fact>}
 */
export function facts({ status = 'active' } = {}) {
  const db = getDb();
  const base = `SELECT ${FACT_COLUMNS.join(', ')} FROM facts`;
  // 'all' 之外的一切 status 值（含显式 null/非法值）都按等值过滤——文件时代
  // `(f?.status ?? 'active') === status` 对任何非 'all' 值都是等值比较，非法值=空集。
  const rows = status === 'all'
    ? db.prepare(`${base} ORDER BY rowid`).all()
    : db.prepare(`${base} WHERE status = ? ORDER BY rowid`).all(status === undefined ? 'active' : status);
  return rows.map(rowToFact);
}

/**
 * 新增/顶替一条事实。key 由 factKey() 推导：
 *   · 唯一类 kind（identity/job）：同 key 的 active 旧条目标 superseded（"当前值"语义）
 *   · 可累积类 kind：key 带内容指纹，同内容幂等去重、不同内容并列共存（互不顶替）
 * 实现 = 单事务内「幂等短路 SELECT → 顶旧 UPDATE（就地翻 superseded，rowid 不变）→
 * 追加 INSERT（rowid 递增）」，中途任何失败整体 ROLLBACK（文件时代的 tmp+rename 原子写
 * 等价物，且更强：读侧绝无中间态）。同 key 多行存活是契约（superseded 链保留，
 * facts.key 因此非 PK——memory-map.js 契约 2）。
 * kind 必须 ∈ PERSON_FACT_KINDS，否则抛错。
 * @param {Partial<import('./contracts.js').Fact> & {kind: string, subject: 'other'|'self'|'we', content: string}} fact
 * @returns {import('./contracts.js').Fact} 落库后的新条目
 */
export function upsertFact(fact = {}) {
  if (!fact || typeof fact !== 'object') throw validationError('upsertFact 需要 object');
  const { kind, subject, content } = fact;
  if (!PERSON_FACT_KINDS.includes(kind)) {
    throw validationError(`fact.kind "${kind}" 不在 PERSON_FACT_KINDS 内（允许：${PERSON_FACT_KINDS.join(', ')}）`);
  }
  if (!SUBJECTS.includes(subject)) throw validationError(`fact.subject "${subject}" 必须是 other|self|we`);
  if (typeof content !== 'string' || !content.trim()) throw validationError('fact.content 必须是非空字符串');
  if (fact.mid !== undefined && fact.mid !== null && !Number.isFinite(Number(fact.mid))) {
    throw validationError(`fact.mid 必须是数字或 null（历史迁移数据允许 null，决策 D9），收到 ${fact.mid}`);
  }
  const key = factKey(kind, subject, content);
  if (fact.key !== undefined && fact.key !== key) {
    throw validationError(`fact.key "${fact.key}" 与 factKey(kind, subject, content) 推导的 "${key}" 不一致`);
  }

  const now = Date.now();
  const entry = {
    // E3（夜间交接计划 Q1）：数据格式版本号，新写条目恒 1、居首字段。
    // 读侧（prompt.js / recall.js / executor.js）按字段名取值，对未知字段本就宽容。
    v: 1,
    key,
    kind,
    subject,
    content,
    status: 'active',
    validFrom: Number.isFinite(Number(fact.validFrom)) ? Number(fact.validFrom) : now,
    supersededBy: null,
    mid: fact.mid === undefined || fact.mid === null ? null : Number(fact.mid),
    // visibility（P3）：缺省 'private'；调用方显式传词表内值才放开（normVisibility 兜底）
    visibility: normVisibility(fact.visibility)
  };
  // 保留调用方传入的额外字段（如 source:'check'），但不覆盖上面的核心字段
  for (const [k, v] of Object.entries(fact)) {
    if (!(k in entry)) entry[k] = v;
  }

  // 幂等短路（2026-11-11 key 修复配套）：同 key 且内容归一化后一致、且已是 active
  // → 这条事实已经在库里，直接返回现有条目，不写库。
  //
  // 没有这一步，卡片重放会把同一条事实反复标 superseded + 追加新行：active 数不变，
  // 但行数无限增长，superseded 链里全是同内容的副本（实测重放 12 条卡片事实
  // 产生 29 行）。可累积类 key 带内容指纹，所以"同 key"已蕴含"同内容"，这里再比
  // 一次 content 是为了防指纹碰撞。比较用归一化（trim + 空白折叠），与指纹同口径。
  const normForCompare = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
  for (const existing of selectActiveFactsByKey(key)) {
    if (normForCompare(existing.content) === normForCompare(content)) return existing;
  }

  // 顶旧 + 追加（单事务；文件时代=读全文件改写+原子重写）：
  //   UPDATE 同 key 的 active 行就地翻 superseded（rowid 不变=顺序位不动）；
  //   INSERT 新行（rowid = 末尾追加）。
  //   与文件时代一致，顶旧不按 kind 分支：可累积类走到这里时同 key 的 active 行已被
  //   短路拦走（UPDATE 实际零命中，历史 superseded 行不动）；唯一类在这里完成顶替。
  transaction(() => {
    getDb()
      .prepare("UPDATE facts SET status = 'superseded', supersededBy = ? WHERE key = ? AND status = 'active'")
      .run(`${key}@${entry.validFrom}`, key);
    getDb()
      .prepare(`INSERT INTO facts (${FACT_COLUMNS.join(', ')}) VALUES (${FACT_COLUMNS.map(() => '?').join(', ')})`)
      .run(...factToRow(entry));
  });
  return entry;
}

/**
 * 读记忆卡，按卡日期（card.date, YYYY-MM-DD）范围过滤。
 * 返回序 = 月文件序×文件行序的等价物 = 插入序（ORDER BY rowid；prompt.js:600
 * cards().slice(-2) 取"最新写的两张"，迁移按文件序插入使 rowid 序=旧 cards() 序）。
 * @param {{from?: string, to?: string}} [opts]
 * @returns {Array<import('./contracts.js').MemoryCard>}
 */
export function cards({ from, to } = {}) {
  const db = getDb();
  const conds = [];
  const args = [];
  if (from) { conds.push('date >= ?'); args.push(String(from)); }
  if (to) { conds.push('date <= ?'); args.push(String(to)); }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT ${CARD_COLUMNS.join(', ')} FROM cards${where} ORDER BY rowid`).all(...args);
  return rows.map(rowToCard);
}

/**
 * 写一张记忆卡：同 date 已有卡则替换（同日替换语义），否则追加。
 * source 缺省 'model'；card.date 必须是 YYYY-MM-DD。
 * visibility（P3）缺省 'private'：调用方显式传词表内值才放开（normVisibility 兜底）。
 * 实现 = INSERT OR REPLACE（date 主键）：SQLite 的 REPLACE = 删同 date 旧行 + 插新行，
 * 新行拿新 rowid（移到末尾）——与文件时代「读全文件滤掉同日行 + 新卡追加末尾」逐字节
 * 同构（cards() 的 rowid 序语义因此保持）。
 * @param {Partial<import('./contracts.js').MemoryCard> & {date: string}} card
 * @returns {import('./contracts.js').MemoryCard}
 */
export function writeCard(card = {}) {
  if (!card || typeof card !== 'object') throw new Error('writeCard 需要 object');
  if (typeof card.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(card.date)) {
    throw new Error(`card.date 必须是 YYYY-MM-DD，收到 ${card.date}`);
  }
  // E3：v:1 居首（数据格式版本号，夜间交接计划 Q1）——新写卡片的首字段即 v。
  // 现有调用方（reflection/executor、dev/check、person-tests）均不传 v；spread 在后
  // 意味着调用方显式传 v 可覆盖，本模块不做二次拦截（调用方已审计）。
  const entry = { v: 1, source: 'model', ...card };
  entry.visibility = normVisibility(entry.visibility);
  // 写卡追踪（2026-11-15，所有者提议）：writtenAt = 卡片落盘时刻——"过期补全"判据
  // （executor 卡 catchup/晚安触发比对当日最后消息 ts：写卡之后又有对话 → 白天版卡
  // 次日启动时自动重写补全，见 executor.cardStale）。调用方可显式传 writtenAt
  // （person-tests 回溯用）；未传/非法 → 落盘时刻。加性字段，v:1 内。
  entry.writtenAt = Number.isFinite(Number(entry.writtenAt)) ? Number(entry.writtenAt) : Date.now();
  transaction(() => {
    getDb()
      .prepare(`INSERT OR REPLACE INTO cards (${CARD_COLUMNS.join(', ')}) VALUES (${CARD_COLUMNS.map(() => '?').join(', ')})`)
      .run(...cardToRow(entry));
  });
  return entry;
}

/**
 * 读指定日卡片落盘时的 writtenAt（2026-11-15 写卡追踪）。
 * 无卡 / 旧格式卡（v6 前写入，无 writtenAt 字段→列 NULL）→ null——调用方（executor
 * 过期补全）把 null 视为"不过期"，避免升级后一次 catchup 把全部历史日重写；当日端点
 * （按钮）的显式 force 不走此判。
 * @param {string} day YYYY-MM-DD
 * @returns {number|null}
 */
export function cardWrittenAt(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error(`cardWrittenAt(day) 需要 YYYY-MM-DD，收到 ${day}`);
  const row = getDb().prepare('SELECT writtenAt FROM cards WHERE date = ?').get(String(day));
  if (!row || row.writtenAt === null || row.writtenAt === undefined) return null;
  const n = Number(row.writtenAt);
  return Number.isFinite(n) ? n : null;
}

/**
 * 读指定日（缺省今天）的 staging，返回序 = 当日追加序 = 时间序（prompt.js:651）。
 * @param {string} [day] YYYY-MM-DD
 * @returns {Array<import('./contracts.js').StagingEntry>}
 */
export function staging(day = localDayKey()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error(`staging(day) 需要 YYYY-MM-DD，收到 ${day}`);
  const rows = getDb()
    .prepare(`SELECT ${STAGING_COLUMNS.join(', ')} FROM staging WHERE day = ? ORDER BY seq`)
    .all(String(day));
  return rows.map(rowToStaging);
}

/**
 * 有 staging 条目的全部日期（降序 = 旧「日文件名倒序」的等价物）。
 * V3 新增 API（加性，不改既有签名）：routes /api/person/staging 的目录列举在文件时代
 * 走 memoryFiles.stagingDir + readdirSync（直读消费点，§5 审计切 API）；DB 后端下
 * 「哪天有原料」= staging 表的 DISTINCT day。
 * 注意：文件时代一个 0 字节空文件也会占一个 day（真实数据根 2026-11-07.jsonl 空文件），
 * DB 后端下空日无行可依——该日从列表消失（零信息量，UI 原本就渲染空节；交接 drift 登记）。
 * @returns {string[]}
 */
export function stagingDays() {
  // 海马体只留今天：列列举前先清非当天行（所有者 2026-11-18）。读取面承担这次清理，
  // 保证「UI 能看到的天」=「实际保留的天」，不会出现历史行残留在库里却靠前端过滤的情况。
  purgeStaleStaging();
  return getDb().prepare('SELECT DISTINCT day FROM staging ORDER BY day DESC').all().map((r) => r.day);
}

/**
 * 清掉非当天的 staging 行（海马体只保留今天）。
 * 口径（所有者 2026-11-18）：原料进卡片后即无保留价值，不长期保存、不长期展示。
 * 幂等；返回删除行数。失败只 warn 并返回 0（staging 是旁路，不能打断主链路）。
 * @param {string} [keepDay] 保留哪一天（缺省今天，测试/补跑可指定）
 * @returns {number}
 */
export function purgeStaleStaging(keepDay = localDayKey()) {
  try {
    const info = getDb().prepare('DELETE FROM staging WHERE day <> ?').run(String(keepDay));
    return Number(info?.changes ?? 0);
  } catch (err) {
    console.warn('[memory] staging purge failed', err?.message ?? err);
    return 0;
  }
}

/** 各状态文件绝对路径（dev 脚本/诊断用；V3 起为历史归档路径，真身 = xunxi.db 三表）。 */
export const memoryFiles = { facts: FACTS_FILE, cardsDir: CARDS_DIR, stagingDir: STAGING_DIR };
