// 人格内核 · 生活状态（步骤⑥ / T6.3）
// storage-v2 V4 起后端 = xunxi.db **state 表（key='life'，整对象 JSON 列）**
//（原 data/person/life.json 已随迁移改为 .pre-storage-v2 原位归档）。
//
// 本文件是 life 状态的**唯一写者**。旧日程数据文件已由
// migrate-life.mjs 复制式迁移（+ 归档到 _archive-20261107/data/），旧文件冻结只读、
// 步骤⑦随旧数据一并归档——任何人不得再读写旧日程数据文件。
//
// 写方：旧日程插件（Q15 · 2026-11-13 已禁用）——**当前无活跃写者，历史只读**；
//       重写规格见 内部文档 life-rewrite-notes.md（目标：reflection/life + life tick）。
//       V4 起活跃写者 = executor.writeLifePlan（life-prose v2，plansByDay/plans/prose
//       三层整体经本模块 write() 落 state 表）。
// 读者：src/capabilities/reflection/diary.js（日记素材"她今天做过什么"）、
//       反思执行器 fulfillNeeds('life')、UI `/api/person/state`（lifeToday；过期返回 null）、
//       prompt.js【今日日程】段（planForDay）。
//
// 机制沿文件时代的 API 形状原样保留（read 深拷贝/缺档 null、planForDay 三层回退、
// write 校验 plain object 失败 warn 返 false）；mtime 缓存与「损坏重命名重建」随文件
// 机制退役——DB json 列由本模块唯一写入、恒为合法 JSON（state-map 契约 1）。
import path from 'node:path';
import { DATA_DIR as DATA_ROOT, getConfig } from '../config.js';
import { stateGet, statePut } from '../storage/state-map.js';

// V4 前的唯一真身路径（现 = .pre-storage-v2 原位归档；仅诊断/迁移脚本/日志用）。
const FILE = path.join(DATA_ROOT, 'person', 'life.json');

/**
 * 读生活状态（深拷贝；状态不存在返回 null）。
 * 调用方（life/executor）自行与 emptyState 合并——存储层只管存取，不解释字段。
 */
export function read() {
  const data = stateGet('life');   // 缺行 → null；json 解析失败防御 → null（不可达路径，warn 语义同文件时代）
  if (!data) return null;
  try {
    return structuredClone(data);
  } catch {
    return null;
  }
}

/**
 * 按日期取 plan（纯读；不解释字段）。
 * 2026-11-16（life-prose v2）起 `plansByDay[day]` 是权威存储；`plan` 只作今天兼容镜像，
 * `plans` 保留最近 7 天历史。三层都认，旧数据（只有 plan/plans）无需迁移。
 */
export function planForDay(day) {
  const d = String(day ?? '').trim();
  if (!d) return null;
  const state = read();
  if (!state || typeof state !== 'object') return null;
  const byDay = state.plansByDay;
  if (byDay && typeof byDay === 'object' && !Array.isArray(byDay)) {
    const p = byDay[d];
    if (p && typeof p === 'object') return p;
  }
  const cur = state.plan;
  if (cur && typeof cur === 'object' && (cur.date === d || cur.dayKey === d)) return cur;
  if (Array.isArray(state.plans)) {
    const hit = state.plans.find((p) => p && typeof p === 'object' && (p.date === d || p.dayKey === d));
    if (hit) return hit;
  }
  return null;
}

/** 整对象 UPSERT（state-map 契约：单语句原子）。失败 warn 并返回 false（API 语义不变）。 */
export function write(state) {
  try {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('life.write 需要 plain object');
    }
    statePut('life', state);
    return true;
  } catch (e) {
    console.warn(`[person/life] 存档写入失败：${e?.message ?? e}`);
    return false;
  }
}

// ── T6 · 只读可用性派生（design §2.3 / D18；night-plan §2-T6"三规则写死"）────────
// `availability()` 是只读派生函数，**不是新状态写者**——life 的唯一写者仍是
// executor.writeLifePlan（本文件文件头口径）。不做机器学习式打分（D18 原文）。
//
//   R1 sleeping：config.voice.call.dnd 免打扰窗覆盖当前时刻（可跨午夜，缺省
//      23:30→08:00），**或** life 今日计划当前时段条目词面命中睡眠（条目自其
//      time 起持续到下一条 time；最后一条到当日 24:00）。
//   R2 busy：life 今日计划当前时段条目词面命中专注/在忙（未命中 R1 才判）。
//   R3 available：缺省——life 无状态/时段无条目（§2.3 表 away 行）按 available
//      处理，不做无依据的拒绝。
//
// 计划条目 activity 是散文不是结构化字段——词面判定是"写死三条、不做打分"的
// 直接代价：关键词表=下面两个常量，改动属产品行为变更（同步 handoff/设计稿）。
// 消费面：接听判定（design §2.3"她可以不接"）——V3 夜窗只落派生函数本体，
// 接线未做（night-plan §2-T6 任务面只点名函数；登记 handoff）。
const SLEEP_ACTIVITY_RE = /睡|就寝|午休/;                       // 睡眠段词面（含入睡/睡觉/午休小憩）
const BUSY_ACTIVITY_RE = /专注|在忙|忙|工作|加班|开会|赶稿|画稿|改稿|修图|截稿|交稿|复习|备考|考试/;

/** 'HH:MM' → 当日分钟数；不合法（非 HH:MM/越界）→ null。写面 TIME_RE 同域（00:00–23:59）。 */
function parseHM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function localDayKeyOf(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 当前时段条目（activity 文本；不在任何时段 → null）。条目覆盖=[本条 time, 下一条 time)。 */
function currentPlanActivity(now, mins) {
  let plan = null;
  try { plan = planForDay(localDayKeyOf(now)); } catch { return null; }
  const items = Array.isArray(plan?.items) ? plan.items : [];
  const parsed = [];
  for (const it of items) {
    const activity = String(it?.activity ?? '').trim();
    const m = parseHM(it?.time);
    if (!activity || m == null) continue;   // 不合格条目不参与派生（写面已滤，这里再兜）
    parsed.push({ m, activity });
  }
  if (!parsed.length) return null;
  parsed.sort((a, b) => a.m - b.m);
  let cur = null;
  for (const p of parsed) {
    if (p.m <= mins) cur = p;
    else break;
  }
  return cur?.activity ?? null;   // 全部条目都在未来（清晨）→ 无时段 → available
}

/**
 * 她现在可不可以接电话（只读派生，零写入零副作用）。
 * @param {number} [now] 时刻毫秒（缺省 Date.now()；测试注入确定性时刻）
 * @returns {'sleeping'|'busy'|'available'}
 */
export function availability(now = Date.now()) {
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();

  // R1a：dnd 免打扰窗（start/end 'HH:MM'；跨午夜= start>end 时 m≥start || m<end）
  try {
    const raw = getConfig()?.voice?.call?.dnd;
    const start = parseHM(raw?.start);
    const end = parseHM(raw?.end);
    if (start != null && end != null) {
      const inWindow = start <= end ? (mins >= start && mins < end) : (mins >= start || mins < end);
      if (inWindow) return 'sleeping';
    }
  } catch { /* config 读失败 → 该规则不判，继续走计划/缺省 */ }

  // R1b + R2：life 今日计划当前时段条目（睡眠优先于在忙——睡觉的人不会再被判忙）
  const activity = currentPlanActivity(now, mins);
  if (activity) {
    if (SLEEP_ACTIVITY_RE.test(activity)) return 'sleeping';
    if (BUSY_ACTIVITY_RE.test(activity)) return 'busy';
  }
  return 'available';
}

/** V4 前状态文件绝对路径（诊断/迁移脚本/日志用；V4 起真身 = xunxi.db state 表 key='life'）。 */
export const lifeFile = FILE;
