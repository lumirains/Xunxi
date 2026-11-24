// 声明模块 · 私密日记（步骤⑥ / T6.2）—— ReflectionSpec 'diary'（自驱声明）。
//
// 身份（v3 §4 子系统登记表）：日记子系统（现役名 diary）= person/diary.js（存储，T6.1）+ 本声明模块
// （灵魂）+ 工具（Q15 起在 src/tools.js）+ tick（Q15 起在 orchestrator.startClock）。
// 本文件是从旧日记插件（原 plugins/ 下壳件）抽出的"灵魂"，旧实现已整段删除、
// 不留双路径（坑 #8 防双发）：晚安成对判定（isGoodnight/lastGoodbyeAt）、
// 写闸门（writeGate/maxPerDay）、VOICE_RULES 模板、buildImpulsePrompt 素材拼装、
// 解析（splitTitleAndBody/cleanEntry/looksTruncated）、截断保护。
//
// 取舍（v3 T6.2 任务口径："若与 executor 的统一形态冲突，允许 diary 用 executor 的
// 取数/落盘但保留自己的调用参数，在代码注释说明取舍"）：
//   · 统一形态冲突点：① 触发——日记的"晚安后 grace"是跨会话的好感时刻，词表归声明
//     私有（枢纽不持有"晚安"词表；P2 起 cards 的晚安写卡也进统一触发，但经共享判定
//     函数 lastGoodbyeAt 走、词表仍只此一份——night-plan §P2，diary 自己的 tick 驱动不变）；
//     ② 产出——日记有自己的模型参数（专用 model 覆盖、按长度档分 maxTokens、thinking off、
//     tag 'diary-impulse'）与 sendEnabled，且产物是日记条目不是记忆卡（normalizeCard/
//     writeCard 那套不适用）；③ 兜底——日记没有兜底（半句话绝不写进本子），解析失败/
//     截断一律"这轮不写"。
//   · 因此本声明 **selfDriven: true**：登记进执行器注册表（"登记为 ReflectionSpec"）、
//     共享其取数口径（needs=['messages']，经 kernel/store，与 fulfillNeeds 同源）与落盘
//     通道（person/diary.append 前额叶 API），但**不经统一 runDue/runOnce**（执行器
//     dueTargets 跳过 selfDriven）；驱动由 orchestrator.startClock 注册的 `diary` tick
//     完成（checkDue → runDiary；writeGate 自己从 store 找晚安，不依赖 after-response）。
//
// 纪律：本模块不写任何 person 状态以外的数据（写回只走 person/diary.append）、
// 不 import 身体模块；模型调用动态 import llm.js（import 期零网络、零模型调用）。

import { getConfig, ownerLabelFor } from '../../config.js';
import { OWNER_ACTOR_ID } from '../../person/contracts.js';
import { PERSONAS } from '../../personas.js';
import { ChatStore } from '../../kernel/store.js';
import { registerSpec } from './executor.js';
import * as diaryStore from '../../person/diary.js';
import * as lifeStore from '../../person/life.js';

// ── 设置（与插件壳 api.config() 同一份数据的两个视图）────────────────────
// 插件壳时代的 settings() = manifest.settings ⊕ config.modules[注册名]（moduleManager 合并）；
// 能力层不读 manifest，这里用 DEFAULTS 镜像 ⊕ config.diary。
// 镜像值与旧日记插件清单的 settings **逐键一致**（评审复核轮纠偏：
// impulseEnabled 原误抄旧插件 in-code DEFAULTS 的 false，清单默认 true——首装无配置时
// "她自己想写"的默认态会静默翻转，已改回 true）。改默认值两处同改。
const DEFAULTS = {
  enabled: true,
  // 2026-10-31：从"一天最多几篇"改成"一晚一篇"——见 bedtimeOnly。
  maxPerDay: 1,
  minGapMinutes: 60,
  nothingNewMinutes: 120,
  impulseEnabled: true,
  impulseIntervalMinutes: 10,
  activeFrom: '20:00',
  activeTo: '04:00',
  maxEntryChars: 500,
  // ── 晚安后写（2026-10-31）─────────────────────────────────────────────
  bedtimeOnly: true,          // true = 只在"今天互道过晚安"之后写；false = 旧的随时可写
  bedtimeWords: '晚安,睡了,先睡,睡啦,好梦,困了',
  bedtimeGraceMinutes: 15,    // 互道晚安后再等几分钟：让告别那口气过去，也让他可能补一句
  // ── 23:30 兜底（2026-11-03）──────────────────────────────────────────
  fallbackAt: '23:30',
  minMessagesForDiary: 10,    // 素材门槛：今天至少这么多条消息，才值得动笔
  model: ''
};

function settings() {
  // Q15：配置迁到 config.diary（旧容器键由 config.js RENAMED_PATHS 一次性迁移，
  // 迁移机制已覆盖全部落盘形态，不再保留旧键读取路径）。
  const raw = getConfig()?.diary ?? {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');
function dayKeyOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function stampOf(ms) {
  const d = new Date(ms);
  return `${dayKeyOf(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function parseTimeOfDay(text, fallback) {
  const m = String(text || '').trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
  if (!m) return fallback;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
  return h * 60 + min;
}
/** 活跃时段判断，支持跨零点（20:00→04:00）。 */
function inActiveWindow(now = new Date()) {
  const s = settings();
  const from = parseTimeOfDay(s.activeFrom, 20 * 60);
  const to = parseTimeOfDay(s.activeTo, 4 * 60);
  const cur = now.getHours() * 60 + now.getMinutes();
  return from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to);
}

// ── 取数：消息经 kernel/store（与执行器 fulfillNeeds('messages') 同源）────────
// store 实例由插件壳经 before-context 钩子注入（运行期主路径）；未注入时用**只读副本**
// ChatStore 兜底（冷启动还没有任何会话时 tick 也要能判"最近没什么人说话"）——
// 能力层不直读消息主存储（storage-v2 起 = xunxi.db messages 表），读语义全部复用 store 自己的 loadChat。
let fallbackStoreInstance = null;
function storeOf(store) {
  if (store && typeof store.listChats === 'function' && typeof store.recent === 'function') return store;
  if (!fallbackStoreInstance) fallbackStoreInstance = new ChatStore();   // 只读用途，永不写
  return fallbackStoreInstance;
}

/** 取 [since, now] 内全部会话的消息（结构化，返回最近 max 条）。 */
function collectMessages({ since, max = 200, store = null } = {}) {
  const st = storeOf(store);
  const out = [];
  for (const key of st.listChats()) {
    // limit 取大值 = 旧实现"整文件读入再按 since 过滤"的等价口径（#trim 只在追加时生效，
    // recent 只是从内存全量切片，读路径无截断损失）
    for (const m of st.recent(key, { limit: 20000 })) {
      const ts = Number(m?.ts) || 0;
      if (!ts || ts < since) continue;
      out.push({
        ts,
        self: m?.self === true,
        text: String(m?.text ?? ''),
        chatKey: key,
        senderName: String(m?.senderName || ''),
        senderId: String(m?.senderId || '')
      });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-Math.max(1, max));
}

// chatKey 现恒为 'main'（旧 private:/group: 前缀档随群聊摘除一并消亡），
// 函数保留并原样返回键值——材料行的「[键] 说话人：内容」格式保持稳定。
function chatLabel(key) {
  return key;
}

/** 取 [since, now] 内的消息，格式化成一行一条（给提示词用）。 */
function recentMessages({ since, max, store = null }) {
  const selfName = (() => { try { return getConfig()?.persona?.botName || '我'; } catch { return '我'; } })();
  return collectMessages({ since, max, store }).map((m) => {
    // P01：主人标签走配置（旧存档 senderName='我' 回落“对方”），别把对方写成她自己。
    let who;
    if (m.self) who = selfName;
    else if (String(m.senderId ?? '') === OWNER_ACTOR_ID) {
      const name = String(m.senderName ?? '').trim();
      who = name && name !== '我' ? name : ownerLabelFor('');
    } else who = m.senderName || m.senderId || '某人';
    return `[${chatLabel(m.chatKey)}] ${who}：${String(m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
  });
}

/**
 * 她今天做过什么 —— 读 life 的日程（前额叶 person/life API，T6.3 迁 person/life.json）。
 * 2026-11-03 起的规矩不变：日记语料里 20/20 篇都在写"对方说了什么"，0 篇写自己的事，
 * 根因是素材——这里只取今天的 plan.events。读不到、或日期对不上（昨天那份）就当没有，
 * 绝不把昨天的日程织进今天的日记。
 */
export function readLifeToday(now = Date.now()) {
  try {
    // life-prose v2：按日期取 plan（plansByDay 权威；旧 plan/plans 兼容）。
    // 优先 prose（她自己的“今天”正文）；无 prose 回退 items 摘要；旧日程 events 最后兜底。
    const plan = lifeStore.planForDay(dayKeyOf(now));
    if (!plan || typeof plan !== 'object') return { mood: '', events: [] };
    const mood = String(plan.mood || '').trim().slice(0, 60);
    const prose = String(plan.prose || '').trim();
    if (prose) return { mood, events: [prose.slice(0, 300)] };
    const items = Array.isArray(plan.items) ? plan.items : [];
    if (items.length) {
      const events = items
        .map((i) => `${String(i?.time || '').trim()} ${String(i?.activity || '').trim()}`.trim())
        .filter(Boolean)
        .slice(-10);
      if (events.length) return { mood, events };
    }
    const events = (Array.isArray(plan.events) ? plan.events : [])
      .map((e) => {
        const t = String(e?.time || '').trim();
        const what = String(e?.what || '').trim();
        const detail = String(e?.detail || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        return `${t} ${what}${detail ? `：${detail}` : ''}`.trim();
      })
      .filter(Boolean)
      .slice(-10);
    return { mood, events };
  } catch { return { mood: '', events: [] }; }
}

/* ── 互道晚安检测（2026-10-31，原样搬入）─────────────────────────────────
 * 用户要的时机：**晚上两个人都说过晚安之后**写一篇，白天不写。
 * 判定刻意保守，宁可漏写也不要在半夜三点把人叫起来写日记：
 *   · 短句里的告别词才算（长段落里提到「晚安」不算 —— 实测 10-28 23:22 那条
 *     一百多字的自述里就有这个词，按 includes 判会误触发）
 *   · 她的晚安和对方的晚安相隔不超过 3 小时（同一次告别）
 *   · 较晚那条在最近 12 小时内（昨天的告别不算今天）
 */
const GOODNIGHT_PAIR_MS = 3 * 60 * 60 * 1000;
const GOODNIGHT_WINDOW_MS = 12 * 60 * 60 * 1000;

function bedtimeWords() {
  return String(settings().bedtimeWords || '')
    .split(/[,，、\s]+/).map((w) => w.trim()).filter(Boolean);
}

/** 晚安判定（插件壳 after-response 钩子也用——判定只此一份，不留双路径）。 */
function isGoodnight(text) {
  const t = String(text ?? '').replace(/\s+/g, '');
  if (!t) return false;
  const hit = bedtimeWords().find((w) => t.includes(w));
  if (!hit) return false;
  return t.length <= 24 || t.endsWith(hit) || t.startsWith(hit);
}

/** 最近一次"互道晚安"的时刻；0 = 没有。 */
function lastGoodbyeAt({ now = Date.now(), windowMs = GOODNIGHT_WINDOW_MS, store = null } = {}) {
  const msgs = collectMessages({ since: now - windowMs, max: 400, store });
  let her = null;
  let them = null;
  for (const m of msgs) {
    if (m.ts > now) continue;             // 未来时间戳（时钟回拨/测试）不算
    if (!isGoodnight(m.text)) continue;
    if (m.self) her = m; else them = m;
  }
  if (!her || !them) return 0;
  if (Math.abs(her.ts - them.ts) > GOODNIGHT_PAIR_MS) return 0;
  return Math.max(her.ts, them.ts);
}

// ── 写闸门 ────────────────────────────────────────────────────────────────
/** "23:30" → 1410（分钟）；写法不对就返回 null。 */
function hmToMinutes(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// 上一次输出被截断的时刻（避免高频重试烧 token——30 分钟冷却见 writeGate）
let lastTruncatedAt = 0;
let running = false;

/**
 * 该不该写：所有"不花 token 就能判掉"的规则集中在这里。
 * force（night-plan-life §L1 控制台「晚安整理」按钮）绕行口径：
 *   · 放行的是**时机类**闸门——自己写开关（按钮不是"她自己想写"，是所有者点名）、
 *     活跃时段（按钮白天也能点）、截断冷却/晚安互道/grace/间隔（见下方 force 分支）；
 *     素材量门槛（minMessagesForDiary/无消息）不归本闸门，considerInner 照判——
 *     素材真不够时按钮照样如实回"素材太少"，不硬凑半篇。
 *   · **不放开的是判重**（maxPerDay 一晚一篇）：那是幂等口径不是时机闸门——
 *     重复点击必须得到「今日已整理」而不是第二篇。
 *   · 总开关 enabled===false 仍拦：日记本整个合上时按钮回同样的话，不偷偷翻本子
 *    （所有者要在关掉日记功能时用按钮，先重新打开功能——口径诚实优先）。
 * 定时链路（checkDue/tick）不传 force，逐条口径原样。
 */
function writeGate({ now = Date.now(), store = null, force = false } = {}) {
  const s = settings();
  if (s.enabled === false) return { ok: false, why: '日记本是合上的' };
  if (!force && s.impulseEnabled !== true) return { ok: false, why: '自己写是关的' };
  if (!force && !inActiveWindow(new Date(now))) return { ok: false, why: `不在活跃时段（${s.activeFrom}~${s.activeTo}）` };

  const all = diaryStore.entries();
  const max = Math.max(1, Number(s.maxPerDay) || 1);
  const today = all.filter((e) => (e.time || '').startsWith(dayKeyOf(now)));
  if (today.length >= max) {
    // force 下判重命中给出按钮口径文案（路由层原样透传，前端 toast 直接显示）
    return { ok: false, why: force ? '今日已整理' : `今天已经写了 ${today.length} 条（上限 ${max}）` };
  }

  if (force) {
    // 按钮路径到此已过总开关与判重；剩下的全是"时机"类闸门（截断冷却/晚安互道/
    // grace/间隔）——按钮=所有者此刻点名要写，全部放行。素材窗口取 23:30 兜底同款：
    // 今天 0 点起（goodbyeAt=0 + fallback=true → considerInner 的 since 分支按
    // "这一整天"取材，一晚一篇的判重已在上面把过关）。
    return { ok: true, goodbyeAt: 0, fallback: true, all };
  }

  const lastAt = all.length ? (all[all.length - 1].at || 0) : 0;
  // 上一次输出被截断 → 隔 30 分钟再试，别每 10 分钟烧一次 token
  if (lastTruncatedAt && now - lastTruncatedAt < 30 * 60000) {
    return { ok: false, why: '上次输出被截断，等一会儿再试' };
  }

  if (s.bedtimeOnly === true) {
    const gAt = lastGoodbyeAt({ now, store });
    if (!gAt) {
      // 23:30 兜底：今晚没互道晚安（或者根本没聊到那句），也不能整晚空着。
      // 这里只放行"到点 + 今天没写过"，素材够不够由 considerInner 再判。
      const fb = hmToMinutes(s.fallbackAt);
      const d = new Date(now);
      const nowMin = d.getHours() * 60 + d.getMinutes();
      if (fb != null && nowMin >= fb) return { ok: true, goodbyeAt: 0, fallback: true, all };
      return { ok: false, why: `今天还没互道晚安（${s.fallbackAt || '23:30'} 之后会兜底）` };
    }
    // 这次告别已经写过了：上一条日记就写在这之后
    if (lastAt && lastAt >= gAt) return { ok: false, why: '这次晚安已经写过了' };
    const grace = Math.max(0, Number(s.bedtimeGraceMinutes) || 0) * 60000;
    if (now - gAt < grace) {
      const min = Math.max(1, Math.round((now - gAt) / 60000));
      return { ok: false, why: `刚道完晚安 ${min} 分钟，再等等` };
    }
    return { ok: true, goodbyeAt: gAt, all };
  }

  const gapMs = Math.max(0, Number(s.minGapMinutes) || 0) * 60000;
  if (lastAt && now - lastAt < gapMs) {
    return { ok: false, why: `距上一条才 ${Math.round((now - lastAt) / 60000)} 分钟（要求间隔 ${s.minGapMinutes} 分钟）` };
  }
  return { ok: true, goodbyeAt: 0, all };
}

/**
 * Q15 迁移（原日记插件 tick 收编）：钟的 check 只问“现在该不该起念头”。
 * 只读判定（writeGate 内部无写盘、无模型调用）；任何异常按“不跑”处理，
 * 绝不让日记判定拖垮聊天主链路。
 * @returns {boolean}
 */
export function checkDue({ store = null, now = Date.now() } = {}) {
  try {
    return writeGate({ now, store }).ok === true;
  } catch {
    return false;
  }
}

// ── 人设与模板 ────────────────────────────────────────────────────────────
function roleText() {
  try {
    // 人设来源（T6.2 任务口径）：config.persona.roleText。
    //（原 person/self.narrative 优先链已随 2026-11-21 self 面整体丢弃移除——
    //  narrative 恒为种子空串，实际行为一直走 roleText 兜底，零行为变化。）
    const cfg = getConfig();
    const role = String(cfg?.persona?.roleText || '').trim();
    if (role) return role;
    // 再兜：persona.roleText 为空时按 botName 找一个内置模板。
    // 注意模板对象的字段是 text 不是 roleText（原先写错，这条兜底永远取不到值）。
    const key = String(cfg?.persona?.botName || '').trim();
    if (key && PERSONAS?.[key]?.text) return String(PERSONAS[key].text);
  } catch { /* 取不到人设不算致命 */ }
  return '';
}

/**
 * 写日记的口气规矩。
 *
 * 2026-10-31 重写。旧版 20 条日记实测出的问题（全部能在语料里数出来）：
 *   · 「不是 A，是 B」37 次 / 20 篇 —— 旧规则里"写具体的东西"+"可以带一点当时的
 *     感觉、当时没说出口的话"合起来，把模型逼成了"抠字眼 + 顿悟"的套路；
 *   · 20 / 20 篇都在引用对方原话，0 篇写自己的事 —— 输入只有聊天记录，没人告诉它
 *     "聊天只是今天的一部分"；
 *   · 「好像」15 次、固定动作模板（盯着/长出来/很轻/手指没停）反复出现；
 *   · 每篇结尾都要拔一句。
 * 现在的写法：**先给事，再给禁令，再给两条示范**。禁令只列真正会犯的那几条，
 * 不写"禁止排比"这种清单式禁令（那本身就在教排比）。
 */
const VOICE_RULES = `写日记的规矩（她自己的规矩，不是任务清单）：
- 先写今天**发生过什么**：做了什么、去了哪儿、手上在忙什么、身上什么感觉、几点。
  聊天只是今天的一部分，不是全部 —— 不要整篇围着对方说过的话转。
- 有想法就写，但想法要贴着事走：「他今晚没说晚安，发了个句号」比「我意识到关系是流动的」像人。
- 句子短一点。该断就断，可以分成两三段，一段一两句。
- 允许写一半、跑题、突然想起别的事、写到最后不想写了。
- 不美化，不总结，不给今天下定义，不写"这一天让我明白"。

**下面任何一条出现，这条日记就算写坏了**：
- 「不是……，是……」先否定再纠正的句式（一次都不行）。
- 挑出对方说过的某一个字或词反复咂摸（"他说的是「就」，不是「才」"）。
- 一段里出现两个以上「好像」。
- 结尾抖一句金句、或者拔高一句。
- 用破折号——停顿。
- 三句以上同一个结构的排比。

**两条示范**（只是让你看清"具体"到什么程度，别照抄，也别学句子结构）：
· 短的：今天洗头，洗发水挤到第三次才够。忘了买。明天下班要是还记得就买，不记得就算了。
· 长的：他下午说在开会，让我别等。我把昨天的汤热了，喝完发现咸，又添了半碗饭。八点多他问我干嘛呢，我说收拾厨房。厨房其实早收完了，我坐在那儿看冰箱上的磁贴。`;

/** 两种写法，随机。2026-10-31 起长的那种更常见（一晚上一篇，短的容易像流水账）。 */
export function pickMode() {
  return Math.random() < 0.7 ? 'long' : 'short';
}

function lengthInstruction(mode, name) {
  if (mode === 'long') {
    return `这次写**长一点**：三到八句，可以分成两三段。像晚上躺下来，把今天那件事慢慢想一遍。
只写你记得住的部分，不要求完整，也不用交代前因后果。`;
  }
  return `这次写**短的**：一到三句就收住，一段，像随手丢下的一句话。
别人看不懂也没关系，本子只有${name}自己会翻。`;
}

function buildImpulsePrompt({ transcript, prior, name, mode = 'short', maxChars = 250, life = { mood: '', events: [] } }) {
  const head = `你是「${name}」。今天是 ${dayKeyOf(Date.now())}，现在是 ${stampOf(Date.now()).slice(11)}。
你有一个自己的日记本，只有你能写，主人想看的时候会自己来翻。`;
  // 人设只取前 600 字：全文注入会把"聊天时的文学人格"整体搬进日记（旧版就是这样），
  // 而日记需要的是"这个人是谁"，不是"她怎么说话"。
  const role = roleText();
  const persona = role ? `\n【你是谁】\n${role.slice(0, 600)}\n` : '';
  // 防重复只给摘要，不给全文 —— 旧版把最近 6 篇全文塞回去，等于每次都在给模型 6 篇范文，
  // 于是"不是…是…"越写越多（#1 两次 → #13/#17 四次）。
  const week = prior.length
    ? `\n【最近写过的（别写重样的，也别学它们的写法）】\n${prior.map((e) => `· ${String(e.time || '').slice(5)}　${e.title ? `《${e.title}》` : String(e.content).slice(0, 24)}`).join('\n')}\n`
    : '\n【你还没写过什么。】\n';
  const chat = transcript.length
    ? `\n【今天聊过的（素材之一，不是题目）】\n${transcript.join('\n')}\n`
    : '';
  // 她自己的日程：补"只写对方、不写自己"的短板。只是原料，不是要她照着记流水账。
  const herDay = (life.events?.length || life.mood)
    ? `\n【你今天做过的事（你自己的日程，不是题目）】${life.mood ? `\n今天的感觉：${life.mood}` : ''}\n`
      + `${(life.events || []).map((x) => `· ${x}`).join('\n')}\n`
    : '';
  const ask = `
${VOICE_RULES}

${lengthInstruction(mode, name)}
（参考量：${maxChars} 字上下，多一点少一点都无所谓，不是硬线。）

现在自己做决定：
· 今天要有那么一件事、一句话、一个念头值得记下来 —— 就写下来。
· 没有，或者刚想写的那点感觉已经过去了 —— 就什么都不写。这很正常，一晚上不写不会怎么样。

要写，就按这个格式输出：
第一行：# 标题（6~14 个字，像给这天取个名字，例：# 雨天的画册；不要写"日记""随笔"这种空词）
空一行，再写正文（不要引号、不要"日记："、不要解释你写了什么）；
不想写，就只输出四个字：不想写了`;
  return `${head}\n${persona}${week}${herDay}${chat}${ask}`;
}

// ── 解析与截断保护（原样搬入）──────────────────────────────────────────────
function cleanEntry(text) {
  let s = String(text ?? '').trim();
  s = s.replace(/^```[a-zA-Z]*\s*/u, '').replace(/```\s*$/u, '').trim();
  s = s.replace(/^(日记|想写|写)\s*[:：]\s*/u, '').trim();
  // 首尾引号一律剥掉：旧版只处理"成对"的引号，实测 #2 结尾留了一个孤零零的 "
  s = s.replace(/^["“'「『]+/u, '').replace(/["”'」』]+$/u, '').trim();
  // ⚠️ 只压 3 行以上的连续空行，**单换行是分段，必须保留**。
  //    旧版 replace(/\s*\n+\s*/g, ' ') 把分段压成一整段，读起来像散文而不像日记。
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 把模型输出拆成「标题 + 正文」。
 *
 * 约定：第一行 `# 标题`，空一行，然后正文。
 * 只认第一行 —— 正文里的 # 一律不动，避免模型在正文里写小标题被误切。
 * 模型没写标题就返回空串：**绝不拿正文第一句硬凑**（那会变成"标题=第一句话"的模板）。
 */
function splitTitleAndBody(text) {
  const s = String(text ?? '').replace(/\r/g, '').trim();
  if (!s) return { title: '', body: '' };
  const lines = s.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  const first = lines[i] || '';
  const m = first.match(/^#{1,4}\s*(.+)$/)
    || first.match(/^【(.{1,24})】$/)
    || first.match(/^标题\s*[:：]\s*(.+)$/);
  if (!m) return { title: '', body: s };
  const title = m[1].replace(/^[「『"“]+/u, '').replace(/[」』"”]+$/u, '').trim().slice(0, 24);
  i += 1;
  while (i < lines.length && !lines[i].trim()) i += 1;
  return { title, body: lines.slice(i).join('\n').trim() };
}

/** 结尾必须是句末标点：否则说明模型被 max_tokens 掐断（实测 #9 断在「不是」）。 */
const SENTENCE_END = /[。！？…”』」）)~～.!?]$/;
function looksTruncated(text) {
  const s = String(text ?? '').trim();
  if (!s) return true;
  if (SENTENCE_END.test(s)) return false;
  // 极短的可以不讲究（"算了"这种）
  return s.length > 12;
}
function isSkip(text) {
  const s = String(text ?? '').replace(/[\s。.！!，,、]/g, '');
  if (!s) return true;
  if (s.length <= 12 && /不想写|没什么想写|没有想写|不写了|算了|无事|skip|nothing/i.test(s)) return true;
  return false;
}

// ── 模型调用（保留日记自己的参数——T6.2 取舍的一半）────────────────────────
async function callModel(messages, { maxTokens = 400 } = {}) {
  const s = settings();
  const { chatCompletionFully, resolveApiKey } = await import('../../llm.js');
  let overrides = null;
  const model = String(s.model || '').trim();
  if (model) {
    const cfg = getConfig() || {};
    // ⚠️ overrides 一给就整体替代 effectiveApi()：必须是一份完整的 api 配置，
    //    只传 { timeoutMs } 会让 baseUrl 变 undefined → fetch 报 "Invalid URL"。
    overrides = { ...(cfg.api || {}), apiKey: resolveApiKey(cfg), model, timeoutMs: 120000 };
  }
  // chatCompletionFully：被 max_tokens 掐断时自动加预算重试，并把 truncated 交回来。
  // 这里是最需要它的地方之一 —— 旧版 #9 那条日记结尾断在「不是」，而 finish_reason=length
  // 在旧的 chatCompletion 里只是一个普通成功的响应，谁也看不出来。
  return chatCompletionFully({
    messages,
    tools: null,
    temperature: null,
    ...(overrides ? { overrides } : {}),
    maxTokens,
    skillContext: { thinkingMode: 'off' },
    tag: 'diary-impulse'
  }, { log: (m) => console.warn('[reflection/diary]', m) });
}

/**
 * 起一次念头：由她自己决定写还是不写（灵魂本体；插件壳 tick 与 provider 都走这里）。
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] 晚安整理按钮口径（night-plan-life §L1）：所有者
 *   主动要求"现在写"→ 绕过时机类闸门（自己写开关/活跃时段/截断冷却/晚安互道——
 *   按钮语义=点名写日记，无晚安也可写）；判重（一晚一篇）与总开关 enabled 不绕，
 *   判重命中回 skipped:'今日已整理'（幂等口径：重复点击提示而非报错/重复写）。
 *   定时 tick 不传 force，原口径不变。绕行只此一个显式参数，不设旁路函数。
 * @returns {Promise<{wrote:boolean, reason?:string, entry?:object, skipped?:string}>}
 */
export async function runDiary({ store = null, now = Date.now(), source = 'timer', force = false } = {}) {
  const s = settings();
  if (running) return { wrote: false, skipped: '上一次还在写' };
  // 总开关对 force 不豁免（日记本整个合上 = 按钮也回"日记本是合上的"，见 writeGate 注释）；
  // "自己写是关的"（impulseEnabled）只约束她自己起念头，按钮是所有者点名 → force 放行。
  if (s.enabled === false) return { wrote: false, skipped: '日记本是合上的' };
  if (!force && s.impulseEnabled !== true) return { wrote: false, skipped: '自己写是关的' };
  running = true;
  try {
    return await considerInner({ store, now, source, force });
  } finally {
    running = false;
  }
}

async function considerInner({ store = null, now = Date.now(), source = 'timer', force = false } = {}) {
  const s = settings();
  const gate = writeGate({ now, store, force });
  if (!gate.ok) return { wrote: false, skipped: gate.why };
  const all = gate.all;

  // 素材窗口：
  //   · 晚安模式：这次告别往前 8 小时 —— 也就是"今天这一整段"，不是"最近两小时"
  //     （用户要的是"根据今天聊天的内容写"）
  //   · 23:30 兜底：从今天 0 点算起（这一天到现在为止的全部）
  //   · 旧的随时模式：仍按 nothingNewMinutes
  const since = gate.fallback
    ? new Date(now).setHours(0, 0, 0, 0)
    : (gate.goodbyeAt
      ? gate.goodbyeAt - 8 * 60 * 60 * 1000
      : now - Math.max(10, Number(s.nothingNewMinutes) || 120) * 60000);
  const transcript = recentMessages({ since, max: (gate.goodbyeAt || gate.fallback) ? 140 : 40, store });
  if (!transcript.length) return { wrote: false, skipped: '最近没什么人说话' };

  // 素材门槛：一两条消息就动笔，写出来只能是空话。兜底和晚安模式都适用。
  const minMsgs = Math.max(1, Number(s.minMessagesForDiary) || 10);
  if ((gate.goodbyeAt || gate.fallback) && transcript.length < minMsgs) {
    return { wrote: false, skipped: `今天素材太少（${transcript.length} < ${minMsgs} 条）` };
  }

  const life = readLifeToday(now);

  // 只给最近 3 条摘要做"别写重样"——旧版塞 6 篇全文，等于每轮递 6 篇范文给模型模仿
  const prior = all.slice(-3);
  const mode = pickMode();
  const maxChars = Math.max(20, Number(s.maxEntryChars) || 250);
  let name = '我';
  try { name = getConfig()?.persona?.botName || '我'; } catch { /* 用默认 */ }

  const task = {
    system: '你就是这个角色本人，正在决定要不要在自己的日记本上写点什么。不要解释，不要客套。',
    user: buildImpulsePrompt({ transcript, prior, name, mode, maxChars, life })
  };

  const res = await callModel([
    { role: 'system', content: task.system },
    { role: 'user', content: task.user }
  ], { maxTokens: mode === 'long' ? 1200 : 400 });

  const raw = String(res?.message?.content ?? '');
  // 先看协议层的事实：finish_reason=length 就是被截断了，不用再从结尾标点去猜
  if (res?.truncated) {
    lastTruncatedAt = now;
    console.warn(`[reflection/diary] 模型的输出被 max_tokens 截断（finish_reason=${res?.finishReason}），这轮不写，稍后再试`);
    return { wrote: false, skipped: '模型输出被截断（finish_reason）' };
  }
  if (isSkip(raw)) {
    return { wrote: false, skipped: '她自己决定不写', raw: raw.trim().slice(0, 60) };
  }
  const { title, body } = splitTitleAndBody(raw);
  const content = cleanEntry(body);
  if (!content) return { wrote: false, skipped: '模型返回空内容' };
  // 只写了标题、正文是「不想写了」这种情况：按"不写"处理，别把一句拒绝写进本子。
  if (isSkip(content)) return { wrote: false, skipped: '她自己决定不写' };
  if (looksTruncated(content)) {
    // 半句话绝不写进本子（用户原话："日记最怕半句话"）。这一轮放弃；
    // 30 分钟冷却后 tick 会再试一次，不会每 10 分钟烧一次 token。
    lastTruncatedAt = now;
    console.warn(`[reflection/diary] 这次像是被截断了（结尾「${content.slice(-8)}」），没写`);
    return { wrote: false, skipped: '模型输出被截断', raw: content.slice(-40) };
  }

  // 上限是软目标（用户说的：可适当超出）。给到 2 倍才管 —— 那时候请她收一次，
  // 收完不管多少都照写，绝不截断（日记最怕半句话）。
  const runaway = maxChars * 2;
  let finalContent = content;
  if (content.length > runaway) {
    console.log(`[reflection/diary] 这次写太多了（${content.length} 字 > ${runaway}），请她收一次`);
    const again = await callModel([
      { role: 'system', content: '你就是这个角色本人。把刚才那段收短，只允许更短，不许加内容。' },
      { role: 'user', content: `这是你刚写下的：\n${content}\n\n太长了。用 ${maxChars} 字左右重写，保持原来的意思和语气，仍然只输出正文本身。` }
    ], { maxTokens: 600 });
    const shortened = cleanEntry(String(again?.message?.content ?? ''));
    // 收短那次若也被截断，宁可保留原来那条完整的，不要用半截替换
    if (shortened && !isSkip(shortened) && again?.truncated !== true) finalContent = shortened;
  }

  try {
    // 落盘：前额叶 API（person/diary.append）——生成产物唯一去处的另一半取舍（T6.2）。
    const entry = diaryStore.append({ content: finalContent, title, mood: '', at: now, source, mode });
    return { wrote: true, entry };
  } catch (error) {
    return { wrote: false, skipped: String(error?.message ?? error) };
  }
}

// ── ReflectionSpec 登记与诊断出口 ──────────────────────────────────────────
const diarySpec = {
  id: 'diary',
  // 自驱声明：执行器 dueTargets/runOnce 跳过（触发词表与模型参数私有，见文件头取舍说明），
  // 由插件壳的 kernel/clock tick 驱动 runDiary。登记在此仅为进入统一注册表/诊断视图。
  selfDriven: true,
  // 开关迁到 config.diary.enabled（Q15 收编；旧 skills 键由 config.js 迁移），判定在声明内部
  enabled: () => getConfig()?.diary?.enabled !== false,
  // trigger=晚安后 grace 15 分钟（bedtimeGraceMinutes 默认值；实际判定在 lastGoodbyeAt+writeGate）
  trigger: [{ kind: 'afterGoodnight', delayMin: 15 }],
  needs: ['messages'],

  /** 任务模板：VOICE_RULES + 素材拼装（buildImpulsePrompt 的声明形态）。 */
  buildTask(data) {
    return {
      system: '你就是这个角色本人，正在决定要不要在自己的日记本上写点什么。不要解释，不要客套。',
      user: buildImpulsePrompt({
        transcript: Array.isArray(data?.transcript) ? data.transcript : [],
        prior: Array.isArray(data?.prior) ? data.prior : [],
        name: String(data?.name ?? '我'),
        mode: String(data?.mode ?? 'short'),
        maxChars: Number(data?.maxChars) || 250,
        life: data?.life && typeof data.life === 'object' ? data.life : { mood: '', events: [] }
      })
    };
  },

  /**
   * 解析：splitTitleAndBody + cleanEntry + isSkip + looksTruncated。
   * 返回 {entry:{title,content}|null, skip:bool, truncated:bool} —— 与执行器统一形态的
   * {card, episodes} 不同（自驱声明的私有产出形状，不经 normalizeCard）。
   */
  parse(raw) {
    if (isSkip(String(raw ?? ''))) return { entry: null, skip: true, truncated: false };
    const { title, body } = splitTitleAndBody(raw);
    const content = cleanEntry(body);
    if (!content || isSkip(content)) return { entry: null, skip: true, truncated: false };
    if (looksTruncated(content)) return { entry: null, skip: false, truncated: true, tail: content.slice(-40) };
    return { entry: { title, content }, skip: false, truncated: false };
  },

  /** 日记没有兜底：解析失败/截断一律"这轮不写"（半句话绝不写进本子）。 */
  fallback() {
    return null;
  }
};

// 启动期注册（import 即登记；执行器同 id 重复注册会抛错，天然防双挂载）
registerSpec(diarySpec);

// 两种取声明的外形都给全（与 cards.js 同惯例）：`diarySpec` 具名导出 + `specs.diary` 索引式
export { diarySpec };
export const specs = { diary: diarySpec };

// 插件壳用的两个判定（活跃时段 / 晚安短句）+ P2 起执行器 cards 触发用的互道晚安时刻
// （lastGoodbyeAt：词表+成对判定只此一份，cards 与 diary 共享函数、不复制——night-plan §P2）
export { isGoodnight, inActiveWindow, lastGoodbyeAt };

/** 诊断出口（插件壳 status provider / 排障用；纯读、不落盘、不调模型）。 */
export function gateDiagnostics({ store = null, now = Date.now() } = {}) {
  const s = settings();
  const all = diaryStore.entries();
  let gate = { ok: false, why: '未知' };
  try {
    const g = writeGate({ now, store });
    gate = g.ok ? { ok: true } : { ok: false, why: g.why };
  } catch (e) {
    gate = { ok: false, why: String(e?.message ?? e) };
  }
  return {
    enabled: s.enabled !== false,
    impulseEnabled: s.impulseEnabled === true,
    bedtimeOnly: s.bedtimeOnly === true,
    inActiveWindow: inActiveWindow(new Date(now)),
    lastGoodbyeAt: lastGoodbyeAt({ now, store }),
    writeGate: gate,
    total: all.length,
    today: all.filter((e) => (e.time || '').startsWith(dayKeyOf(now))).length,
    maxPerDay: s.maxPerDay,
    last: all.slice(-1)[0] || null,
    recentModes: all.slice(-12).filter((e) => e.mode).map((e) => e.mode),
    file: diaryStore.diaryFile
  };
}

/* ── 给自检/排障用的内部出口（不影响运行）────────────────────────────── */
export const internals = {
  settings, writeGate, isGoodnight, lastGoodbyeAt, buildImpulsePrompt, runDiary,
  cleanEntry, looksTruncated, isSkip, splitTitleAndBody, readLifeToday,
  inActiveWindow, collectMessages, dayKeyOf, VOICE_RULES,
  setTruncatedForTest: (ts) => { lastTruncatedAt = ts; }
};
