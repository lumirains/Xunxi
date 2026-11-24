// 反思执行器（步骤⑤ / T5.1–T5.3）—— 皮层的"巩固"机构。
//
// 职责（v3 §1 架构图 / 原清单 §10.1）：
//   · 收声明模块（ReflectionSpec）的注册：触发、needs、任务模板、解析、兜底；
//   · 由钟（kernel/clock，挂在 orchestrator）驱动：心跳到点问"有到点的巩固任务吗"，
//     有则取数（读前额叶）→ 产出（fixture / 模型）→ 解析校验 → 经前额叶 API 写回；
//   · 巩固 = 海马体（staging/messages）→ 前额叶（cards/facts；原 episodes→mind 面
//     已于 2026-11-21 随心绪数值丢弃退役；P4 起 episodes
//     不再喂 relationship——night-plan-prompt-memory §0-6，关系数值轴退役，
//     relationship 模块与文件数据保留转历史只读），
//     每个任务唯一一次模型产出（fixture 模式零真实调用）。
//
// 纪律（本步门禁）：
//   · 禁止 import 发送/协议模块（check-boundaries 扫 src/capabilities/**）；
//   · 所有状态写入经 person API（memory/mind 是各自文件的唯一写者；relationship
//     仍是其文件的唯一写者，但本链自 P4 起零调用、文件转历史只读）；
//   · 模型调用只允许在本文件内且仅 'model' 模式（动态 import llm.js）；
//     'fixture' 模式（config.memory.writer.mode，默认）零网络。
//   · B 类枢纽耦合：needs 词表 = ['messages','life','staging','facts'] 共 4 条目（上限 10）；
//     调度器触发词表 = afterLastMessage/catchupDays/afterGoodnight/dailyTime 共 4 种
//     （上限 10；dailyTime 为 night-plan-life §L2 新增——每日计划触发，3→4 实测登记
//     architecture-v3 §8）。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, getConfig } from '../../config.js';
import * as memory from '../../person/memory.js';
import * as mind from '../../person/mind.js';
// storage-v2 V4（执行清单 T4.3）：巩固段三仓写入（cards/facts/state）收口为单事务——
// plan §4「迁移期写顺序警告」（V3 边界：episodes→mind 跨存储）随 mind 入库关闭。
import { transaction } from '../../storage/db.js';
// card-index（card-vector 夜1 T1.7）：双层派生索引唯一写者——写入点只在 runOnce 写回
// 分支与 upsertCardFacts 内（计划 §10-1 核对项；fire-and-forget，索引失败绝不影响巩固）。
// 本模块 import 期零网络零模型调用（llm.js 动态 import 在 card-index 函数内）。
import { cardIndex } from './card-index.js';
// person/relationship 于 2026-11-21 整体丢弃（数值轴零消费方）：模块已删除、state 行
// 已清、导入边摘除；处置记录见 内部文档 state-ownership.md。
import * as life from '../../person/life.js';
// 默认声明自举（放在 import 链最末）：import 执行器即自带 cards 声明——
// 单独 import 本模块（诊断/门禁自检/外部驱动 runOnce）也能立刻看到已注册的声明。
// 这是 cards→executor→cards 的受控循环：cards.js 在本模块 body 之前求值并调
// registerSpec，因此 registerSpec 只能依赖**函数提升**与惰性初始化的注册表
// （见下方 registryMap），不得触碰本模块任何 const（TDZ）。新声明模块不必挂进
// 这里——照 cards.js 的模式自行 import { registerSpec } 注册即可。
import './cards.js';
// diary.js（步骤⑥ / T6.2）同样挂进默认自举：单独 import 执行器即见 specs.diary。
// 它是 selfDriven 声明（触发/模型参数私有，不经统一 runDue——取舍见 diary.js 文件头）。
// P2（night-plan §P2）：cards 的 afterGoodnight 触发复用 diary 的互道晚安判定——
// lastGoodbyeAt（词表+成对判定）共享一份函数，执行器不复制词表（命名导入仍会执行
// diary.js 的注册副作用，自举语义不变）。
import { lastGoodbyeAt } from './diary.js';
// life.js（night-plan-life §L2）：当日日程声明同样挂进默认自举——单独 import 执行器
// 即见 specs.life。它是首个 product:'plan' 声明（产物是当日日程不是记忆卡）：
// 触发走统一词表（dailyTime），落库走 runOnce 的 plan 分支（person/life.write，
// 不经 normalizeCard/writeCard 卡管线）。
import './life.js';

// ── 小工具 ────────────────────────────────────────────────────────────────

/** 本地日键 YYYY-MM-DD（与 person/memory 的 localDayKey 同口径）。 */
export function localDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 本地日键 +n 天（跨月/跨年安全；用本地正午构造避开 DST 边界）。 */
export function shiftDayKey(day, n = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  if (!m || !Number.isFinite(Number(n))) return String(day ?? '');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(n), 12, 0, 0, 0);
  return localDayKey(d.getTime());
}

/** 日的本地毫秒边界 [start, end)。 */
export function dayBounds(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error(`day 需要 YYYY-MM-DD，收到 ${day}`);
  const [y, m, d] = String(day).split('-').map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return { start, end: start + 86400000 };
}

function clampNum(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 模型返回的 content 抽文本（string 或分段数组都接）。 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('');
  }
  return '';
}

// ── 声明注册表 ────────────────────────────────────────────────────────────

/** @typedef {{
 *   id: string,
 *   enabled: boolean|(() => boolean),
 *   trigger: object|Array<object>,          // {kind:'afterLastMessage',delayMin:30} | {kind:'catchupDays',days:7} | {kind:'afterGoodnight',delayMin,lastMessageFrom?:0~23 小时 gate} | {kind:'dailyTime',time:'HH:MM'}（或其数组）
 *   needs: string[],                        // KNOWN_NEEDS 子集
 *   selfDriven?: boolean,                   // 自驱声明：不经统一 runDue/runOnce（diary——取舍见 reflection/diary.js 文件头）
 *   product?: 'card'|'plan',                // 产物形态（缺省 'card'）：'plan' = 当日日程声明（life，night-plan-life §L2）——幂等按 planExists、落库经 person/life.write，不走卡管线
 *   buildTask: (data: object) => {system: string, user: string},
 *   parse: (raw: string, ctx: {day: string, data: object}) => {card: object|null, episodes?: Array<{text:string,valence:number,impact:number}>} | {plan: object},
 *   fallback: (data: object, day: string) => object,
 *   maxDaysBack?: number
 * }} ReflectionSpec
 */

// 注册表挂在 registryMap 函数对象的属性上（不用模块级 let/const）：cards.js 在
// 本模块 body 求值前就会调 registerSpec（受控循环，见文件头 import 注释），模块级
// let/const 那时还在 TDZ（实测 `Cannot access 'registry' before initialization`），
// 只有提升完成的函数对象能安全承载状态。写入口仍只有 registerSpec。
function registryMap() {
  if (!registryMap.map) registryMap.map = new Map();
  return registryMap.map;
}

/**
 * 只读注册表视图：`specs.cards` 取已注册声明（诊断/门禁自检/外部驱动用）。
 * 不暴露写入口——注册只能走 registerSpec（校验在门上）。
 */
export const specs = new Proxy(Object.create(null), {
  get: (_t, id) => (typeof id === 'string' ? registryMap().get(id) : undefined),
  has: (_t, id) => registryMap().has(String(id)),
  ownKeys: () => [...registryMap().keys()],
  getOwnPropertyDescriptor: (_t, id) => (registryMap().has(String(id))
    ? { value: registryMap().get(String(id)), enumerable: true, configurable: true }
    : undefined)
});

/** 注册一个声明；同 id 重复注册抛错（声明是启动期事实，不该悄悄换）。 */
export function registerSpec(spec) {
  // B 类词表（≤10 条目；超了就按 v3 §3 做成可注册小插件）——内联在函数体里，
  // 因为注册发生在受控循环的 pre-body 阶段，模块级 const 不可触碰（TDZ）。
  const KNOWN_NEEDS = ['messages', 'life', 'staging', 'facts'];
  if (!spec || typeof spec !== 'object') throw new Error('registerSpec 需要 ReflectionSpec');
  const { id, trigger, needs, buildTask, parse, fallback } = spec;
  if (typeof id !== 'string' || !id.trim()) throw new Error('ReflectionSpec.id 必须是非空字符串');
  if (registryMap().has(id)) throw new Error(`ReflectionSpec "${id}" 已注册`);
  const trig = Array.isArray(trigger) ? trigger : (trigger ? [trigger] : []);
  if (!trig.length) throw new Error(`ReflectionSpec "${id}" 缺 trigger`);
  for (const t of trig) {
    if (!t || typeof t !== 'object') throw new Error(`ReflectionSpec "${id}" trigger 项无效`);
    if (t.kind === 'afterLastMessage' && !(Number(t.delayMin) >= 0)) {
      throw new Error(`ReflectionSpec "${id}" afterLastMessage 缺 delayMin`);
    }
    if (t.kind === 'catchupDays' && !(Number(t.days) >= 1)) {
      throw new Error(`ReflectionSpec "${id}" catchupDays 缺 days`);
    }
    // afterGoodnight（步骤⑥ / T6.2；P2 起 cards 也用）：晚安后 delayMin 分钟。
    // "晚安"词表归 diary.js 私有（枢纽不持有词表）：非自驱声明的到点评价由
    // evaluateTrigger 经共享判定函数 lastGoodbyeAt 完成（night-plan §P2，判定只此一份）；
    // lastMessageFrom（0~23，可选）= 新 gate：当日最后消息早于该点不触发。
    if (t.kind === 'afterGoodnight' && !(Number(t.delayMin) >= 0)) {
      throw new Error(`ReflectionSpec "${id}" afterGoodnight 缺 delayMin`);
    }
    if (t.kind === 'afterGoodnight' && t.lastMessageFrom !== undefined
      && !(Number(t.lastMessageFrom) >= 0 && Number(t.lastMessageFrom) <= 23)) {
      throw new Error(`ReflectionSpec "${id}" afterGoodnight lastMessageFrom 需要 0~23 的小时数`);
    }
    // life-prose v2（2026-11-16）：dayShift=目标日相对材料日偏移（0/1）；
    // goodnightFrom=文字晚安的最早本地小时（0~23，life 用 22）。
    if (t.kind === 'afterGoodnight' && t.dayShift !== undefined
      && ![0, 1].includes(Number(t.dayShift))) {
      throw new Error(`ReflectionSpec "${id}" afterGoodnight dayShift 只能是 0 或 1`);
    }
    if (t.kind === 'afterGoodnight' && t.goodnightFrom !== undefined
      && !(Number(t.goodnightFrom) >= 0 && Number(t.goodnightFrom) <= 23)) {
      throw new Error(`ReflectionSpec "${id}" afterGoodnight goodnightFrom 需要 0~23 的小时数`);
    }
    // dailyTime（night-plan-life §L2）：每日计划触发——本地时钟过当日 time 点且当日
    // plan 缺失即 due（词表 3→4，B 类登记 architecture-v3 §8）。
    if (t.kind === 'dailyTime' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t.time ?? ''))) {
      throw new Error(`ReflectionSpec "${id}" dailyTime 缺合法 time（HH:MM）`);
    }
    if (!['afterLastMessage', 'catchupDays', 'afterGoodnight', 'dailyTime'].includes(t.kind)) {
      throw new Error(`ReflectionSpec "${id}" trigger.kind 不支持：${t.kind}`);
    }
  }
  if (!Array.isArray(needs) || needs.some((n) => !KNOWN_NEEDS.includes(n))) {
    throw new Error(`ReflectionSpec "${id}" needs 必须是 ${KNOWN_NEEDS.join('/')} 的子集`);
  }
  if (typeof buildTask !== 'function') throw new Error(`ReflectionSpec "${id}" 缺 buildTask`);
  if (typeof parse !== 'function') throw new Error(`ReflectionSpec "${id}" 缺 parse`);
  if (typeof fallback !== 'function') throw new Error(`ReflectionSpec "${id}" 缺 fallback`);
  registryMap().set(id, { ...spec, id, trigger: trig });
  return spec;
}

export function listSpecs() {
  return [...registryMap().values()].map((s) => ({ id: s.id, trigger: s.trigger, needs: s.needs, maxDaysBack: s.maxDaysBack ?? null }));
}

function specEnabled(spec) {
  return typeof spec.enabled === 'function' ? spec.enabled() !== false : spec.enabled !== false;
}

function specById(specOrId) {
  if (specOrId && typeof specOrId === 'object') return specOrId;
  const s = registryMap().get(String(specOrId));
  if (!s) throw new Error(`ReflectionSpec "${specOrId}" 未注册`);
  return s;
}

// ── 取数（读前额叶 + kernel/store；store 实例由皮层注入，不自建） ──────────

/**
 * 按 needs 词表取数。messages 来自 kernel/store（消息存档，前额叶组成部分）；
 * staging 来自 person/memory；life 经 person/life API（步骤⑥ / T6.3 接线：
 * 旧日程数据文件已迁 person/life.json，当日计划才有值，过去的天为 null）。
 * @param {string[]} needs
 * @param {{chatKey: string, day: string, store: object}} ctx
 */
export function fulfillNeeds(needs, { chatKey, day, materialDay = null, store }) {
  const out = {};
  const mDay = materialDay || day;
  for (const need of needs) {
    switch (need) {
      case 'messages': {
        const { start, end } = dayBounds(mDay);
        const all = store.recent(chatKey, { limit: 2000 });
        out.messages = all.filter((m) => Number(m?.ts) >= start && Number(m?.ts) < end);
        break;
      }
      case 'life': {
        // 步骤⑥接线（T6.3）：person/life.js 落地、旧日程数据文件已迁 person/life.json——
        // 经前额叶 API 读目标日计划（日期键 planForDay；旧数据回退 plan/plans）；
        // 补跑过去的天没有历史日程留档 → null（绝不把今天的日程织进过去的日子）。
        out.life = (() => { try { return life.planForDay(day); } catch { return null; } })();
        break;
      }
      case 'staging':
        out.staging = memory.staging(mDay);
        break;
      case 'facts': {
        // 人物表接地（2026-11-11）：既有长期事实（称呼/身份/约定）喂进任务材料，
        // 记忆整理者不再对"对方是谁"凭空猜测（11-09 卡性别写反的根因之一）。
        //
        // 预算 800 字（与 prompt.js 记忆段同口径）：事实是累积的，不设上限会把任务
        // 材料越撑越大。倒序取（新的优先）——任务材料不是提示词锚点，不受前缀缓存
        // 约束，"当前状况"比"最早的话"更该进人物表。
        const allFacts = memory.facts({ status: 'active' });
        const picked = [];
        let budget = 800;
        for (let i = allFacts.length - 1; i >= 0; i -= 1) {
          const f = allFacts[i];
          const line = `- [${f.kind}] ${String(f?.content ?? '')}`;
          if (line.length > budget) break;
          budget -= line.length;
          picked.unshift(f);
        }
        out.facts = picked;
        break;
      }
      default:
        console.warn(`[reflection] 未知 need "${need}"，跳过`);
    }
  }
  return out;
}

/** 当日是否已有卡（幂等依据：卡按日期归属，一天一卡）。 */
function cardExists(day) {
  return memory.cards({ from: day, to: day }).length > 0;
}

/**
 * 当日卡片是否"过期"（2026-11-15 写卡追踪，所有者提议）：写卡（writtenAt）之后
 * 当日又有对话（最后消息 ts > writtenAt）→ 白天版卡需补全。
 * 旧格式卡（v6 前写入，无 writtenAt）不算过期——避免升级后一次 catchup 把全部
 * 历史日重写；历史日的定稿走"晚安整理"按钮显式 force（routes run-evening 口径）。
 * @param {string} day YYYY-MM-DD
 * @param {number} sinceTs 当日最后一条消息的 ts
 */
function cardStale(day, sinceTs) {
  const w = memory.cardWrittenAt(day);
  return w != null && Number(w) < Number(sinceTs);
}

/** 某会话某日的最后一条消息 ts（无消息 → 0）。过期判定与 runOnce 跳过共用。 */
function dayLastMessageTs(store, chatKey, day) {
  const { start, end } = dayBounds(day);
  let last = 0;
  for (const m of store.recent(chatKey, { limit: 2000 })) {
    const ts = Number(m?.ts);
    if (ts >= start && ts < end && ts > last) last = ts;
  }
  return last;
}

/**
 * 当日是否已有计划（plan 声明的幂等依据：一天一 plan）。
 * date 为新协议键（night-plan-life §L2），dayKey 为兼容镜像——两个都认，
 * 旧形状 plan（旧日程时代 events 形状）也按已有计（不覆盖历史遗留状态）。
 */
function planExists(day) {
  try { return Boolean(life.planForDay(day)); } catch { return false; }
}

/** 组装一次任务的完整数据（fulfillNeeds + 定位信息）。 */
function buildTaskData(spec, { chatKey, day, materialDay = null, store, now }) {
  const mDay = materialDay || day;
  return {
    chatKey,
    day,
    materialDay: mDay,
    now,
    ...fulfillNeeds(spec.needs, { chatKey, day, materialDay: mDay, store })
  };
}

// ── 触发判定（check 的本体；钟不含这些词表，全部在这里） ──────────────────

/**
 * 求一个声明在某会话的到点目标日；不到点返回 null。
 *  · afterLastMessage：最后消息 + delayMin 分钟后，且该消息所在日尚未写卡；
 *  · catchupDays：过去 days 天（不含今天）里，从最近的没写卡但有消息的日子补起；
 *  · afterGoodnight（P2 日记化主路径）：互道晚安（判定复用 diary.js 的 lastGoodbyeAt，
 *    共享函数不复制词表）+ delayMin 分钟后；可选 lastMessageFrom（小时）限定当日最后
 *    消息不早于该点——cards 用 23:00，早睡的晚上由 afterLastMessage 兜底。
 * 卡片按日归属（MemoryCard.date），不分会话——同日多会话共用一张卡（单人部署口径）。
 */
function evaluateTrigger(trigger, { store, chatKey, now, spec = null }) {
  if (trigger.kind === 'afterLastMessage') {
    const last = store.recent(chatKey, { limit: 1 })[0];
    if (!last) return null;
    if (now - Number(last.ts) < Number(trigger.delayMin) * 60000) return null;
    const day = localDayKey(Number(last.ts));
    if (cardExists(day)) return null;
    return { day, materialDay: day, reason: `最后消息+${trigger.delayMin}min` };
  }
  if (trigger.kind === 'catchupDays') {
    const days = Math.max(1, Number(trigger.days) || 7);
    const all = store.recent(chatKey, { limit: 2000 });
    for (let i = 1; i <= days; i += 1) {
      const day = localDayKey(now - i * 86400000);
      const { start, end } = dayBounds(day);
      // 2026-11-15 写卡追踪：catchup 双职责=补缺卡 + 补全过期卡（写卡后当日又有
      // 对话 → 白天版卡次日起始心跳自动重写补全，见 cardStale——"到第二天时前一天
      // 的卡片一定完整"的保证链最后一环）。旧格式卡（无 writtenAt）不算过期。
      let dayLast = 0;
      for (const m of all) {
        const ts = Number(m?.ts);
        if (ts >= start && ts < end && ts > dayLast) dayLast = ts;
      }
      if (!dayLast) continue;
      if (cardExists(day) && !cardStale(day, dayLast)) continue;
      return { day, materialDay: day, reason: cardExists(day) ? `补全${i}天前的白天版卡` : `补跑${i}天前` };
    }
    return null;
  }
  if (trigger.kind === 'afterGoodnight') {
    // P2（night-plan §P2）：非自驱声明的晚安写卡主路径。互道晚安判定走 diary.js 的
    // lastGoodbyeAt（词表 bedtimeWords + 成对判定 + 12h 窗口共享一份，本模块不复制词表；
    // 该函数扫全部会话——单人部署口径，与 diary 的"互道晚安"同源）。此前该 kind 只
    // 登记不评价（只留给 selfDriven 的 diary，由它自己的 tick 驱动——diary 语义不变）。
    const goodnightAt = lastGoodbyeAt({ now, store });
    if (!goodnightAt) return null;
    // life-prose v2（2026-11-16）：文字晚安只算 22:00 之后——检查的是"互道晚安
    // 那个时刻"的本地小时，不是最后一条消息的小时。按钮走 runOnce 显式触发，不经此处。
    const goodnightFrom = Number(trigger.goodnightFrom);
    if (Number.isFinite(goodnightFrom) && new Date(goodnightAt).getHours() < goodnightFrom) return null;
    if (now - goodnightAt < Number(trigger.delayMin) * 60000) return null;
    const last = store.recent(chatKey, { limit: 1 })[0];
    if (!last) return null;
    // 新 gate（night-plan §P2）：限定当日最后消息 ≥ lastMessageFrom 点（cards=23:00，
    // life=22:00）——深夜聊完才走晚安写卡/备明日。2026-11-15（所有者拍板"兜底去掉"）：
    // afterLastMessage 兜底已随 cards 触发数组移除；晚安触发承担**定稿**语义——当日已有卡
    // 但写卡后又有对话（cardStale）→ 重写补全（同日替换），已是最新才跳过。
    const fromHour = Number(trigger.lastMessageFrom);
    if (Number.isFinite(fromHour) && new Date(Number(last.ts)).getHours() < fromHour) return null;
    const materialDay = localDayKey(Number(last.ts));
    if (spec?.product === 'plan') {
      // plan 声明（life）不吃 cardExists/cardStale：cards 先写卡后若再查卡，life 永远不
      // 触发。幂等只看目标日是否已有 plan（plansByDay/plan/plans 三层）。
      const targetDay = shiftDayKey(materialDay, Number(trigger.dayShift) || 0);
      if (planExists(targetDay)) return null;
      return { day: targetDay, materialDay, reason: `互道晚安+${trigger.delayMin}min（备 ${targetDay}）` };
    }
    const day = materialDay;
    if (cardExists(day) && !cardStale(day, Number(last.ts))) return null;
    return { day, materialDay: day, reason: `互道晚安+${trigger.delayMin}min${cardExists(day) ? '（补全白天版）' : ''}` };
  }
  if (trigger.kind === 'dailyTime') {
    // 每日计划（night-plan-life §L2，ReflectionSpec 'life'）：本地时钟过当日 time 点
    // 且当日 plan 缺失即 due。计划不分会话（单人部署口径，与卡同）——planExists 一票
    // 全局判；停机/重启后任意 ≥time 时刻首个心跳自然补跑（catchup 语义内建：
    // "启动时当日无 plan 则生成"，不另设补跑词表）。
    const [hh, mm] = String(trigger.time).split(':').map(Number);
    const d = new Date(now);
    if (d.getHours() * 60 + d.getMinutes() < hh * 60 + mm) return null;
    const day = localDayKey(now);
    if (planExists(day)) return null;
    return { day, materialDay: day, reason: `每日计划 ${trigger.time}` };
  }
  return null;
}

/** 当前到点的巩固目标（钟的 check 数据源；纯读不写）。 */
export function dueTargets(now = Date.now(), { store } = {}) {
  if (!store) return [];
  const targets = [];
  for (const spec of registryMap().values()) {
    if (!specEnabled(spec)) continue;
    // 自驱声明（selfDriven，步骤⑥ / T6.2 的 diary）：触发词表与模型参数是声明私有的，
    // 不进统一 runDue——由子系统自己的钟 tick 驱动；这里只登记、不评价。
    if (spec.selfDriven === true) continue;
    for (const chatKey of store.listChats()) {
      for (const trigger of spec.trigger) {
        const hit = evaluateTrigger(trigger, { store, chatKey, now, spec });
        if (hit) {
          targets.push({
            specId: spec.id,
            chatKey,
            day: hit.day,
            materialDay: hit.materialDay ?? hit.day,
            reason: hit.reason
          });
          break;   // 同声明同会话一次只跑一个目标日
        }
      }
    }
  }
  return targets;
}

/** 到点目标数（钟的 check 用；保持同步与廉价）。 */
export function dueCount(now = Date.now(), { store } = {}) {
  return dueTargets(now, { store }).length;
}

// ── 产出：fixture / model ────────────────────────────────────────────────

function fixturePath(spec, day) {
  // fixture 文件按声明产物形态定名：卡 = card-<day>.json（历史口径原样零漂移）；
  // plan 声明（life，night-plan-life §L2）= life-<day>.json——互不串读。
  const prefix = spec?.product === 'plan' ? 'life' : 'card';
  return path.join(ROOT, 'tools', 'fixtures', `${prefix}-${day}.json`);
}

/** 读 fixture（fixture 模式的"模型输出"替身）。缺失/坏 JSON 返回 null（走兜底）。 */
function readFixture(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  } catch {
    return null;
  }
}

async function produceOutput(spec, data, day) {
  const mode = getConfig()?.memory?.writer?.mode === 'model' ? 'model' : 'fixture';
  if (mode !== 'model') {
    return { mode: 'fixture', raw: readFixture(fixturePath(spec, day)) };
  }
  // 模型模式才动态 import llm.js（fixture 期间零加载、零网络）
  const { chatCompletionFully } = await import('../../llm.js');
  const task = spec.buildTask(data);
  const result = await chatCompletionFully({
    messages: [
      { role: 'system', content: task.system },
      { role: 'user', content: task.user }
    ],
    temperature: 0.3,
    maxTokens: 2000
  });
  return { mode: 'model', raw: extractText(result?.message?.content) };
}

/**
 * life-prose v2 stage 2：items 校验后的专用 prose 扩写（只 model 模式；fixture 的 prose
 * 由 parsePlan 直接从 fixture JSON 捕获，零网络）。失败返回空 raw，由调用方写 items-only。
 */
async function produceProse(spec, data, plan, day) {
  const mode = getConfig()?.memory?.writer?.mode === 'model' ? 'model' : 'fixture';
  if (mode !== 'model') return { mode: 'fixture', raw: null };
  if (typeof spec.buildProseTask !== 'function') return { mode: 'model', raw: '' };
  const { chatCompletionFully } = await import('../../llm.js');
  const task = spec.buildProseTask(data, plan);
  if (!task || !task.system || !task.user) return { mode: 'model', raw: '' };
  const result = await chatCompletionFully({
    messages: [
      { role: 'system', content: task.system },
      { role: 'user', content: task.user }
    ],
    temperature: 0.7,
    maxTokens: 1200
  });
  return { mode: 'model', raw: extractText(result?.message?.content) };
}

// ── 校验与写回（唯一合法通道：前额叶 API） ────────────────────────────────

/**
 * mid 当日范围校验：候选的 mid 必须能在当日消息里找到（消息的 mid 或本地 id）。
 * 原清单 §10.1："事实候选必须带 mid；系统校验该 mid 在当天范围内，否则丢弃。"
 * 返回 {ok: boolean, mid: number|null}。
 */
function validateMid(mid, dayMessages) {
  if (mid === null || mid === undefined || mid === '') return { ok: true, mid: null };   // 迁移数据允许 null（D9）
  const key = String(mid);
  const hit = dayMessages.find((m) => String(m?.mid ?? '') === key || String(m?.id ?? '') === key);
  // 落库的 mid 必须是数字（person/memory 的 staging/facts 契约：数字或 null）。
  // 2026-11-13 起入站消息的 mid 是协议串（web:…，见 orchestrator.submit 的回落），
  // 直接 Number() 会得到 NaN 并被 JSON 写成 null —— 出处就丢了。所以数字优先，
  // 非数字的协议 mid 退回本地 id（validateMid 本来就两者都认）。
  const numeric = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return hit ? { ok: true, mid: numeric(hit.mid) ?? numeric(hit.id) } : { ok: false, mid: null };
}

/**
 * 归一化并校验一张卡：date/range 以本地日界为准；facts/promises 逐条 mid 校验，
 * 失败的条目丢弃（不进卡、不进 facts）；salience/mood/events 容错成 schema 形状。
 * 返回 {card, episodes, dropped}。
 */
function normalizeCard(rawCard, { day, dayMessages, source }) {
  if (!rawCard || typeof rawCard !== 'object') return null;
  const events = (Array.isArray(rawCard.events) ? rawCard.events : [])
    .map((e) => String(e ?? '').trim()).filter(Boolean);
  const openLoops = (Array.isArray(rawCard.open_loops) ? rawCard.open_loops : [])
    .map((e) => String(e ?? '').trim()).filter(Boolean);

  // mid 校验：facts / promises 逐条过闸，失败的丢弃并计数
  let dropped = 0;
  // P4（night-plan §7.2）：mid=null 的候选按 D9 兜底放行（迁移数据口径），但
  // "staging mid:null 的条目不当事实来源"——保留即计数并留日志（可观测面）；
  // remember 工具 P4 起尽量带 mid，正常路径不该再出现 null。
  let nullMidKept = 0;
  const facts = [];
  for (const f of Array.isArray(rawCard.facts) ? rawCard.facts : []) {
    if (!f || typeof f !== 'object' || !String(f?.content ?? '').trim()) continue;
    const v = validateMid(f.mid, dayMessages);
    if (!v.ok) { dropped += 1; continue; }
    if (v.mid === null) nullMidKept += 1;
    facts.push({ kind: String(f.kind ?? ''), content: String(f.content).trim(), mid: v.mid });
  }
  // P12（2026-11-20）：facts 每卡最多 2 条——提示词协议之外的硬兜底。
  // 模型的“慷慨”不能变成长期事实膨胀；截断数单独记账，便于观察生成质量。
  const FACTS_PER_CARD_MAX = 2;
  let factsTruncated = 0;
  if (facts.length > FACTS_PER_CARD_MAX) {
    factsTruncated = facts.length - FACTS_PER_CARD_MAX;
    facts.length = FACTS_PER_CARD_MAX;
    console.warn(`[reflection] ${day} facts 超过每卡上限 ${FACTS_PER_CARD_MAX} 条，截断 ${factsTruncated} 条`);
  }
  const promises = [];
  for (const p of Array.isArray(rawCard.promises) ? rawCard.promises : []) {
    if (!p || typeof p !== 'object' || !String(p?.text ?? '').trim()) continue;
    const v = validateMid(p.mid, dayMessages);
    if (!v.ok) { dropped += 1; continue; }
    if (v.mid === null) nullMidKept += 1;
    promises.push({
      text: String(p.text).trim(),
      due: String(p.due ?? ''),
      status: String(p.status ?? 'open'),
      mid: v.mid
    });
  }
  if (nullMidKept > 0) {
    console.warn(`[reflection] ${day} 保留 ${nullMidKept} 条 mid=null 的事实/约定候选（无消息出处，D9 兜底放行；P4 起 staging 条目应尽量带 mid）`);
  }

  // range 用当日消息 id 的实际范围（模型给的只做参考，防止越界/编造）
  const ids = dayMessages.map((m) => Number(m?.id)).filter((n) => Number.isFinite(n));
  const range = ids.length
    ? { from: Math.min(...ids), to: Math.max(...ids) }
    : { from: 0, to: 0 };

  // salience 量纲明确为 0~5（2026-11-11）：契约原先只写 `number`、模板给 1，
  // 模型自由发挥出 0.5 / 0.72 / 0.9 / 3 / 4 混用，界面「显著度」一栏量纲不一致。
  // 这里 clamp 到 [0,5] 并保留一位小数（历史值全在区间内，无需迁移）。
  const salienceRaw = Number(rawCard.salience);
  const salience = Number.isFinite(salienceRaw)
    ? Math.round(Math.min(5, Math.max(0, salienceRaw)) * 10) / 10
    : 1;
  const card = {
    date: day,
    entry: String(rawCard.entry ?? '').trim(),   // P2 日记化：正文随卡落库（旧格式卡/兜底卡为空串）
    // card-vector 夜1（计划 §3.4 前置项/硬伤①）：normalizeCard 是白名单构造（不 spread
    // rawCard），gist/keywords 不在此透传就会被静默丢弃 → gist 层（卡级向量）静默为空。
    // slice/守卫照抄计划：gist ≤40 字、keywords ≤10 个（cards.js parseStrict 已清洗一遍，
    // 这里对 fixture/兜底/外部注入路径再兜一道底）。
    gist: String(rawCard.gist ?? '').trim().slice(0, 40),
    keywords: Array.isArray(rawCard.keywords)
      ? rawCard.keywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 10)
      : [],
    salience,
    events,
    facts,
    promises,
    open_loops: openLoops,
    mood: String(rawCard.mood ?? '').trim(),
    range,
    source
  };

  // （原 episodes 附加输出——情感事件喂 mind 数值轴——已于 2026-11-21 随心绪数值
  // 丢弃整体退役：协议不再要求 episodes，模型多给的该字段在此处被忽略不落卡。）

  return { card, dropped, factsTruncated };
}

/**
 * facts 候选 → person/memory.upsertFact（kind 白名单由 memory 侧把关）。
 * V4 收口（T4.3）错误口径：带 validation 标记的校验错（memory.validationError——
 * kind/subject/content/mid/key 非法）→ 逐条丢弃（文件时代语义原样保留）；
 * 未带标记的 DB/基础设施级失败 → 上抛 → 巩固事务整体 ROLLBACK（绝无半截状态）。
 */
function upsertCardFacts(card) {
  let upserted = 0;
  let dropped = 0;
  for (const f of card.facts) {
    try {
      const entry = memory.upsertFact({
        kind: f.kind,
        subject: 'other',   // 单人部署口径；协议暂无 subject 字段，非法值不猜
        content: f.content,
        mid: f.mid,
        source: `reflection:${card.source}`
      });
      upserted += 1;
      // card-index（card-vector 夜1 T1.7）：落库成功的事实逐条进向量索引（fire-and-forget；
      // syncFact 内置对账修剪——supersede 孤儿向量行自愈，见 card-index.js 头注）。upsertFact
      // 幂等短路也返回落盘条目（带 key），重复巩固零嵌入成本。索引失败只造成滞后
      // （stats 可见 + rebuild 兜底），绝不影响巩固链路。
      if (entry?.key) cardIndex.syncFact(entry).catch(() => {});
    } catch (err) {
      if (!err?.validation) throw err;   // V4 收口：非校验错不吞——巩固事务整体回滚
      dropped += 1;
      console.warn(`[reflection] 事实候选被丢弃（${f.kind}:${f.content?.slice(0, 20)}…）:`, err?.message ?? err);
    }
  }
  return { upserted, dropped };
}

// ── runOnce（支持注入数据，自测/补跑共用） ────────────────────────────────

/**
 * plan 落库（plan 声明唯一写点；唯一合法通道 person/life.write——life.js 是
 * life.json 的唯一写者）。life-prose v2（2026-11-16）：
 *   · plan = {date, dayKey, prose, items, generatedAt}；
 *   · plansByDay[day] 是权威存储（最近 30 天）；plan 只做“今天”的兼容镜像；
 *     plans 保留最近 7 天历史（entry 带 prose）供 buildPlanPrompt 防重复；
 *   · 写明天不把今天归档（今天仍是当前 plan）；写今天才把昨天/更早归档；
 *   · prose 必须落库（旧实现只拷 date/dayKey/items/generatedAt，prose 会静默丢）。
 * 返回落库后的 plan；life.write 失败返回 null（调用方走 failed + 冷却）。
 */
function writeLifePlan(plan, day, now = Date.now()) {
  const prev = life.read() ?? {};
  const prevPlan = (prev.plan && typeof prev.plan === 'object') ? prev.plan : null;
  const today = localDayKey(now);
  const out = {
    date: day,
    dayKey: day,
    prose: String(plan?.prose ?? '').trim().slice(0, 600),
    items: Array.isArray(plan?.items) ? plan.items : [],
    generatedAt: Date.now()
  };
  const prevByDay = (prev.plansByDay && typeof prev.plansByDay === 'object' && !Array.isArray(prev.plansByDay))
    ? prev.plansByDay
    : {};
  const byDay = { ...prevByDay, [day]: out };
  // 30 天窗口：按日期键排序，淘汰最旧（未来日不会被淘汰，除非超过 30 个未来日）。
  const keys = Object.keys(byDay).sort();
  while (keys.length > 30) {
    const oldest = keys.shift();
    delete byDay[oldest];
  }
  const planMirror = byDay[today] ?? (day === today ? out : prevPlan);
  const next = { ...prev, dayKey: today, plan: planMirror, plansByDay: byDay };
  const prevDate = prevPlan ? String(prevPlan.date ?? prevPlan.dayKey ?? '') : '';
  // 写明天时 prevPlan 是今天——今天仍在用，不能归档；写今天时昨天的 plan 归档。
  if (prevDate && prevDate !== day && prevDate !== today) {
    const history = (Array.isArray(prev.plans) ? prev.plans : [])
      .filter((p) => p && String(p?.date ?? p?.dayKey ?? '') !== prevDate);
    history.push({
      date: prevDate,
      prose: String(prevPlan.prose ?? ''),
      items: Array.isArray(prevPlan.items) ? prevPlan.items : [],
      generatedAt: prevPlan.generatedAt ?? null
    });
    next.plans = history.slice(-7);
  }
  return life.write(next) ? out : null;
}

// 硬失败冷却：同一目标失败后 30 分钟内不再重试（心跳 60s 一轮，避免刷屏）
const failedUntil = new Map();
const FAIL_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * 跑一次巩固任务。
 * @param {ReflectionSpec|string} specOrId 声明或其 id
 * @param {{
 *   data?: object,            // 注入的完整任务数据（自测用，不读文件/不读 store）
 *   day?: string,             // 目标日 YYYY-MM-DD（缺省 = 今天）
 *   materialDay?: string,     // 材料日（缺省 = 目标日；晚安备明天时=今天）
 *   chatKey?: string,         // 未注入 data 时的取数会话
 *   store?: object,           // 未注入 data 时的取数来源（orchestrator 注入）
 *   now?: number,
 *   force?: boolean           // 晚安整理按钮口径（night-plan-life §L1）：跳过幂等/冷却早退
 * }} opts
 * @returns {Promise<{status:'written'|'fallback'|'skipped'|'failed', day: string, mode?: string,
 *                     card?: object, plan?: object, factsUpserted?: number, factsDropped?: number,
 *                     midDropped?: number, reason?: string}>}
 */
export async function runOnce(specOrId, { data = null, day = null, materialDay = null, chatKey = null, store = null, now = Date.now(), force = false } = {}) {
  const spec = specById(specOrId);
  const targetDay = day || localDayKey(now);
  if (!specEnabled(spec)) return { status: 'skipped', day: targetDay, reason: 'disabled' };
  // 自驱声明守门（步骤⑥ / T6.2）：diary 的产出是日记条目不是记忆卡，模型参数也私有；
  // 误入统一 runOnce 会把日记喂进 normalizeCard/writeCard 管线——显式拒绝而非硬跑。
  if (spec.selfDriven === true) {
    return { status: 'skipped', day: targetDay, reason: 'self-driven（不经统一 runOnce，见 reflection/diary.js 文件头取舍说明）' };
  }

  // 幂等 + 过期补全（2026-11-15 写卡追踪）：卡声明的跳过条件从"当日已写卡"升级为
  // "当日已写卡且未过期"——写卡（writtenAt）之后当日又有对话（cardStale）→ 定时链路
  // （晚安定稿/catchup）放行重写补全（同日替换，绝不双卡）。旧格式卡（无 writtenAt）
  // 与当日无消息（dayLast=0）都视为未过期 → 原样跳过。plan 声明（life）幂等口径不变。
  // force（night-plan-life §L1 控制台「晚安整理」按钮 / PWA 晚安按钮）：按钮语义=
  // 所有者主动要求"把今天重新整理一遍"→ 放行重跑重调模型；失败冷却同样只拦定时链路。
  const isPlanSpec = spec.product === 'plan';
  if (!force && (isPlanSpec
    ? planExists(targetDay)
    : (cardExists(targetDay) && !cardStale(targetDay, dayLastMessageTs(store, chatKey, targetDay))))) {
    return { status: 'skipped', day: targetDay, reason: isPlanSpec ? 'plan-exists' : 'card-exists' };
  }

  const cooldownKey = `${spec.id}@${targetDay}`;
  // 失败冷却同样只拦定时链路：按钮点击是显式重试请求，不该被 30 分钟冷却顶回去。
  if (!force && (failedUntil.get(cooldownKey) ?? 0) > now) {
    return { status: 'skipped', day: targetDay, reason: 'fail-cooldown' };
  }

  const taskData = data || buildTaskData(spec, {
    chatKey: chatKey || (store ? (store.listChats()[0] ?? null) : null),
    day: targetDay,
    materialDay: materialDay || targetDay,
    store,
    now
  });
  const dayMessages = Array.isArray(taskData.messages) ? taskData.messages : [];

  let mode = 'fixture';
  let raw = null;
  try {
    const produced = await produceOutput(spec, taskData, targetDay);
    mode = produced.mode;
    raw = produced.raw;
  } catch (err) {
    // 产出失败（模型调用/网络/fixture 读盘异常）→ failed + 冷却，**不写兜底卡**：
    // v3 T5.2「兜底=抽取式卡」按字面只覆盖"解析失败"路径（下一段）；模型刚坏时
    // 每个心跳写一张半空抽取卡只会刷屏。此为已披露偏差（进度步骤⑤执行期决策③）。
    console.warn(`[reflection] ${spec.id} 产出失败（${targetDay}）:`, err?.message ?? err);
    failedUntil.set(cooldownKey, now + FAIL_COOLDOWN_MS);
    return { status: 'failed', day: targetDay, mode, reason: String(err?.message ?? err) };
  }

  // 解析 → 兜底：解析失败（含 fixture 缺失）走兜底——plan 声明=空 plan 不落库（下一段），
  // 卡声明=抽取式卡（source:'fallback'）。
  let parsed = null;
  try {
    parsed = spec.parse(raw, { day: targetDay, data: taskData });
  } catch (err) {
    console.warn(`[reflection] ${spec.id} 解析失败（${targetDay}），走兜底:`, err?.message ?? err);
  }

  // ── plan 声明（life，night-plan-life §L2）：产物=当日日程，不走卡管线 ──
  // 兜底=空 plan（不产假日程）。空 plan **不落库**：落库只会把当日封死（planExists
  // 恒真、再无重试），而空 plan 没有任何内容值得占位——走失败冷却，下轮心跳
  // （30 分钟后）重试；模型持续坏的那天就没有计划，与"不产假日程"同一口径。
  if (isPlanSpec) {
    if (parsed?.plan) {
      // stage 2（life-prose v2）：items 已校验 → 专用 prose 扩写。只 model 模式；
      // fixture 的 prose 由 parsePlan 从同一 life-<day>.json 捕获（零网络）。
      // 扩写失败/过短仍写 items-only plan，不丢当天、不进失败冷却。
      let plan = parsed.plan;
      const proseBefore = String(plan.prose ?? '').trim();
      if (!proseBefore && mode === 'model' && typeof spec.buildProseTask === 'function') {
        try {
          const pr = await produceProse(spec, taskData, plan, targetDay);
          const prose = typeof spec.parseProse === 'function' ? spec.parseProse(pr?.raw) : '';
          if (prose) {
            plan = { ...plan, prose };
          } else {
            console.warn(`[reflection] ${spec.id} ${targetDay} prose 扩写为空/过短——写 items-only plan`);
          }
        } catch (err) {
          console.warn(`[reflection] ${spec.id} ${targetDay} prose 扩写失败（写 items-only plan）:`, err?.message ?? err);
        }
      }
      const written = writeLifePlan(plan, targetDay, now);
      if (!written) {
        failedUntil.set(cooldownKey, now + FAIL_COOLDOWN_MS);
        return { status: 'failed', day: targetDay, mode, reason: 'life-write-failed' };
      }
      const loads = written.items.filter((i) => i?.emotionalLoad).length;
      const proseLen = String(written.prose ?? '').trim().length;
      console.log(`[reflection] ${spec.id} ${targetDay} written（mode=${mode} 条目 ${written.items.length}，载荷 ${loads} 条，prose ${proseLen} 字）`);
      return { status: 'written', day: targetDay, mode, plan: written, prose: proseLen };
    }
    failedUntil.set(cooldownKey, now + FAIL_COOLDOWN_MS);
    return {
      status: 'fallback',
      day: targetDay,
      mode,
      reason: '解析失败/计划无效——空 plan 兜底不落库（不产假日程，night-plan-life §L2）',
      plan: spec.fallback(taskData, targetDay)?.plan ?? null
    };
  }

  let source = 'model';
  let card = null;
  if (parsed?.card) {
    card = parsed.card;
    if (mode === 'fixture') source = 'fixture';
  } else {
    card = spec.fallback(taskData, targetDay);
    source = 'fallback';
  }

  const normalized = normalizeCard(card, { day: targetDay, dayMessages, source });
  if (!normalized) {
    failedUntil.set(cooldownKey, now + FAIL_COOLDOWN_MS);
    return { status: 'failed', day: targetDay, mode, reason: 'normalize-empty' };
  }

  // ── 写回（全部经前额叶 API；storage-v2 V4 收口：巩固段 = 单事务）──────────
  // plan §4「迁移期写顺序警告」的收口：writeCard（cards 表）+ upsertCardFacts（facts 表）
  // 在同一 db.transaction 内——中途任何未被内部兜底吞掉的失败（upsertCardFacts 只吞
  // validation 标记的校验错）整体 ROLLBACK，绝无半截巩固状态。
  //（原 applyEpisodes→mind.apply 第三写面已随 2026-11-21 心绪数值丢弃退役——
  //  episodes 不再有消费方，巩固事务回到 cards/facts 双表。）
  // 事务失败 → failed + 冷却（不再上抛：时钟 heartbeat fire().catch 吞错，按钮方有
  // try/catch——failed 结果比被吞的异常更可观测，口径与产出失败一致）。
  // card-index 派生索引移到事务提交之后（fire-and-forget 语义不变；回滚路径不索引幻影卡）。
  let factStats;
  try {
    transaction(() => {
      memory.writeCard(normalized.card);
      factStats = upsertCardFacts(normalized.card);
    });
  } catch (err) {
    console.warn(`[reflection] ${spec.id} ${targetDay} 巩固事务失败（已整体回滚）:`, err?.message ?? err);
    failedUntil.set(cooldownKey, now + FAIL_COOLDOWN_MS);
    return { status: 'failed', day: targetDay, mode, reason: `consolidation-transaction-failed: ${String(err?.message ?? err)}` };
  }
  // card-index（card-vector 夜1 T1.7 / 计划 §3.4）：写回分支唯一索引写入点。fire-and-forget
  // （.catch 吞错）——索引失败绝不影响巩固；同日替换卡经 content_hash 变化自动更新向量。
  // 关闭态（memory.embedding.enabled=false）/无 gist 卡（兜底卡/旧格式卡）在 syncCard
  // 内跳过登记，零网络零行为变化。所有调用方（钟 runDue / routes 按钮 / 外部驱动）自动覆盖。
  cardIndex.syncCard(normalized.card).catch(() => {});

  const status = source === 'fallback' ? 'fallback' : 'written';
  console.log(`[reflection] ${spec.id} ${targetDay} ${status}（mode=${mode} 正文${normalized.card.entry.length}字/事件${normalized.card.events.length} 条/事实+${factStats.upserted}/mid 丢弃 ${normalized.dropped}）`);
  return {
    status,
    day: targetDay,
    mode,
    card: normalized.card,
    factsUpserted: factStats.upserted,
    factsDropped: factStats.dropped,
    midDropped: normalized.dropped
  };
}

/** 跑完当前所有到点目标（钟的 run 用；皮层注入 store）。 */
export async function runDue({ store, now = Date.now() } = {}) {
  if (!store) return [];
  const results = [];
  for (const target of dueTargets(now, { store })) {
    results.push(await runOnce(target.specId, {
      chatKey: target.chatKey,
      day: target.day,
      materialDay: target.materialDay ?? target.day,
      store,
      now
    }));
  }
  return results;
}
