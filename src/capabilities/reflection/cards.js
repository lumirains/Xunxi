// 声明模块 · 记忆卡（步骤⑤ / T5.2）—— 第一个 ReflectionSpec。
//
// 身份（v3 §4 子系统登记表 / 决策 D27）：记忆卡 = 前额叶存储 + 本声明模块 + 执行器，
// 不是 adapter（adapter 永不调模型；本模块只声明，调模型的是执行器）。
// 触发（night-plan-prompt-memory §P2 日记化）：互道晚安 +30 分钟（限定当日最后消息
// ≥23:00——词表复用 diary.js 的 lastGoodbyeAt，共享判定函数不复制）→ 最后消息 +30 分钟
// 兜底（同日已写卡则跳过）→ 次日补跑 ≤7 天（原清单 §10.1 的 catchup 口径保留）。
// needs：当日 messages + life 计划 + staging（海马体原料；life 步骤⑥接线，现为 null）。
// 模板：卡片 JSON 协议（原清单 §10.1 schema；P2 加 entry=第一人称日记正文，先正文后骨架，
// 不加引号包装；events 降级为骨架索引）+ 人设取 config.persona.roleText
//（2026-11-21：person/self 整体丢弃——原 narrative/values 材料行随之摘除）。
// 解析：严格 JSON；entry 缺失回退旧格式（entry=''，events 照旧——首日容错）；
// 兜底：抽取式卡（当天权重最高的 6 条消息），source:'fallback'。
//
// 本模块不写任何状态（写回全部由执行器经前额叶 API 完成）、不 import 身体模块。

import { getConfig, ownerLabelFor } from '../../config.js';
import { OWNER_ACTOR_ID } from '../../person/contracts.js';
import { registerSpec } from './executor.js';

// ── 卡片 JSON 协议（照原清单 §10.1 schema；P2 日记化加 entry 居首——先写正文后列骨架；
//    card-vector 夜1（计划 D3.5）加 gist/keywords 两粒度：gist=卡级向量嵌入源，keywords=可检索词；
//    （原 episodes 附加输出已于 2026-11-21 随心绪数值丢弃整体退役——协议不再要求） ──
const CARD_SCHEMA_TEXT = `{
  "date": "YYYY-MM-DD",
  "entry": "第一人称日记正文（先写这个：她的口吻、当天的情绪底色、让人记住的原句自然融进正文；200~400 字上下，不加引号包装）",
  "gist": "一句话概括这一天，≤40 字，用她的口吻",
  "keywords": ["5-10 个可检索词"],
  "salience": 1,
  "events": ["从日记正文提炼的骨架索引，一句话一条，少而精"],
  "facts": [{ "kind": "address_name|identity|job|like|dislike|taboo|relationship|routine|important_date", "content": "长期事实", "mid": 消息id }],
  "promises": [{ "text": "约定", "due": "YYYY-MM-DD 或空", "status": "open", "mid": 消息id }],
  "open_loops": ["没聊完的话头"],
  "mood": "当天的情绪一句话",
  "range": { "from": 当日首条消息id, "to": 当日末条消息id }
}`;

function fmtClock(ts) {
  const d = new Date(Number(ts));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 发言人标签：主人标签走配置（旧存档 senderName='我' 回落“对方”），避免卡片把
 * 对方的话写成她自己的话（P01 · 2026-11-20）。 */
function whoOf(m) {
  if (m?.self) return '我';
  if (String(m?.senderId ?? '') === OWNER_ACTOR_ID) {
    const name = String(m?.senderName ?? '').trim();
    return name && name !== '我' ? name : ownerLabelFor('');
  }
  return m?.senderName || m?.senderId || '对方';
}

/** 当日消息 → 带证据 id 的编年文本（模型引用事实时只能用这些 #id）。 */
function renderMessages(messages = []) {
  const lines = [];
  for (const m of messages) {
    const who = whoOf(m);
    const mid = m.mid ?? m.id ?? '';
    const text = String(m.text ?? '').slice(0, 120);
    if (m.isPoke) continue;
    lines.push(`[${fmtClock(m.ts)}] #${mid} ${who}：${text}`);
  }
  return lines.join('\n');
}

/** 抽取式兜底卡（解析失败时）：当天最重的 6 条消息原样入卡，不编造任何事实。 */
function extractionFallback(data, day) {
  const messages = (Array.isArray(data?.messages) ? data.messages : [])
    .filter((m) => m && !m.isPoke && String(m.text ?? '').trim().length >= 2)
    .slice()
    .sort((a, b) => String(b?.text ?? '').length - String(a?.text ?? '').length)   // 权重 ≈ 信息量（文本长度）
    .slice(0, 6)
    .sort((a, b) => Number(a.ts) - Number(b.ts));                                  // 事件按时间呈现
  const ids = (Array.isArray(data?.messages) ? data.messages : [])
    .map((m) => Number(m?.id)).filter((n) => Number.isFinite(n));
  return {
    date: day,
    salience: messages.length ? 1 : 0,
    events: messages.map((m) => `[${fmtClock(m.ts)}] ${whoOf(m)}：${String(m.text).slice(0, 80)}`),
    facts: [],
    promises: [],
    open_loops: [],
    mood: '',
    gist: '',          // card-vector 夜1：兜底卡无 gist（不编造），syncCard 对空 gist 跳过登记
    keywords: [],
    range: ids.length ? { from: Math.min(...ids), to: Math.max(...ids) } : { from: 0, to: 0 }
  };
}

/**
 * 剥掉正文整体被包进的一对引号（schema 规则"不加引号包装"——防模型把 entry 整体
 * 包进一对引号交差；正文内部的引号、只出现一端的引号一律不动，与 diary.cleanEntry
 * 的首尾剥离口径同源）。
 */
function stripWrapQuotes(s) {
  const t = String(s ?? '').trim();
  const pairs = [['"', '"'], ['“', '”'], ['「', '」'], ['『', '』'], ["'", "'"]];
  for (const [l, r] of pairs) {
    if (t.length >= 2 && t.startsWith(l) && t.endsWith(r)) return t.slice(1, -1).trim();
  }
  return t;
}

/**
 * 严格 JSON 解析：剥 markdown 围栏后取首尾大括号之间整体 JSON.parse。
 * P2 日记化：entry 缺失/非字符串 → 置空串（旧格式兼容，events 照旧——首日容错）；
 * 只有 entry 也算"有可记内容"（正文是卡片主体）。解析失败/空卡抛错 → 执行器走兜底。
 */
function parseStrict(raw, { day }) {
  let text = String(raw ?? '').trim();
  if (!text) throw new Error('输出为空');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('输出中没有 JSON 对象');
  const card = JSON.parse(text.slice(start, end + 1));
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('JSON 不是对象');
  // entry 缺失/非字符串 → 空串（旧格式兼容；P2 首日容错），字符串则剥整体引号包装
  card.entry = typeof card.entry === 'string' ? stripWrapQuotes(card.entry) : '';
  // card-vector 夜1（计划 D3.5/T1.2）：gist 剥引号包装 + 截 40 字；keywords 数组清洗
  // （String 化、trim、去空、≤10 个）。缺失/形状不对 → 空串/空数组（历史卡口径，消费侧零迁移）。
  card.gist = typeof card.gist === 'string' ? stripWrapQuotes(card.gist).slice(0, 40) : '';
  card.keywords = (Array.isArray(card.keywords) ? card.keywords : [])
    .map((k) => String(k ?? '').trim())
    .filter(Boolean)
    .slice(0, 10);
  const hasContent = String(card.entry).trim()
    || (Array.isArray(card.events) && card.events.length)
    || (Array.isArray(card.facts) && card.facts.length)
    || (Array.isArray(card.promises) && card.promises.length)
    || (Array.isArray(card.open_loops) && card.open_loops.length)
    || String(card.mood ?? '').trim();
  if (!hasContent) throw new Error('卡片没有任何可记内容');
  card.date = day;   // 目标日以调度为准，不信模型自报
  return { card };
}

const cardsSpec = {
  id: 'cards',
  // 子系统开关沿用统一口径（config.modules.<id>.enabled，W6-② 容器键更名），判定在声明内部
  enabled: () => getConfig().modules?.cards?.enabled !== false,
  // 触发数组（night-plan §P2）：晚安+30min（主路径，限定最后消息≥23:00）→ 最后消息
  // 互道晚安（判定复用 diary.js 的 lastGoodbyeAt（词表+成对判定共享一份，不复制）。
  // 2026-11-15（所有者拍板）：afterLastMessage 兜底触发移除——卡片只在晚安（≥23:00
  // 的深夜收尾）/次日 catchup（补缺卡+补全过期卡，见 executor.cardStale）/晚安整理
  // 按钮（force）三个时机写；白天不再自动写卡（当天内容未完，写了也是"白天版"，
  // 次日 catchup 会自动补全）。补跑 7 天。
  trigger: [
    { kind: 'afterGoodnight', delayMin: 30, lastMessageFrom: 23 },
    { kind: 'catchupDays', days: 7 }
  ],
  needs: ['messages', 'life', 'staging', 'facts'],
  maxDaysBack: 7,

  /** 任务模板：卡片 JSON 协议 + 人设（config.persona.roleText）+ 当日原料。 */
  buildTask(data) {
    // 人物表接地（2026-11-11 验收轮）：原任务材料只有 narrative(空)+values，模型对
    // "对方是谁/什么性别"零依据——11-09 卡整张把主人写成"她"并把错误写进 facts。
    // 日记（diary.js roleText()）早就用 config.persona.roleText 兜底，这里对齐同一
    // 口径；再叠加既有 identity/address_name 事实（称呼的权威来源）。
    // （2026-11-21：person/self 已整体丢弃——原 self.narrative/values 材料行随之
    //  摘除，人设接地=roleText + 既有事实，职责完整覆盖。）
    const roleText = String(getConfig()?.persona?.roleText || '').trim();
    const personaLines = [
      roleText ? `人设与对方是谁（性别/称呼以此为准；下面这段人设里的"你"= 卡片主人，即你自己）：\n${roleText}` : '人设：（未设置——称呼与性别只能取自下方既有事实，不得臆造）',
      ...(Array.isArray(data?.facts) && data.facts.length
        ? ['既有事实（称呼/身份/约定以这里为准）：', ...data.facts.map((f) => `- [${f.kind}] ${String(f?.content ?? '')}`)]
        : [])
    ].filter((s) => String(s ?? '').trim()).join('\n');

    // P4（night-plan §7.2）：staging 条目尽量带 mid（remember 工具从触发批取最后
    // 一条用户消息 id）。mid:null 的条目不当事实来源 —— 提示词里显式标注，模型
    // 只能把它们写进 events/open_loops，不得写成 facts/promises（executor 侧仍逐条
    // 校验 mid 当日命中，mid:null 按 D9 兜底放行并计数）。
    const stagingLines = (Array.isArray(data?.staging) ? data.staging : [])
      .map((s) => {
        const text = String(s?.text ?? '').slice(0, 100);
        const mid = s?.mid;
        // 有 mid 就认（数字 = 本地 id，字符串 = 协议 mid），只有真没有才标"无消息id"。
        // 2026-11-13：staging 仍落数字（remember 会把协议串退回本地 id），此处放宽
        // 只是防止未来形状变化时把"有出处"误标成"无出处"。
        const tag = (mid !== null && mid !== undefined && String(mid).trim() !== '')
          ? `（记自消息 #${mid}）`
          : '（无消息id：不得作为 facts/promises 的出处）';
        return `- ${text}${tag}`;
      })
      .join('\n');
    const lifeLines = data?.life
      ? (typeof data.life === 'string' ? data.life : JSON.stringify(data.life))
      : '（今日生活计划暂无）';

    const system = [
      '你是记忆整理者。根据给定的当天聊天记录与暂存笔记，为"她"（聊天机器人本人）写一张当天的记忆卡。',
      '记忆卡是"她自己的记忆"，不是给用户看的总结：用她的视角、口吻记事，不要客服腔，不要汇报腔。',
      '人物表（铁律）：卡片主人「她」= 你自己；对话里的对方是你的主人。对方的性别、名字、称呼一律以【你（记忆的主人）】段里的人设与既有事实为准——材料里指对方用「他」就写「他」，用「她」就写「她」，材料没写就回避，绝不臆造、绝不改写代词。',
      // ── 日记体协议（night-plan §P2）：先 entry 正文，后结构化骨架 ──
      '写卡顺序（日记体协议）：先写 entry，再列骨架。',
      'entry 是当天的第一人称日记正文，写几段话：用她的口吻、带着当天的情绪底色，把这一天聊了什么、什么心情、做了什么记下来；他说过的让人记住的原句，自然地融进正文里，不要做成引用清单。先写后迭代——先把这一天写顺，再回头收拾骨架。',
      'entry 写详细，软目标 200~400 字（不设硬限，值得多写就多写）；不要引号包装，不要"日记："之类的开头，不要结尾总结陈词。',
      '暂存笔记是你自己当时认为值得记下来的东西，优先级高于聊天流水——聊天记录只是原料，暂存笔记里的每一条都要认真对待。',
      '写完 entry 再写结构化骨架：events/open_loops/promises/mood/facts/salience 都从日记正文里提炼，是 entry 的索引，不是第二篇总结。',
      '规则：',
      '1. 只输出一个 JSON 对象，不要任何解释文字或 markdown 代码块。',
      '2. 绝不编造：entry/events/facts/promises/open_loops 只能来自给定材料；facts/promises 的 mid 必须抄写材料里对应的 #消息id；暂存笔记标了「记自消息 #id」的可直接用该 id，标了「无消息id」的内容只能写进 events/open_loops，不得写成 facts/promises。',
      '3. facts 只记长期有用的事（称呼/身份/职业/喜好/忌讳/关系/作息/重要日期），kind 只能用列出的枚举。**每张卡最多 2 条 facts；没有新的稳定长期事实就给空数组**——facts 不是流水账，宁缺毋滥。只记对方/关系的稳定信息，不记当天发生的事（写 entry/events）、不记情绪（写 mood）、不记承诺（写 promises）、不记平台载体（QQ 号等）和项目 meta。写前对照【既有事实】：已有等价内容就不重复写；称呼的当前值写 identity（唯一类会顶替旧值，不用另写新叫法）、昵称写 address_name。约定/承诺一律只写进 promises 字段，不要重复写进 facts（原地重复会让同一条承诺被记两遍）。',
      '4. events 降级为骨架索引：从日记正文提炼，一句话一条，少而精——正文已经记过的事，不再重复铺细节。',
      '5. mood 用一句口语短句描述她当天的情绪；salience 是这一天对她的重要程度，0~5 的数（平淡的一天 1 上下，重要的一天 4 以上）。',
      '6. gist 是一句话概括这一天：≤40 字，用她的口吻，抓住当天最要紧的一件事或一种心情——是浓缩，不是把正文搅拌压缩。',
      '7. keywords 是 5-10 个可检索词：从日记正文与事实里挑（人名、称呼、做过的事、事物名……以后凭这些词能想起这一天），不要凑数。',
      '8. 没有可记内容时给空数组（entry 给空串），不要凑数。',
      `JSON 协议：${CARD_SCHEMA_TEXT}`
    ].join('\n');

    const user = [
      `【你（记忆的主人）】\n${personaLines}`,
      `【当日消息 ${data?.day ?? ''}】\n${renderMessages(data?.messages) || '（当天没有消息）'}`,
      `【暂存笔记（你自己当时认为值得记下来的，优先级高于聊天流水）】\n${stagingLines || '（无）'}`,
      `【今日生活计划】\n${lifeLines}`,
      '请输出记忆卡 JSON。'
    ].join('\n\n');

    return { system, user };
  },

  parse: parseStrict,
  fallback: extractionFallback
};

// 启动期注册（import 即登记；执行器同 id 重复注册会抛错，天然防双挂载）
registerSpec(cardsSpec);

// 两种取声明的外形都给全：`cardsSpec` 具名导出 + `specs.cards` 索引式导出
// （诊断/门禁自检/外部驱动 runOnce 时任取其一）。
export { cardsSpec };
export const specs = { cards: cardsSpec };
