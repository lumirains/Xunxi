// 人格内核 · 类型契约（Phase 1 / T1.3）。
// 只有 @typedef 与冻结常量，零实现 —— 实现在 Phase 3 落地
// （mind / memory 各自按这里的形状读写自己的状态文件）。
// 字段来源：《重构执行清单-细化.md》T1.3；MemoryCard schema 照《重构执行清单.md》§10.1。
//
// 状态所有权（原清单 §3，同一行只能有一个写者）。
// storage-v2（2026-11-17）起全部落 SQLite 主存储库 `data/xunxi.db`——形状映射见
// src/storage/state-map.js（state/kv 行）与 memory-map.js / diary-map.js；迁移前的
// data/person/* 文件已就地改名 *.pre-storage-v2 归档（写路径不再经过文件）：
//   MindState          → xunxi.db state 表 key='mind'          唯一写者 person/mind
//   Fact               → xunxi.db facts 表                     唯一写者 person/memory
//   MemoryCard         → xunxi.db cards 表                     唯一写者 person/memory
//   StagingEntry       → xunxi.db staging 表                   唯一写者 person/memory
//   DiaryEntry         → xunxi.db diary 表                     唯一写者 person/diary      （步骤⑥ / T6.1）
//   LifeState          → xunxi.db state 表 key='life'          唯一写者 person/life       （步骤⑥ / T6.3）
// （RelationshipState / SelfState 已于 2026-11-21 整体丢弃——数值轴/叙事面零消费方，
//   所有者裁定"仅用人设即可"；state 行同删，处置记录见 内部文档 state-ownership.md。）

/**
 * 心绪状态（2026-11-21 起纯文字：数值轴 valence/arousal/energy 已丢弃——
 * 提示词只注入 mood.text 与心事文本）。
 * 步骤③（v3 T3.2）：mood.text/textAt 承载 mind_note 写入的心绪文本；
 * preoccupations 含 at（创建时间，mergePreoccupations 的排序键）。
 * @typedef {Object} MindState
 * @property {{text:string, textAt:number, updatedAt:number}} mood
 * @property {{sleepy:boolean, hungry:boolean}} body
 * @property {Array<{id:string, text:string, at:number, source:string, expiresAt:number}>} preoccupations
 * @property {Array<{text:string, weight:number}>} intentions
 * @property {number} updatedAt
 */

/**
 * 长期事实。key 规则（2026-11-11 修订，推导见 memory.factKey）：唯一类 kind（identity/job）
 * 用 `${kind}:${subject}`（新条顶旧条）；可累积类 kind 用 `${kind}:${subject}:${内容指纹}`
 * （多条并存，同内容幂等）。kind 枚举见 PERSON_FACT_KINDS。
 * mid 为证据消息 id；历史印象迁移的数据允许 null（执行期决策 D9）。
 * visibility（P3 · night-plan §6.2 / 整改清单 §7-P3）：记忆可见面——'private' 只进
 * 记忆本体身体（主人侧身体）的提示词；'ambient'/'shared' 对所有身体可见。缺省 'private'
 * （历史条目无此字段同按 private 对待：桌宠视角看不到）。词表与 InboundEvent.visibility
 * 同源（surfaces/contracts.js §2.1）。
 * @typedef {Object} Fact
 * @property {string} key
 * @property {string} kind
 * @property {'other'|'self'|'we'} subject
 * @property {string} content
 * @property {'active'|'superseded'} status
 * @property {number} validFrom
 * @property {string|null} supersededBy
 * @property {number|null} mid
 * @property {'private'|'ambient'|'shared'} [visibility]
 */

/**
 * 记忆卡（schema 照原清单 §10.1：date/salience/events/facts/promises/open_loops/mood/range/source）。
 * visibility（P3 · night-plan §6.2）：与 Fact.visibility 同词表同缺省——'private' 只进
 * 本体身体的提示词，'ambient'/'shared' 全身体可见；历史卡无此字段按 private 对待。
 * entry（P2 日记化 · night-plan-prompt-memory §P2）：第一人称日记正文，先正文后骨架、
 * 不加引号包装；旧格式历史卡无此字段（消费侧按空串回退，兼容不迁移）。
 * gist/keywords（card-vector 计划 D3.5 · 夜1 T1.1，additive）：一句话概括（≤40 字，卡级
 * 向量的嵌入源 + 【记忆】段展示候选 + M3 digest 种子）与可检索关键词（≤10 个，词法加权 +
 * 向量嵌入输入的一部分）；写卡模型一次产出（cards.js 协议），历史卡缺省空串/空数组
 * （消费侧零迁移；executor.normalizeCard 白名单透传，card-index 仅对有 gist 的卡登记向量）。
 * @typedef {Object} MemoryCard
 * @property {string} date
 * @property {string} [entry] 第一人称日记正文（P2 日记化；历史卡无此字段）
 * @property {string} [gist] 一句话概括这一天，≤40 字（card-vector D3.5；历史卡缺省空串）
 * @property {string[]} [keywords] 可检索关键词，≤10 个（card-vector D3.5；历史卡缺省空数组）
 * @property {number} salience
 * @property {string[]} events
 * @property {Array<{kind:string, content:string, mid:number}>} facts
 * @property {Array<{text:string, due:string, status:string, mid:number}>} promises
 * @property {string[]} open_loops
 * @property {string} mood
 * @property {{from:number, to:number}} range
 * @property {string} source
 * @property {'private'|'ambient'|'shared'} [visibility]
 */

/**
 * staging 暂存条目（remember 只追加当天 staging，不调模型）。
 * @typedef {Object} StagingEntry
 * @property {string} text
 * @property {number|null} mid
 * @property {string} source
 * @property {number} at
 */

/**
 * 私密日记条目（"两本日记"之一：给人看、不进记忆——v3 §0 词汇表；步骤⑥ / T6.1）。
 * 字段与历史 data/diary/diary.jsonl 完全同构（迁移是逐字节复制，migrate-diary.mjs）。
 * @typedef {Object} DiaryEntry
 * @property {string} time    'YYYY-MM-DD HH:mm'（展示与按日过滤的口径）
 * @property {string} title   ≤24 字，可为空（只做展示与"别写重样"）
 * @property {string} mood    ≤12 字
 * @property {string} content 正文（保留分段换行；上限是提示词里的软目标，存储只留 4000 字疯跑护栏）
 * @property {number} at      毫秒时间戳（排序/判重键）
 * @property {string} source  'tool'|'reply'|'timer'|'provider'|'reflection'…
 * @property {string=} mode   'long'|'short'（反思生成的长度档，工具手写无此字段）
 */

/**
 * 生活状态（旧日程子系统——现役 reflection/life——的前额叶状态；步骤⑥ / T6.3，旧日程数据文件已迁入）。
 * 字段语义归旧日程插件的 emptyState（行为规则=代码、数据=前额叶），存储层
 * person/life.js 不解释字段——这里只登记形状供检索。
 * @typedef {Object} LifeState
 * @property {number} version
 * @property {string} dayKey
 * @property {{date:string, dayKey:string, prose?:string, items:Array<{time:string, activity:string, emotionalLoad?:{valence:number, note:string}, consumedAt?:number}>, generatedAt?:number}|null} plan
 * @property {Object<string, Object>} [plansByDay]  // 2026-11-16 life-prose v2：日期键权威（最近 30 天）
 * @property {Array<Object>} [plans]                // 最近 7 天历史（防重复；entry 带 prose）
 * @property {{thought:string, at:number, history:Array<{at:number, thought:string}>}} inner
 * @property {Array<{dayKey:string, summary:string, source:string}>} lifeLog
 * @property {{at:number, intent:string, phrase:string, nextMuseAt:number, shares:number}|null} departure
 * @property {{name:string, lastIncomingAt:number, lastIncomingText:string, lastSeenUserAt:number}} friend
 * @property {Object} sleep
 * @property {{dayKey:string, dayCount:number, lastSentAt:number, lastText:string, lastProactiveAt:number, awaiting:boolean}} sent
 * @property {number} lastAskAt
 * @property {string} lastAskResult
 * @property {number} lastCheckAt
 */

/** Fact.kind 的固定枚举（细化清单 T1.3；冻结，不开放扩展）。 */
export const PERSON_FACT_KINDS = Object.freeze([
  'address_name',
  'identity',
  'job',
  'like',
  'dislike',
  'taboo',
  'promise',
  'relationship',
  'routine',
  'important_date'
]);

/**
 * 主人跨身体别名（R1 · 身体层身份断言，2026-11-13；冻结，不开放扩展）。
 *
 * 约定：受信身体在入站信封 InboundEvent.actor.id（surfaces/contracts.js §2.1）里写
 * 'owner'，即声明"这条消息来自主人本人"。生产者是 web 身体的入站装配
 * （src/routes.js /api/web/send，actor: { id: 'owner', name: '我' }）；未来 pet /
 * PWA 多设备 / 任何新身体接入时遵循同一约定 —— 主人识别是**身体层的身份断言**，
 * 不是聊天正文里的自称，也不绑定某一个平台的号码。
 *
 * 安全依据（"自称主人无效"原则）：actor 是受信
 * 身体构造的协议字段，不在消息 payload.text 链路上 —— 旁人在正文里打"我是主人"
 * 属于文本，永远进不了这条判定。'受信'目前由"身体只在本机/私有网装配"背书，
 * E6（token）上线后由 token 背书。
 *
 * 为什么放在 person/contracts.js 而不是 surfaces/contracts.js：check-boundaries
 * （tools/check-boundaries.mjs:213）把扫描根（src/kernel|person|capabilities、
 * src/tools.js、plugins/、skills/）里任何路径段含 'surfaces' 的相对 import 一律
 * 判违规（EXT_WHITELIST 现为空）—— 原首个消费者=旧态度插件（Q15 已禁用）无法
 * import 身体层契约文件；person/ 是插件可达的契约之家，故常量落此。
 * surfaces/contracts.js 侧留有指针注释，两侧同源同义。
 *
 * 与号码通道的关系：owner 的平台号配置键 / ownerIds（旧号码身份插件的
 * 平台号比对语义；该插件 Q15 已禁用）是号码比对的平行通道；本常量是身体断言通道。
 * 单用户 web 部署里入站恒 actor.id='owner'，号码通道仅作历史兼容。
 */
export const OWNER_ACTOR_ID = 'owner';
