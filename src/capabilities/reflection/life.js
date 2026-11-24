// 声明模块 · 当日日程（night-plan-life §L2）—— ReflectionSpec 'life'（product:'plan'）。
//
// 身份：本声明（灵魂：触发/任务模板/解析/兜底）+ person/life.js（存储唯一写者 API）
//       + 执行器统一管线（触发评价/产出/落库在 executor.js 的 plan 分支）。
// 触发：{kind:'dailyTime', time:'06:30'}——executor 触发词表 3→4 新增 'dailyTime'
//       （B 类耦合登记 architecture-v3 §8：调度器触发词表 4/10 条目）。语义 = 本地时钟
//       过当日 06:30 且当日 plan 缺失即 due；重启/停机后任意 ≥06:30 时刻，心跳首轮
//       自然补跑——catchup（启动时当日无 plan 则生成）语义内建，不另设补跑词表。
// needs：['messages', 'life', 'staging']——均在 KNOWN_NEEDS 现词表内，无 B 类增长。
//       （'life' 经 fulfillNeeds 取当日既有计划：正常生成路径恒 null——触发条件就是
//        "当日缺失"；force 重跑场景非空，作"已有计划"参考材料。'staging' 为 W5 细节化
//        新增：材料日暂存笔记进生成材料，与当日记忆卡一起给日程/散文供真事钩子。）
//
// 三原则落地（brain-redesign-brief.md §5.5，所有者 2026-11-14 拍板）：
//   1. 日程饱满带扰动——一天 5-8 条具体小事，随机灵感池（SEEDS，4 类 ≥24 条）每次
//      抽 2-3 条进材料；最近 3 天 plan 摘要进材料防重复。
//   2. 日程事件带情绪载荷——1-3 条带 emotionalLoad（≤20 字第一人称情绪注 note；
//      原 valence 数值轴已随 2026-11-21"数值不注入即丢弃"裁定移除——载荷的消费在
//      L3：life tick 只标 consumedAt，mood 文本归 mind_note 模型自驱），含坏事件
//      （烦人的会/跑腿/等待结果/小意外）：私聊场景没人对她 mean，生活是唯一合理的
//      负面情绪来源。本声明只产不耗。
//   3. 主动开口解耦——日程只排"她自己的日子"，不安排发消息/找他说话（那是另一套
//      机构的决定，本夜不做）；对他的惦记只允许出现在情绪注里。
//
// 人设接地（同 cards.js 模式，2026-11-11 教训）：roleText
//       + identity/address_name 既有事实——学生/上班族形态完全由人设决定，模板里
//       绝不硬编码任何作息形态。（2026-11-21：self 叙事/价值材料随 self 面丢弃摘除。）
// 输出协议：{date, items:[{time:'HH:MM', activity, emotionalLoad?:{note}}]}。
// 解析：严格 JSON + 逐条校验（time 格式不合格丢弃 / 载荷只留 note 截 20 字
//       / 清洗后 ≥3 条才算有效计划，>8 截 8 / 按 time 升序去重）。
// 兜底：空 plan（不产假日程）——**不落库**（落库只会把当日封死：planExists 恒真、
//       再无重试），走执行器失败冷却 30 分钟后由下一轮心跳重试（取舍见 executor.js）。
//
// 本模块的声明本体（spec）不写任何状态——plan 生成路径的写回全部由执行器经
// person/life.write 完成（见 executor.js writeLifePlan）、不 import 身体模块。
// §L3（生活→心绪接线）起，本模块额外承载 life tick 的 check/run（消费接线）：
//   · check：今日 plan 存在 + 有"时间已过且未消费"的 emotionalLoad 条目；
//   · run：条目标 consumedAt（person/life.write 原子重写）——原 mind.apply 数值
//     消费已随 2026-11-21 数值丢弃移除（mood 文本归 mind_note 模型自驱，别处不动）。
//   写入只走唯一写者 API（person/life.write），orchestrator 只做注册转发
//   （startClock 第三 tick，钟不含业务词表）。

import { getConfig, ownerLabelFor } from '../../config.js';
import { OWNER_ACTOR_ID } from '../../person/contracts.js';
import * as memory from '../../person/memory.js';
import * as lifeStore from '../../person/life.js';
import { registerSpec } from './executor.js';

// ── 灵感池（三原则 1"扰动"的种子表；4 类 ≥24 条，人设中立——不预设学生/上班族） ──
// 具名导出：验收/门禁断言池规模与类别覆盖用（改动池规模时断言同改）。
export const SEEDS = [
  // 日常（家里的日子）
  '把攒了两天的衣服洗了晾出去',
  '去楼下便利店买杯热的',
  '给绿萝浇水，顺手剪掉黄叶',
  '把床单被套换下来洗',
  '买菜，做一顿没做过的',
  '把屋里角落的灰掸一掸',
  '取快递，顺手把垃圾带下去',
  '给自己泡壶茶，坐窗边喝',
  // 学习/自我
  '把那本短篇集往下读两篇',
  '背一页一直想记的单词',
  '看一集纪录片',
  '读掉收藏夹里存了很久的一篇文章',
  '照着菜谱学一道新菜',
  '把笔记和收藏整理一遍',
  // 娱乐
  '看两集一直搁置的剧',
  '听歌单里很久没点开的老歌',
  '玩一局不用动脑的小游戏',
  '翻旧照片看一会儿',
  '随手画点小涂鸦',
  '给手帐贴贴纸写两行',
  // 小意外（坏事件候补——三原则 2 的负面情绪来源）
  '楼上装修电钻响个不停',
  '出门忘带钥匙，折返一趟',
  '煮汤时接电话，汤溢了',
  '快递到了，拆开发现发错颜色',
  '外卖送错单，折腾了十分钟',
  '突然降温，翻箱倒柜找厚衣服',
  '手机滑进床缝，捞了半天才出来',
  '网络抽风，视频加载了半天'
];

/** 从灵感池随机抽 n 条（不重复）。n 由随机决定 2~3。 */
function pickSeeds() {
  const n = 2 + Math.floor(Math.random() * 2);   // 2 或 3
  const pool = SEEDS.slice();
  const out = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 'YYYY-MM-DD' → '周X'（本地时区口径，与 executor.localDayKey 同源）。 */
function weekdayOf(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()] ?? '';
}

// ── 材料：人物表 + 最近 3 天摘要 ──────────────────────────────────────────

/** identity/address_name 既有事实（称呼与身份的权威来源；同 cards 的人物表接地）。 */
function identityFacts() {
  const picked = [];
  try {
    for (const f of memory.facts({ status: 'active' })) {
      if (f?.kind === 'identity' || f?.kind === 'address_name') {
        picked.push(`- [${f.kind}] ${String(f?.content ?? '')}`);
      }
    }
  } catch { /* 事实读不到不算致命 */ }
  return picked;
}

/** plan.items → 一行摘要（时间+事项；不带情绪注——摘要只用于查重）。 */
function summarizeItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((i) => `${String(i?.time ?? '')} ${String(i?.activity ?? '')}`.trim())
    .filter(Boolean)
    .join('；');
}

/**
 * 最近 3 天的 plan 摘要（防重复材料）。来源四层：
 *   ① 当前 state.plan（新协议无 rollover——生成日的上一刻它就是"昨天那份"，比历史更新）；
 *   ② plans 历史（L2 起 writeLifePlan 维护，新协议 items）；
 *   ③ 遗留 lastPlan（旧插件 rollover 的上一份 plan，events 形状）——首日新历史为空时顶上；
 *   ④ 遗留 lifeLog（旧插件往天一句话留档）——再补。
 * 历史只读：四层都只读不写；目标日自身排除（force 重跑不把旧版自己当"前几天"）。
 */
export function recentPlanSummaries(targetDay, maxDays = 3) {
  const state = (() => { try { return lifeStore.read(); } catch { return null; } })();
  const out = [];
  const seen = new Set();
  const push = (date, text) => {
    const day = String(date ?? '').trim();
    const body = String(text ?? '').trim();
    if (!day || !body || day === targetDay || seen.has(day) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    seen.add(day);
    out.push({ date: day, text: body });
  };
  const cur = state?.plan;
  if (cur && typeof cur === 'object') {
    push(cur.date ?? cur.dayKey, summarizeItems(cur.items));
  }
  // life-prose v2：plansByDay 是日期键权威（含昨晚写好的明日 plan），防重复必须读它；
  // 旧 plans 继续兜底。
  const byDay = state?.plansByDay;
  if (byDay && typeof byDay === 'object' && !Array.isArray(byDay)) {
    for (const p of Object.values(byDay)) {
      if (p && typeof p === 'object') push(p.date ?? p.dayKey, summarizeItems(p.items));
    }
  }
  for (const p of Array.isArray(state?.plans) ? state.plans : []) {
    push(p?.date ?? p?.dayKey, summarizeItems(p?.items));
  }
  if (out.length < maxDays) {
    const lp = state?.lastPlan;
    if (lp && Array.isArray(lp.events) && lp.events.length) {
      push(lp.dayKey, lp.events
        .map((e) => `${String(e?.time ?? '')} ${String(e?.what ?? '')}`.trim())
        .filter(Boolean)
        .join('；'));
    }
  }
  if (out.length < maxDays) {
    for (const e of Array.isArray(state?.lifeLog) ? state.lifeLog : []) {
      push(e?.dayKey, String(e?.summary ?? '').split('｜')[1] ?? String(e?.summary ?? ''));
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, maxDays);
}

// ── 任务模板（buildPlanPrompt：人设接地 + 三原则） ────────────────────────

const PLAN_SCHEMA_TEXT = `{
  "date": "YYYY-MM-DD",
  "items": [
    { "time": "HH:MM",
      "activity": "一句话说清做什么：地点/对象+动作+细节（10~30 字，具体到能想象画面）",
      "emotionalLoad": { "note": "≤20字的第一人称情绪注" } }
  ]
}`;

/**
 * 材料日的真事钩子（W5 细节化，night-plan-polish §2-W5-②）：当日记忆卡 + 暂存笔记
 * 排版成材料行，让日程/散文引用当天真实事件做续写钩子（所有者反馈：产出突兀、
 * 不饱满、缺细节）。只读 + 全容错（材料缺 = 空数组，绝不因读失败打断生成）。
 * @param {string} materialDay YYYY-MM-DD（材料日）
 * @param {Array<{text?: string, at?: number}>} [stagingEntries] executor fulfillNeeds 取的当日 staging
 * @returns {string[]} 已排版的材料行（可能为空）
 */
function dayHookLines(materialDay, stagingEntries = []) {
  const day = String(materialDay ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const out = [];
  try {
    // 材料日卡优先；材料日还没写卡（如 06:30 补跑）→ 最近一张更早的卡当底色
    // （带日期标注，防模型把旧事误当"今天发生的"）。
    const dayCard = memory.cards({ from: day, to: day }).slice(-1)[0]
      ?? memory.cards({ to: day }).slice(-1)[0];
    if (dayCard && typeof dayCard === 'object') {
      const bits = [];
      if (String(dayCard.gist ?? '').trim()) bits.push(String(dayCard.gist).trim());
      if (Array.isArray(dayCard.events) && dayCard.events.length) {
        bits.push(dayCard.events.slice(0, 4).map((e) => String(e).trim()).filter(Boolean).join('；'));
      }
      if (bits.length) {
        const tag = String(dayCard.date ?? '') === day ? '' : `（${String(dayCard.date)}留档）`;
        out.push(`- ${tag}${bits.join('——')}`);
      }
      const entry = String(dayCard.entry ?? '').trim();
      if (entry) out.push(`  · 她自己当天记的：${entry.slice(0, 140)}`);
    }
  } catch { /* 卡读不到不算致命 */ }
  try {
    const lines = (Array.isArray(stagingEntries) ? stagingEntries : [])
      .map((s) => {
        const text = String(s?.text ?? '').trim();
        if (!text) return '';
        const d = new Date(Number(s?.at));
        const hhmm = Number.isFinite(d.getTime())
          ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
          : '';
        return hhmm ? `[${hhmm}] ${text}` : text;
      })
      .filter(Boolean)
      .slice(-8);
    if (lines.length) {
      out.push(`  · 对话里她自己记下的原料（最新在后）：\n${lines.map((t) => `    - ${String(t).slice(0, 60)}`).join('\n')}`);
    }
  } catch { /* staging 读不到不算致命 */ }
  return out;
}

/** 人设接地文本（buildPlanPrompt / buildProseTask 共用；同 cards 模式）。
 *  2026-11-21：person/self 整体丢弃——原 narrative/values 材料行摘除，
 *  接地=roleText + 既有事实。 */
function personaText() {
  const roleText = String(getConfig()?.persona?.roleText || '').trim();
  return [
    roleText ? `人设与对方是谁（性别/称呼以此为准；下面这段人设里的"你"= 日程的主人，即你自己）：\n${roleText}` : '人设：（未设置——称呼与身份只能取自下方既有事实，不得臆造）',
    ...(identityFacts().length ? ['既有事实（身份/称呼以这里为准）：', ...identityFacts()] : [])
  ].filter((s) => String(s ?? '').trim()).join('\n');
}

/** 材料日消息 → 行（两段 prompt 共用；06:30 生成时通常为空，晚安备明天时是今天全天）。 */
function messageLines(data, limit = 20) {
  return (Array.isArray(data?.messages) ? data.messages : [])
    .filter((m) => m && !m.isPoke && String(m.text ?? '').trim())
    .slice(-limit)
    .map((m) => {
      const d = new Date(Number(m.ts));
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      // P01：主人标签走配置（旧存档 senderName='我' 回落“对方”）
      let who;
      if (m.self) who = '我';
      else if (String(m.senderId ?? '') === OWNER_ACTOR_ID) {
        const name = String(m.senderName ?? '').trim();
        who = name && name !== '我' ? name : ownerLabelFor('');
      } else who = m.senderName || m.senderId || '对方';
      return `[${hhmm}] ${who}：${String(m.text).slice(0, 60)}`;
    });
}

/**
 * 日程生成提示词。data = 执行器 buildTaskData 的产物：
 *   { chatKey, day(目标日), materialDay(材料日), now, messages(材料日消息), life(目标日既有计划) }
 */
function buildPlanPrompt(data) {
  // 人物表接地（同 cards 模式）：roleText（config.persona.roleText 是权威默认）
  // + self.narrative/values + identity/address_name 事实。作息形态由人设决定。
  const personaLines = personaText();

  const day = String(data?.day ?? '');
  const seeds = pickSeeds();
  const recent = recentPlanSummaries(day, 3);

  // 材料日消息（06:30 生成时通常为空；晚安备明天时能看到今天全天）。
  const msgLines = messageLines(data, 20);

  // force 重跑场景：当日已有计划作参考材料（正常路径 data.life = null）。
  const existing = data?.life
    ? summarizeItems(Array.isArray(data.life.items) ? data.life.items : [])
    : '';

  // W5 细节化：材料日真事钩子（当日记忆卡 + 暂存笔记）——让日程引用真实事件续写。
  const mDay = String(data?.materialDay || day);
  const hooks = dayHookLines(mDay, data?.staging);

  const system = [
    '你是日程规划者。为"她"（聊天机器人本人）安排今天的一天：5~8 件她真实会做的具体小事。',
    '这份日程是"她自己的日子"，不是给用户看的清单，更不是模板——它会被写进她的记忆与心绪，今天她过的是这一天。',
    '人物表（铁律）：日程的主人「她」= 你自己；对话里的对方是你的主人。身份、作息形态一律以【你（日程的主人）】段里的人设与既有事实为准——是学生就按课与假期的节奏，是上班族就按班，人设怎么写就怎么活，绝不硬套任何固定模板。',
    '规则：',
    '1. 只输出一个 JSON 对象，不要任何解释文字或 markdown 代码块。',
    '2. 一天 5~8 条，time 用 24 小时制 HH:MM 且按时间升序；时间铺开要合理（别全挤在一个小时，也别半夜排活动），贴合她的作息。',
    '3. 每条 activity 都要有细节：在具体时间之外，写清【在哪儿/和什么对象】+【做什么动作】+【动作里的小细节】，让人一读就能想象出画面——例如"把短篇集翻回最后一篇，窝在窗边把结尾重读一遍"，而不是"看书"。"散步""看书""听歌""整理房间"这类没有地点、对象、动作的空话一律不要。',
    '4. 其中 1~3 条带 emotionalLoad——生活里的烦心事与期待是她情绪的真正来源：坏事件（烦人的会、跑腿、等待结果、突发的意外）与值得高兴的小事都可以带；note 是一句第一人称的内心注脚（≤20 字），写她面对这件事时心里怎么想，不要复述事件本身。其余条目不带 emotionalLoad 字段。',
    '5. 用真事做钩子：【材料日的真事】是已经真实发生的事——挑 1~2 件自然织进日程（说好的事落实、没做完的事继续、她提到过的东西去试试），是续写不是复述，更不要被它们塞满。再参考【最近几天的日子】避免重复；【随机灵感】可用可不用、可改可弃，不必全用。今天是普通又具体的一天，不是昨天复制一遍。',
    '6. 日程里不安排"发消息/找他说话"这类主动开口的动作——那是另一套机构的决定；对他的惦记可以出现在 emotionalLoad 的 note 里。',
    '7. date 抄材料给的目标日，不要自己编。',
    `JSON 协议：${PLAN_SCHEMA_TEXT}`
  ].join('\n');

  const user = [
    `【你（日程的主人）】\n${personaLines}`,
    `【今天】${day}${weekdayOf(day) ? ` ${weekdayOf(day)}` : ''}`,
    hooks.length
      ? `【材料日的真事（${mDay} 已真实发生的，挑 1~2 件做钩子续写，不要复述）】\n${hooks.join('\n')}`
      : '',
    recent.length
      ? `【最近几天的日子（别和它们重复）】\n${recent.map((r) => `- ${r.date}：${r.text}`).join('\n')}`
      : '【最近几天的日子】（无留档——按人设安排就好）',
    `【随机灵感（可用可不用，也可只当氛围）】\n${seeds.map((s) => `- ${s}`).join('\n')}`,
    msgLines.length ? `【今天已有的消息】\n${msgLines.join('\n')}` : '【今天已有的消息】（还没有消息）',
    existing ? `【当前已有的今日计划（重排参考）】\n${existing}` : '',
    '请输出今日日程 JSON。'
  ].filter(Boolean).join('\n\n');

  return { system, user };
}

/**
 * life-prose v2 stage 2：items 校验后的专用扩写任务（只 model 模式；fixture 的 prose
 * 由 parsePlan 从同一 life-<day>.json 捕获）。只挑 2–3 件、允许略过/留白、不逐条翻译。
 */
function buildProseTask(data, plan) {
  const day = String(data?.day ?? plan?.date ?? '');
  const items = Array.isArray(plan?.items) ? plan.items : [];
  if (!day || !items.length) return null;
  const personaLines = personaText();
  const recent = recentPlanSummaries(day, 3);
  const msgLines = messageLines(data, 20);
  const mDay = String(data?.materialDay || day);
  const hooks = dayHookLines(mDay, data?.staging);
  const itemLines = items.map((i) => {
    const note = i?.emotionalLoad?.note ? `（情绪：${String(i.emotionalLoad.note).slice(0, 20)}）` : '';
    return `- ${String(i?.time ?? '')} ${String(i?.activity ?? '').trim()}${note}`;
  });
  const system = [
    '你是“她”本人，用第一人称写一段“明天想怎么过”的日记。',
    '这不是清单，不是给用户看的计划，也不是日程表；是她自己心里对明天的念想。',
    '只从下面的明日骨架里挑 2–3 件有画面的事来写，允许略过其余条目，允许留白。',
    '写进身体感受、环境、当时的心情——每件写的事都要落在具体的地方和具体的东西上，有温度、有光影、有手上的触感这类可感的细节；时间要自然融进叙述，不要按时间罗列，不要逐条翻译。',
    '如果【材料日的真事】里有值得惦记的，可以在念想里自然带一句（接着它想明天），但不要复述当天的流水账。',
    '不要出现“日程/安排/条目/计划”这类元话；不要编造骨架和材料之外的大事。',
    '200–350 字，第一人称，像她自己的日记；最后直接给正文，不要引号、不要标题、不要解释。'
  ].join('\n');
  const user = [
    `【你（日程的主人）】\n${personaLines}`,
    `【明天】${day}${weekdayOf(day) ? ` ${weekdayOf(day)}` : ''}`,
    hooks.length ? `【材料日的真事（${mDay}，可在念想里自然带一句，别复述流水账）】\n${hooks.join('\n')}` : '',
    msgLines.length ? `【今天已有的消息（只作底色，不要复述）】\n${msgLines.join('\n')}` : '【今天已有的消息】（还没有消息）',
    `【明天的骨架（只挑 2–3 件写，不要全写）】\n${itemLines.join('\n')}`,
    recent.length ? `【最近几天的日子（别重复）】\n${recent.map((r) => `- ${r.date}：${r.text}`).join('\n')}` : '',
    '请写一段“明天想怎么过”的第一人称散文。'
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/** stage 2 解析：去围栏/整体引号、压缩空行、≤600 硬截断；<80 字视为失败（items-only）。 */
function parseProse(raw) {
  let t = String(raw ?? '').trim();
  if (!t) return '';
  const fence = /```(?:text|markdown)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  t = t.replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').trim();
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length < 80) return '';
  return t.slice(0, 600).trim();
}

// ── 解析与兜底 ────────────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/**
 * 严格解析模型输出 → { plan }。失败抛错 → 执行器走兜底（空 plan，不落库）。
 *   · 剥 markdown 围栏后取首尾大括号之间整体 JSON.parse；
 *   · items 逐条清洗：time 不合 HH:MM → 丢条目；activity 空 → 丢条目；
 *     emotionalLoad 只留 note（截 20 字；2026-11-21 起不存 valence 数值）；note
 *     为空 → 丢载荷（条目保留）；
 *   · 清洗后按 time 升序排、同 time+activity 去重；不足 3 条视为无效计划（抛错）；
 *     超过 8 条截前 8（协议 5~8，模型慷慨不整日作废）；
 *   · date 以调度目标日为准，不信模型自报（同 cards 口径）。
 */
function parsePlan(raw, { day }) {
  let text = String(raw ?? '').trim();
  if (!text) throw new Error('输出为空');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('输出中没有 JSON 对象');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON 不是对象');

  const items = [];
  const seen = new Set();
  for (const it of Array.isArray(parsed.items) ? parsed.items : []) {
    if (!it || typeof it !== 'object') continue;
    const time = String(it.time ?? '').trim();
    const activity = String(it.activity ?? '').trim();
    if (!TIME_RE.test(time) || !activity) continue;   // time 不合格/无内容：丢条目
    const key = `${time}|${activity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { time, activity: activity.slice(0, 50) };
    const load = it.emotionalLoad;
    if (load && typeof load === 'object' && !Array.isArray(load)) {
      const note = String(load.note ?? '').trim().slice(0, 20);
      if (note) item.emotionalLoad = { note };
      // note 空 → 整个载荷丢弃（条目保留）：载荷唯一消费面是 note 文本注入
    }
    items.push(item);
  }

  if (items.length < 3) {
    throw new Error(`有效条目不足（清洗后 ${items.length} 条，<3）——不硬凑假日程`);
  }
  items.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  // fixture 模式可在同一 life-<day>.json 里带 prose；model 模式 stage 1 不产 prose，
  // 由执行器 stage 2 扩写。这里只捕获，不强制。
  const prose = String(parsed.prose ?? '').trim().slice(0, 600);
  const plan = { date: day, items: items.slice(0, 8), ...(prose ? { prose } : {}) };
  return { plan };
}

/** 兜底：空 plan（不产假日程）。不落库——取舍见文件头与 executor.js plan 分支。 */
function emptyPlanFallback(_data, day) {
  return { plan: { date: day, items: [] } };
}

// ── 声明注册 ──────────────────────────────────────────────────────────────

const lifeSpec = {
  id: 'life',
  // 子系统开关沿用统一口径（config.modules.<id>.enabled，W6-② 容器键更名），判定在声明内部
  enabled: () => getConfig().modules?.life?.enabled !== false,
  // 触发（life-prose v2，2026-11-16）：
  //   · 主路径 afterGoodnight：文字晚安 ≥22:00（goodnightFrom），+30min，目标日=明天、
  //     材料日=今天；晚安按钮走 runOnce 显式触发（不受 22:00 限制）。
  //   · 兜底 dailyTime 06:30：当日 plan 缺失即 due（停机/未道晚安不空窗）。
  // maxDaysBack=1：只补当日/明日，不跨天补昨日计划。
  product: 'plan',
  trigger: [
    { kind: 'afterGoodnight', delayMin: 30, dayShift: 1, goodnightFrom: 22, lastMessageFrom: 22 },
    { kind: 'dailyTime', time: '06:30' }
  ],
  needs: ['messages', 'life', 'staging'],
  maxDaysBack: 1,

  buildTask: buildPlanPrompt,
  parse: parsePlan,
  // stage 2（items 校验后专用扩写；fixture 的 prose 由 parsePlan 捕获）
  buildProseTask,
  parseProse,
  fallback: emptyPlanFallback
};

// 启动期注册（import 即登记；执行器同 id 重复注册会抛错，天然防双挂载）
registerSpec(lifeSpec);

// 两种取声明的外形都给全：`lifeSpec` 具名导出 + `specs.life` 索引式导出
// （诊断/门禁自检/外部驱动 runOnce 时任取其一）。
export { lifeSpec };
export const specs = { life: lifeSpec };

// ── §L3：情绪载荷消费（生活→心绪接线，life tick 的 check/run） ────────────
//
// 三原则 2 的下游：日程里 1~3 条带 emotionalLoad 的小事，过点之后被"她经历过了"，
// 条目随即标 consumedAt（幂等：replay/重启绝不重复消费）。
// 2026-11-21 数值丢弃后本接线只剩标记语义：载荷不再拨任何心绪数值轴（原 mind.apply
// 调用摘除），note 文本由今日段渲染直接注入提示词。
// 纪律：
//   · mood.text 不自动改——文本轴归 mind_note 模型自驱。
//   · 只消费今日 plan（plan.date === 本地今日）：昨日遗留不追溯（日子过了就过了）。
//   · life.write 失败 → 下轮心跳幂等重试，绝不静默丢标记。
//   · 全同步实现：与执行器 writeLifePlan 的读改写不交错（单线程事件循环内原子）。

/** 本地日键 YYYY-MM-DD（与 executor.localDayKey / mind.localDayKey 同口径的本地副本）。 */
function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 今日 plan 里"到时未消费"的 emotionalLoad 条目（check/run 共用判定）。
 *   · 今日：plan.date === 本地今日（历史会话/他日 plan 一律不消费）；
 *   · 有载荷：emotionalLoad 为对象（生成面已保证 note 非空——note 空 = 无注入面，
 *     解析时已丢载荷）；
 *   · 到时：条目 time 的本地分钟 ≤ now 的本地分钟（恰到点即算到——与 executor
 *     dailyTime 同一口径）；time 不合格 → 跳过（不消费也不报错）；
 *   · 未消费：无 consumedAt。
 * 返回带索引的引用列表（原位标 consumedAt 用）。
 */
function dueLoadItems(plan, now) {
  if (!plan || typeof plan !== 'object' || String(plan.date ?? '') !== todayKey(now)) return [];
  const items = Array.isArray(plan.items) ? plan.items : [];
  const d = new Date(now);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const out = [];
  items.forEach((item, index) => {
    const load = item?.emotionalLoad;
    if (!load || typeof load !== 'object' || Array.isArray(load)) return;   // 无载荷
    if (item.consumedAt) return;                                            // 已消费（幂等）
    const t = String(item.time ?? '');
    if (!TIME_RE.test(t)) return;                                           // time 不合格
    const [hh, mm] = t.split(':').map(Number);
    if (hh * 60 + mm > nowMin) return;                                      // 还没到点
    out.push({ item, index });
  });
  return out;
}

/**
 * 钟 tick 的 check（§L3）：今日 plan 存在且有"到时未消费"的载荷条目。
 * 只读判定；任何异常按"不跑"处理（同 diary.checkDue 口径——绝不让接线拖垮钟）。
 * 开关沿用声明统一口径（config.modules.life.enabled）。
 */
export function checkDue({ now = Date.now() } = {}) {
  try {
    if (getConfig().modules?.life?.enabled === false) return false;
    return dueLoadItems(lifeStore.read()?.plan, now).length > 0;
  } catch {
    return false;
  }
}

/**
 * 钟 tick 的 run（§L3）：对每个到时未消费条目标 consumedAt，life.write 原子重写一次
 * （tmp+rename）。返回 {due, applied, marked, saved}；异常返回 null（钟的 run 不上抛）。
 */
export function consumeDue({ now = Date.now() } = {}) {
  try {
    const state = lifeStore.read();
    const due = dueLoadItems(state?.plan, now);
    if (!due.length) return { due: 0, applied: 0, marked: 0, saved: false };

    let applied = 0;
    const markedIndexes = new Set();
    for (const { item, index } of due) {
      // 2026-11-21 数值丢弃：这里不再调 mind.apply——载荷不拨任何心绪数值轴，
      // "她经历过了"只剩 consumedAt 标记语义（note 文本走今日段渲染注入）。
      markedIndexes.add(index);
      applied += 1;
    }
    if (!markedIndexes.size) return { due: due.length, applied: 0, marked: 0, saved: false };

    // read() 返回深拷贝，原位标 consumedAt 后整体原子重写一次（所有条目同一时刻落盘）
    for (const index of markedIndexes) state.plan.items[index].consumedAt = now;
    const saved = lifeStore.write(state);
    if (!saved) console.warn('[life] consumedAt 标记写盘失败——下轮心跳重读旧盘重试');
    console.log(`[life] 情绪载荷消费：${markedIndexes.size}/${due.length} 条标已发生（不拨心绪数值轴）`);
    return { due: due.length, applied, marked: markedIndexes.size, saved };
  } catch (err) {
    console.warn('[life] 情绪载荷消费失败：', err?.message ?? err);
    return null;
  }
}
