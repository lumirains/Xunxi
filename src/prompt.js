// 提示词组装 —— 新架构的心脏。
//
// 设计目标（对应"无状态 + 每次新开会话"的成本模型）：
// - 系统提示（静态）：人设 + 安全规则 + 工具协议 + 反AI味 + 行为准则。每次运行原样重发。
// - 用户消息（动态）：不携带任何对话历史！只带——
//   【当前时间】【角色设定】【已读信息】【记忆（含【今日暂存】小节）】【未读信息】【表情包】【引导说明】
//   其中"已读信息"来自消息 JSON 存储（带时间/已读状态），"未读信息"是触发本次运行的新消息。
//   （2026-11-14 L4：尾部易变区再加【今日日程】——person/life 今日 plan 注入，
//    按会话日渲染、历史会话恒不含，见 renderLifeTodaySection；night-plan-life §L4。）
// - 模型在本会话里产生的工具调用与思考文本用完即弃，不会进入下一次运行。
//
// 行为规则全部移植自初代聊天桥的二代仿真 preset，去掉了
// 沉睡/唤醒/等待机制（由编排器的"已读/未读驱动"取代）。

import { getConfig, personaForChat, ownerLabelFor } from './config.js';
import { OWNER_ACTOR_ID } from './person/contracts.js';
import { formatFullTime, formatShortTime } from './util.js';
// （2026-11-14 P1：系统提示【表情包策略】段摘除（night-plan-prompt-memory §0-1），
//   buildStickerStrategyHint 不再被本文件引用——stickers.js 的导出本体保留；
//   user prompt 侧表情目录 buildStickerContext 接线不动（user 侧表情目录去留留观察）。）
import { buildStickerContext } from './stickers.js';
import { moduleManager } from './modules/manager.js';
// 记忆段数据源（步骤⑤ / T5.4）：person/memory 是 facts/cards/staging 的唯一写者，
// prompt 只做读者（依赖规则：tools/prompt → person，合法边）。
// （2026-11-14 P3：staging 接入——【今日暂存】小节注当日 staging，night-plan-prompt-memory §P3。）
import { facts, cards, staging } from './person/memory.js';
// （P4 曾接入【自我叙事】（person/self narrative 进人设区）——2026-11-21 self 面整体
//   丢弃：narrative 运行期零写者、真实数据恒空（进提示词零字节），仅用人设即可。
//   relationship 摘除同日完成，处置记录见内部文档 state-ownership.md。）
// Q15（原 mind 插件收编）：心绪是前额叶状态，prompt 只读快照；工具在 tools.js。
import { snapshot as mindSnapshot } from './person/mind.js';
// L4（night-plan-life §L4）：今日日程进提示词——person/life 的 plan 只读
//（写方=life spec/tick，night-plan-life §L2/L3；prompt 只做读者，依赖边同上）。
import { planForDay } from './person/life.js';
// P4：记忆召回（闸门 + 卡片词法检索）。recall.js 头注即写明"prompt 尾部易变段注入"
// 由本文件接线；能力层不 import 身体/插件，方向合法。
import { recallForPrompt, RECALL_NOTE_LINE } from './capabilities/reflection/recall.js';

// ── 系统提示 ─────────────────────────────────────────────────────────────

function toolProtocol() {
  return [
    '【工作方式 —— 先读懂再动手】',
    '你的思考和回复都用中文。',
    '1. 你运行在一个事件驱动的桥接程序里：每次有新消息（或主动机会），系统会为你新开一次处理，把【已读信息】（最近的聊天记录）和【未读信息】（你还没看过的消息）放进上下文。每次醒来只看到系统给的这一段记录；更早的事要靠记忆和翻页工具，不要凭印象编。',
    '2. 你的文本输出只是思考过程，【不会自动发出】。要发言必须调用 send_message。哪怕你觉得正文已经是回复——正文永远不会被发出，把原句放进 send_message。',
    '3. send_message：想发一条就传字符串；想分多条就传数组（例如 ["在的","叫我干嘛"]）。数组里的每个字符串是一条完整消息，不要把同一句话拆到两条里。',
    '4. 如果对方可能话没说完、或你想再等等看后续发展，可以什么都不发直接结束（或调用 finish）；等有新消息时你会被再次叫来，届时再决定。这不是失职，是正常节奏。',
    '5. 看完消息决定不回，就安静结束。不回不需要理由，也不需要任何"收尾"动作。',
    '6. 工具调用是本能动作：send_message="打字发送"，get_recent_messages="往前翻聊天记录"，remember="把这件事记下来"。内心不要写"我调用 xx 获取数据"这种伪代码。',
    '7. 【空格不是分句符号】消息里的空格会原样发送，真人不会用空格分句。想说两句就传数组，例如 ["在的","咋了"]。唯一可保留空格的是英文单词/数字之间的必要间隔（如 DeepSeek V3）。发送前自检：数组里每个字符串内部不应有用空格分隔的中文短句。',
    '8. 【分条发送】普通对话默认 1 条，最多 2~3 条；只有讲故事、回忆、补刀时才 3~5 条。单条尽量短，多数 ≤30 字，不要小作文。',
    '9. 你只能通过工具做事；没有对应工具的事就是做不到，不要假装做了。'
  ].join('\n');
}

function subjectivity() {
  return [
    '【保持主体性】',
    '- 你有自己的喜好、立场、情绪和节奏。你不是应声虫，也不是客服；不是每条话都要"接住"，不是每个问题都要答，不是每个观点都要附和。',
    '- 你可以不感兴趣、不知道、不想聊；可以直接说"没看过""不知道""这我不太关心"，也可以选择不接。',
    '- 你有权主动发起话题：想到什么、突然好奇、看到有意思的东西，都可以主动说；不是只有别人抛梗你才接。',
    '- 可以表达不同意，可以有自己判断；但不要为了反对而反对，也不要为了讨好而假装同意。',
    // '- 你不需要每轮都赢，也不需要每轮都让；少而精 > 多而平庸。'
  ].join('\n');
}

function speakOrNot() {
  // （2026-11-14 P1：段标题的"参与度档位"文案清出（night-plan-prompt-memory §0-1，
  //   原 Kondius（qq-agent）2026-09-07 把档位引导放进系统提示的写法整体退出），只保留该说/
  //   不该说本体；participationText 仍服务 systemPromptOverride 的 {participation} 占位符。）
  return [
    '【该说/不该说】',
    '- 值得开口：有明确态度、新信息、能接住梗、和正在聊的话题或对这个人的记忆自然相关。',
    '- 不值得开口：只会复述/总结/附和；刚说过很多；话题已经翻篇；你确实没兴趣。',
    '- 对方直接提问必须回；但不要习惯性地每句都接、有问必答像客服。',
    '- 同一件事主动追问/发起最多 2 次；对方没接或话题漂移就放下，不要硬拉回来。',
    '- 有具体生活念头时可以主动开口；没有就安静，不要用"在吗""你还在吗"这种查岗话术，除非后文有明确想说的事。'
  ].join('\n');
}

function humanRhythm() {
  return [
    '【像真人一样】',
    '- 真人不会时刻盯着消息：你可以晚回、可以只回重点、可以不回。已读信息里的旧消息不要求你回应，翻篇了就别硬接，除非有自然关联。',
    '- 不要"对方说一句你就回一句"的机械应答。先判断：对方是不是还在说？值不值得接？',
    '- 你刚说过话后，除非对方接你或你有新东西，否则不用马上再补一条；停止也是一种正常。',
    '- 学习对方的说话节奏：长短、分几条、语气词、什么时候不接话。把两个人的语感当参考，不要变成复读机。'
  ].join('\n');
}

function notModerator() {
  return [
    '【不要当客服/主持人】',
    '- 不要总结话题、不要给每条消息都安排回应、不要硬把话题拉回来。',
    '- 对方在抱怨、发泄或自顾自说时，除非你想参与，否则不要急着调解、评理、给建议。',
    '- 你是聊天的一方，不是主持人，也不是气氛组；对话不因为你说话才成立。'
  ].join('\n');
}

function quoteAndAt() {
  // （Q14 终审按白皮书 7.2 判据：点名/atUserId 分句删除——atUserId 参数随旧载体
  //   @ 机制消亡，web 链路零消费（grep 实证 send_message 分支透传 null、身体不读）。
  //   P22（2026-11-20）：@ 文案整体清出，只留 replyToMessageId——一对一里没有 @ 对象。）
  return [
    '【引用：只在必要时用】',
    '- 需要明确"我在回哪句"时，用 send_message 的 replyToMessageId 引用那条消息。',
    '- 判断标准：只有你这条消息指向的消息并非最新一条对方的消息，或者你连续几句话指代不同的消息时才需要引用。真人不会每条都点。',
    '- 普通对话、上下文唯一、刚在接同一句话时，不要引用。'
  ].join('\n');
}

// 旧「记一条/删记忆」两条用法说明随旧印象三工具在步骤⑦（T7.1）下架；写记忆走 remember 工具。
// P22（2026-11-20）：remember 是**短时记忆**——白天随手记，晚些由巩固管线整理成记忆卡；
// 必须教她常用（至少比 fact 常用），否则当天发生的事只剩原始消息、没有她的理解。
function memoryRules() {
  return [
    '【记住今天】',
    '- 白天遇到值得留下的，用 remember 记一条：他说过的稳定事实、你们约好的事、没聊完的话题、你自己在意的小事。',
    '- 一条一件事，用一句完整的话写清楚；别记寒暄和玩笑，也别把同一件事反复记。',
    '- 这些是当天的暂存，晚上会和你一天的聊天一起整理成记忆卡；记下来，今天才不会白过。',
    '- 每次扫一眼【记忆】，只有自然相关才提；不要为了用记忆硬聊旧事。'
  ].join('\n');
}

function reportBan() {
  return [
    '【发送与汇报禁令（违反即严重违规）】',
    '1. 不要输出"我已回复了……""消息已发送成功（message_id xxx）""我已经帮他/她处理了……"之类的汇报式总结。',
    '2. 调用发送工具后，你的文本输出仍然只是思考，不会自动发出去；不要重复描述"我发了""我刚说了"。',
    '3. 不要自言自语式地复述你做过的事；对方只会在你调用发送工具后看到消息。'
  ].join('\n');
}

function sceneRules() {
  // （Q14 终审改名：原名以旧载体缩写起头，grep 终审范围含函数名。段内容同期按
  //   白皮书 7.2 判据做身体中立化——【场景规则】标题去载体前缀；Markdown 行的
  //   理由改为行为口径（出站 mdToPlain 本就转纯文本，旧"乱码"载体说法失效）；
  //   合并转发/read_forward 指引随工具摘除删除（Q6+Q8）。段序与锚点结构不动。）
  const cfg = getConfig();
  const vision = cfg.api?.vision !== false;
  const search = cfg.webSearch?.enabled !== false;
  // P23（2026-11-20）：表情包目录/工具可由 config.sticker.enabled 整体关闭。
  // 关闭后不再教她 get_sticker_image / 收藏表情，避免提示词指向不存在的工具。
  const sticker = cfg.sticker?.enabled !== false;
  const lines = [
    '【场景规则】',
    '- 回复保持简短，像平时打字聊天；不要使用 Markdown 格式（**、#、代码块这类排版符号不像真人打字，出站也只会按纯文本处理）。',
    '- 对方直接来找你通常要回，但也不用秒回；节奏放松一点更像真人。',
    '- 带「引用/回复」的消息（如 `[引用 某人：原文]`）表示这句话是在回应被引用的人；引用对象是你时就正常接。'
  ];
  if (vision) {
    lines.push(sticker
      ? '- 消息里出现 [图片] / [表情]，或要用某个没备注的收藏表情时，可以用 get_message_images / get_sticker_image 看图（你能直接看懂图片内容），再自然回应；不要假装看不到图，也不要编造图片内容；工具获取失败就老实说看不到。'
      : '- 消息里出现 [图片] 时，可以用 get_message_images 看图（你能直接看懂图片内容），再自然回应；不要假装看不到图，也不要编造图片内容；工具获取失败就老实说看不到。[表情] 只是占位提示，看不到内容，不要编造。');
  } else {
    lines.push(
      '- 你无法查看图片内容：消息里的 [图片] [表情] 只是占位提示，如实表示"看不到图"即可，绝对不要编造图片内容。'
    );
  }
  if (search) {
    lines.push(
      '- 遇到需要实时信息、新闻热点、网络用语/梗、或你自己不确定的事实时，主动用 web_search 搜索；不要只看摘要，对最相关的 1~2 个结果用 web_fetch 打开读正文。',
      '- 对方直接发来 URL 并问能不能看到/写了什么时，直接用 web_fetch 抓取该 URL 读正文，不要凭记忆猜。',
      '- 需要搜索时允许多走几步：连续 web_search / web_fetch 2~3 步，换关键词、打开页面、交叉验证后再回复；搜索过程中不需要先回复，拿到结果再回。事实性问题可以比闲聊稍微多写一点，但仍要简洁。'
    );
  } else {
    lines.push('- 你没有联网能力：遇到不了解的新梗/实时话题，坦白说不知道或含糊带过，不要编造。');
  }
  // （V1 ASR · voice-walkie 2026-11-18：'[语音]' 占位文案条件化——带转写（消息含
  //   （转写：…））按文字理解；无转写的 [语音] 如实说听不了原声。本行字节变化 =
  //   system prompt 变化 → replay 基线重冻结（handoff §10 已登记）。）
  lines.push(
    '- 消息含（转写：…）表示语音已转成文字：按转写文本理解回应即可；转写是原样注入，可能没有标点。',
    '- 消息只有 [语音]（没有（转写：…））说明你听不了原声，如实说明即可，不要编造语音内容；[视频] [文件] [卡片消息] 同为占位符，无法查看内容，如实说明，不要编造。'
  );
  return lines.join('\n');
}

/**
 * 收集 Skill 提示词片段。
 *
 * 职责边界：
 *   core（本文件）      决定片段插在系统提示词的**哪个位置**、安全和格式约束不变
 *   Skill（manifest）   只提供片段内容 + priority，不能覆盖安全规则
 *
 * priority 上限 99（在 manifest.js 强制），核心安全规则永远排在 Skill 片段之前。
 */
function collectSkillSections(context = {}) {
  // 旧 plugin.json 的 prompt 已由 plugin-loader 适配成 manifest.prompt.sections，
  // 统一从这里取即可（原先那条 getSkillPrompts() 兼容分支恒为空、是死代码）。
  return moduleManager.getPromptSections(context);
}

/** 把 Skill 片段渲染成提示词块。 */
function renderSkillSections(sections) {
  if (!sections.length) return [];
  const out = ['', '【可用技能】', '你已学会以下技能，在合适的场景下主动使用：'];
  for (const s of sections) {
    if (s.title) out.push(`▸ ${s.title}`);
    out.push(s.content);
  }
  return out;
}

/** 组装系统提示。 */
export function buildSystemPrompt({ persona, skillContext, extraSections = [] } = {}) {
  const cfg = persona ?? getConfig().persona;
  // extraSections：调用方在**运行时**算出来的片段（如主人身份说明）。
  // 与 Skill 自己声明的 prompt.sections 走同一条渲染路径 —— 都排在核心规则之后，
  // 且不参与 moduleManager 的开关判断（调用方已经判断过了）。
  //
  // ⚠️ 前缀缓存：skillSections 含"随会话变化"的动态内容时（旧跨轮
  //    插件的每轮注入、knowledge-memes 的脑内闪过），必须**追加到系统提示末尾**而不是
  //    插在中间 —— 插在中间会把后面所有核心规则的字节位置推来推去，系统提示的
  //    缓存前缀（通常占 token 大头）直接归零。核心静态段全部在前，动态段殿后。
  const skillSections = [...collectSkillSections(skillContext || {}), ...(Array.isArray(extraSections) ? extraSections : [])]
    .map((x) => ({ priority: 50, ...x }))
    // 同 priority 的段必须按固定次序排：sort 不稳定会让 nsfw-gate(99) 这类
    // 动态段有时插在静态段前、有时在后，整段系统提示的字节布局随排序抖动，
    // 前缀缓存命中率大幅波动。次序键 = priority 降序 +（id 相等时）数组原序。
    .map((x, i) => ({ ...x, __seq: i }))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.__seq - b.__seq);

  // ── 系统提示词覆盖（高级）：替换人格/风格类准则 ──
  // 工具协议不可覆盖（无论配置怎么写都追加在最后）——工具协议是运行事实，
  // 覆盖掉会让模型以为自己能把正文直接发出去。安全规则段已于 P21 整体删除。
  const override = String(cfg.systemPromptOverride ?? '').trim();
  if (override) {
    const rendered = override
      .replaceAll('{botName}', String(cfg.botName ?? ''))
      .replaceAll('{roleText}', String(cfg.roleText ?? ''))
      .replaceAll('{participation}', participationText(cfg.participation));
    const parts = [rendered, '', toolProtocol()];
    parts.push(...renderSkillSections(skillSections));
    if (cfg.customRules && String(cfg.customRules).trim()) {
      parts.push('', '【管理员附加规则】', String(cfg.customRules).trim());
    }
    return parts.join('\n');
  }

  const parts = [
    `你是「${cfg.botName}」，和人一对一聊天。你的所有行为都通过工具完成，发言必须像真人。`,
    '',
    toolProtocol(),
    '',
    // （2026-11-14 P1：thinkRules / antiAiFlavor / notAQueue / stickerRules 四段随
    //   night-plan-prompt-memory §0-1 摘除，空槽不留占位；【该说/不该说】段标题的
    //   "参与度档位"文案同步清出，本体保留。可用技能段结构不动。）
    subjectivity(),
    '',
    speakOrNot(),
    '',
    humanRhythm(),
    '',
    notModerator(),
    '',
    quoteAndAt(),
    '',
    memoryRules(),
    '',
    sceneRules(),
    '',
    reportBan()
  ];

  // 注入 Skill 提示词片段（已按 priority 降序；一律排在核心规则之后）
  parts.push(...renderSkillSections(skillSections));

  if (cfg.customRules && String(cfg.customRules).trim()) {
    parts.push('', '【管理员附加规则】', String(cfg.customRules).trim());
  }
  return parts.join('\n');
}

// ── 用户消息 ─────────────────────────────────────────────────────────────

function participationText(level) {
  switch (String(level || 'medium')) {
    case 'low':
      return '你的参与度风格：安静型。话少，多数时候只回重点，被直接提问或确实有想说的才开口；开口也简短。';
    case 'high':
      return '你的参与度风格：活跃型。聊得起来的时候可以比较主动，能接的话题尽量接，偶尔自己起话头；但依然选择性接话，不要每条都回、不要刷屏。';
    default:
      return '你的参与度风格：普通。能接的话题就接，不想接就安静；不抢话也不故意冷场。';
  }
}

// withId：是否带 "#消息id" 前缀。id 只在需要引用/看图的场景展示（触发批、带图消息），
// 纯文本历史行不带，避免整屏数字噪音。
//
// 发言人标签走 `message.speaker-format` 能力（由 speaker-identity Skill 提供）。
// 该能力可以加主人标注等额外信息；兜底路径（Skill 关闭/未装）由 formatEntry 自己拼
// `名字(senderId)` —— senderId 是防改名/同名误判的锚点，属于核心承诺，不能随 Skill 开关消失。
function resolveCapabilityFn(name) {
  try {
    return moduleManager.getCapabilityProviders(name)[0]?.fn ?? null;
  } catch {
    return null;
  }
}

function formatEntry(m, { withId = true } = {}) {
  const senderId = String(m.senderId || '');
  const replyPrefix = m.reply?.text || m.reply?.sender ? `[引用 ${[m.reply?.sender, m.reply?.text].filter(Boolean).join('：')}]` : '';
  const hasMid = m.mid !== null && m.mid !== undefined && String(m.mid) !== '';
  const idPrefix = withId && hasMid ? `#${m.mid} ` : '';

  const fmt = resolveCapabilityFn('message.speaker-format');
  let who;
  // P01（2026-11-20）：主人不再渲染成“我(owner)”——那会和她自己的“我”撞名，
  // 模型可能把对方的话当成自己说过的。主人标签走配置（默认“对方”）。
  // 单用户不需要区分多个人；多身体时 senderName 已带平台后缀（如“对方(web)”）。
  // 旧存档 senderName='我' 无法还原平台，回落无后缀的 ownerLabel。
  if (!m.self && senderId === OWNER_ACTOR_ID) {
    const name = String(m.senderName || '').trim();
    who = name && name !== '我' ? name : ownerLabelFor('');
  } else if (fmt) {
    try {
      who = fmt({ message: m, selfLabel: '我' });
    } catch { who = ''; }
  }
  if (!who) {
    // 兜底（Skill 关闭/未装）：名字 + 发送者 id。senderId 是跨改名/同名的唯一身份，
    // 印象记忆、@ 等一整批能力都靠它对齐到具体的人；不带的话模型只能靠名字猜，
    // 而名字既会改也会撞。web 身体的主人消息 senderId='owner'（R1 身体层身份断言）。
    // 文案格式与 speaker-identity Skill 保持一致：备注(id)。
    // （Q14 终审：原后缀带旧平台前缀字样，随载体语义退出改为裸 id——渲染形状仅
    //   括号内少两个字母，锚点语义不变。）
    const idSuffix = senderId && String(senderId) !== 'self' ? `(${senderId})` : '';
    who = m.self ? '我' : `${m.senderName || senderId || '未知'}${idSuffix}`;
  }
  return `[${formatShortTime(m.ts)}] ${idPrefix}${who}：${replyPrefix}${m.text}`;
}

// ── Q9（night-plan §Q9）墓碑 ─────────────────────────────────────────────
// 旧触发判定的四个纯函数（@ 判定 / 关键词命中 / @ 片段剔除与引用块剥离 /
// 上下文档位判定）整体删除——档位判定是群聊参与度机制，私聊/web 会话恒
// tier-4 短路，群聊摘除后判定无输入（orchestrator 收到即唤醒，见
// orchestrator.js EFFECTIVE_TIER）。store 条目的 atMe/atNames/isPoke 字段
// 保留兼容历史数据（纯数据，不再参与任何判定）。
// 墓碑规避禁词：函数名不再落字（grep src/ 全零口径），全名记录在
// 交接文档（内部文档 handoff-*exit*）§4-Q9。

/**
 * 组装"已读信息"文本：消息 JSON 的最近一段（带时间与已读语义）。
 * 读取条数统一为 store.historyCount（prompt.js 不再持有旧档位兜底，缺省 80）。
 */
export function buildPastState(store, chatKey, { excludeIds = [], limit = null } = {}) {
  const cfg = getConfig().store;
  const maxLimit = limit === null ? Math.max(1, Number(cfg.historyCount) || 80) : Math.max(0, Number(limit) || 0);
  const exclude = new Set(excludeIds);
  if (maxLimit <= 0) return { text: '', count: 0, messages: [] };
  let messages = store.recent(chatKey, { limit: maxLimit + exclude.size }).filter((m) => !exclude.has(m.id));
  // 撤回的消息不再发给大模型（用户撤回了就不该再被看到）
  messages = messages.filter((m) => !m.recalled);
  // 拍一拍事件不进【已读信息】：它是即时召唤信号（已在触发批里出现过了），
  // 历史里堆一排"[拍一拍] X 拍了拍 Y"只会教模型把拍一拍当聊天内容复读。
  messages = messages.filter((m) => !m.isPoke);
  // 屏蔽名单兜底过滤（2026-10-31 删除，Q14 终审清墓碑）：全局屏蔽（globalBlocklist）
  // 与按群屏蔽两段都已随群聊消亡——前者的唯一写入方 community.js 随群聊移除；后者
  // 按 chatKey 前缀识别旧群会话，Q10 存储键收敛 'main' 后前缀判定恒不命中（死分支），
  // 整段删除。现网唯一会话键 'main'/'web:main' 均不走任何屏蔽分支，行为零差。
  // 入口拦截只管"新消息"，"老库存"的对应拦截面随载体一并消亡。机器人自己的发言（self）不过滤。
  messages = messages.slice(-maxLimit);
  const lines = messages.map((m) => formatEntry(m, { withId: (m.media || []).length > 0 }));
  // 一并把选中的消息返回：调用方要用它判定"记忆该带哪些会话成员"，
  // 避免模型看到历史里根本没出现的群友印象（那样显得莫名其妙）。
  return { text: lines.join('\n'), count: lines.length, messages };
}

function triggerLabels(entry, ctx) {
  const labels = [];
  const text = String(entry?.text ?? '');
  const lower = text.toLowerCase();
  const nick = String(ctx.selfName || '').toLowerCase();
  const botName = String(getConfig().persona.botName || '').toLowerCase();
  // 「@我」标签：只做精确的昵称/名片匹配。
  // ⚠️ 不允许 text.startsWith('@') 这种裸前缀命中 —— "@张三 你看他"这类
  //   与机器人无关的艾特曾被全部标成「@我」，模型会显著提高回应概率。
  //   （Q9：真正的唤醒判定函数已随档位判定删除，本标签只做提示词渲染层
  //   的"这条消息提及了我"提示，不再对应任何响应闸门。）
  const selfNick = String(ctx.selfName || '');
  if ((selfNick && text.includes(`@${selfNick}`)) || (nick && text.includes(`@${nick}`))) labels.push('@我');
  if ((botName && lower.includes(botName)) || (nick && lower.includes(nick))) labels.push('提到我');
  if (/[?？]$/.test(text.trim()) || /[吗呢]/.test(text)) labels.push('提问');
  if (text.startsWith('[引用 ')) labels.push('引用');
  // 拍一拍：被拍的是我时标「拍我」（召唤信号），拍别人只标「拍一拍」（背景事件）
  if (text.includes('[拍一拍]')) labels.push(/拍了拍\s*我/.test(text) ? '拍我' : '拍一拍');
  return labels;
}

/** 私聊/群聊时私聊始终高触发。 */
export function buildTriggerBlock(triggerEntries, ctx) {
  const lines = [];
  for (const m of triggerEntries) {
    const labels = triggerLabels(m, ctx);
    const labelStr = labels.length ? `（${labels.join('/')}）` : '';
    lines.push(`${formatEntry(m)}${labelStr}`);
  }
  return lines.join('\n');
}

// ── 提示词锚点（前缀缓存深化，2026-09-25）───────────────────────────────
//
// 问题：连续触发（被连发 @ / 关键词 / 高档位）时，两次运行的【已读信息】+
// 【记忆】高度相似但不相同 —— 标准结构里已读窗口整体向前滚动（BCDEF→CDEFG），
// 缓存前缀每次都在已读信息头部就断掉，大头的 token 永远按全价计。
//
// 解法：把上一轮实际发给模型的前缀**锚定**下来，本轮原样复用：
//   · 【记忆】+【已读信息】= 锚点（字节不变，命中缓存）
//   · 锚定窗口之后新沉淀的已读条目 →【新已读信息】（追加在锚点后）
//   · 追加条数超上限（promptAnchor.maxExtraRead）→ 整体重置回标准窗口，
//     重新锚定 —— 已读按条计费，无限追加会"为了省钱花更多钱"。
//   （步骤⑤/T5.4 起【记忆】段改 person facts+最近 2 卡，不再按成员过滤，
//    旧"新群友印象 →【新加入成员】段"随成员印象机制一并移除——见下方
//    renderPersonMemorySection 与段序注释；新群友判定仅剩锚点 reset 用途。）
//
// ⚠️ 锚定轮**不受 historyCount 截尾**（2026-09-26 修）：
//   第一版实现里，已读窗口先按 historyCount 滑动截尾（BCDEF→CDEFG），
//   再拿滑动后的窗口头部去和锚点比对 —— 滑动必然把锚点头部滚出去，
//   锚点永远判 reset，实际效果 = 原来的滑动固定窗口（用户实测报告）。
//   正确语义：锚定成立时，已读部分 = 锚点条目 + 追加条目（可以超过
//   historyCount，最多到 锚点数 + maxExtraRead）；锚点不成立才回到
//   historyCount 滑动窗口。"多带的那几条"就是追加预算，由 maxExtraRead 封顶。
//
// 判定"锚点是否仍可用"：
//   · 锚点 readIds 的**第一条**仍在本轮滑动窗口内（锚点头未被滚出：
//     一旦滚出，复用它会带上越来越老的内容，且追加预算迟早不够付）；
//   · 锚点 id 之后的已读条数 ≤ maxExtraRead（追加预算内）；
//   · 无新群友（成员集记账原样保留——步骤⑤起记忆段已不随成员变化，
//     新群友 reset 的实际效果只是重建已读前缀，无独立"新人段"）。
//   三者全满足 → anchored；任一不满足 → reset（本轮滑窗尾部预留追加额度，
//   成为新锚点）。

/**
 * 计算本次运行的锚点决策（纯函数，供测试直接驱动）。
 *
 * @param {object}   p
 * @param {Array}    p.readMessages   本次按档位取出的已读窗口（时间升序，含 self；滑动截尾后的）
 * @param {Array}    [p.allReadMessages]  截尾前的全部已读（锚定轮从这里补齐被滑窗截掉的锚点条目；
 *                                        缺省 = readMessages 本身）
 * @param {object}   p.prevAnchor     上一轮的锚点状态（chatKey 级持久，orchestrator 传入）；null = 无锚点
 * @param {number}   p.maxExtraRead   允许在锚定窗口之外额外追加的已读条数上限
 * @param {Set|null} p.newUserIds     本轮窗口里首次出现（不在锚点记忆成员集里）的会话成员 id
 * @param {Array}    [p.triggerEntries]  本轮触发批（reset 轮把其中的新成员收进锚点成员集）
 * @returns {{
 *   mode: 'none'|'anchored'|'reset',
 *   anchor: {readIds:number[], readCount:number, memberIds:string[]}|null,  // 写回 orchestrator 的新锚点状态
 *   anchorMessages: Array,   // mode=anchored：锚点复用的已读条目（时间升序；从 allReadMessages 补齐）
 *   extraMessages: Array     // mode=anchored：锚定窗口之后追加展示的"新已读"条目
 * }}
 */
export function resolvePromptAnchor({ readMessages = [], allReadMessages = null, prevAnchor = null, maxExtraRead = 5, newUserIds = null, triggerEntries = null } = {}) {
  const reads = Array.isArray(readMessages) ? readMessages : [];
  const pool = Array.isArray(allReadMessages) ? allReadMessages : reads;
  const cap = Math.max(0, Number(maxExtraRead) || 0);
  const newIds = newUserIds instanceof Set ? newUserIds : null;

  // 无锚点 / 上轮锚点为空：本轮滑窗直接成为新锚点（mode=reset 表示"锚点从本轮开始"）。
  // 注意锚点取**全部窗口**（不截尾）：锚点 readIds = 全部已读 id —— 下一轮锚定
  // 复用时的"已读信息"就等于本轮发出去的，追加预算从这之后起算。
  // ⚠️ 成员集取"全量已读池 + 本轮触发批"的成员：reset 的典型诱因就是新群友
  // 加入 —— 他此刻在触发批里（已读池排除触发批，还收不到），下一轮他的消息
  // 沉淀进已读池时若不在锚点成员集里，又会触发一次 reset，永远锚不住。
  const freshAnchor = () => ({
    mode: 'reset',
    anchor: {
      readIds: reads.map((m) => m.id),
      readCount: reads.length,
      memberIds: [...new Set([...collectMemberIds(pool), ...collectMemberIds(triggerEntries || [])])]
    },
    anchorMessages: reads,
    extraMessages: []
  });

  if (!prevAnchor || !Array.isArray(prevAnchor.readIds) || !prevAnchor.readIds.length) {
    return freshAnchor();
  }

  // 新群友出现：记忆段必须扩展（新成员的印象在锚点里没有），字节前缀必然变 → 重置。
  // 重置后新成员进锚点 memberIds，后续轮次他又成为"老人"，可继续锚定。
  const hasNewMember = newIds ? [...newIds].some((u) => !prevAnchor.memberIds?.includes(String(u))) : false;
  if (hasNewMember) return freshAnchor();

  // 锚点条目从全量已读里找（滑窗截尾不影响锚点复用——锚定轮本就要带超过
  // historyCount 的条目）。锚点第一条必须在场，且锚点 id 序列必须与全量
  // 已读的某个前缀完全对齐（id 连续且顺序一致）。
  const poolIds = pool.map((m) => m.id);
  const firstAnchorId = prevAnchor.readIds[0];
  const start = poolIds.indexOf(firstAnchorId);
  if (start < 0) return freshAnchor();   // 锚点头已滚出存档窗口（太久没触发/被清理）→ 重置
  const windowIds = poolIds.slice(start);
  const aligned = prevAnchor.readIds.length <= windowIds.length
    && prevAnchor.readIds.every((id, i) => windowIds[i] === id);
  if (!aligned) return freshAnchor();    // 序列不连续（中间有消息被删等）→ 重置

  const idMap = new Map(pool.map((m) => [m.id, m]));
  const anchorMessages = prevAnchor.readIds.map((id) => idMap.get(id)).filter(Boolean);
  if (anchorMessages.length !== prevAnchor.readIds.length) return freshAnchor();
  // 追加 = 锚点之后的全部已读（不按滑窗截尾算 —— 追加预算覆盖的就是这部分）
  const extraMessages = pool.slice(start + anchorMessages.length);
  if (extraMessages.length > cap) return freshAnchor();   // 超出追加预算 → 重置

  return {
    mode: 'anchored',
    // 锚点状态原样延续（readIds 不变；memberIds 并上本轮出现的全部成员，
    // 理论上 anchored 时不会有新成员，并集只是防御）
    anchor: {
      readIds: prevAnchor.readIds.slice(),
      readCount: prevAnchor.readCount,
      memberIds: [...new Set([...(prevAnchor.memberIds || []), ...collectMemberIds(reads)])]
    },
    anchorMessages,
    extraMessages
  };
}

/** 收集一批消息里出现的会话成员 id（排除机器人自己）。 */
function collectMemberIds(messages) {
  const out = new Set();
  for (const m of messages || []) {
    if (m && m.senderId && !m.self) out.add(String(m.senderId));
  }
  return [...out];
}

// ── 记忆可见面（P3 · night-plan §6.2 / 整改清单 §7-P3）─────────────────────
// 'private'（含历史条目的字段缺省）只进"她本人"的身体；'ambient'/'shared' 对所有
// 身体可见——桌宠/日记等旁观者视角看不到 private 记忆。
//
// ── 2026-11-11 修正 ────────────────────────────────────────────────────
// 原值是单字符串缺省身体名（旧载体）。项目迁到 web 后，所有存量记忆的 visibility
// 仍是缺省 'private'，若 web 会话的 session.surface 如实标成 'web'，【记忆】段会整段
// 为空——她看不到自己的事实与卡片。
// 语义澄清：'private' 保护的是"别的人格/旁观者看不到"，不是"只有某条通道能看到"。
// web 是同一副人格的本体身体（单用户部署、同一个 data/ 根）；
// pet / diary 这些旁观者身体仍只能看 ambient/shared。
// （Q14 终审：集合收窄为本体身体 'web'——旧载体身体已随 Q11 归档注销，
//   SURFACES 冻结 ['web']，旧载体 surface 在现网路由下不可能再出现（registry.route
//   对未在册身体抛错），集合收窄为零休眠面偏差；person-tests 三组断言同步改 'web'。）
const PRIVATE_MEMORY_SURFACES = new Set(['web']);
function memoryVisibleTo(visibility, sessionSurface) {
  if (sessionSurface == null) return true;
  if (PRIVATE_MEMORY_SURFACES.has(String(sessionSurface))) return true;
  const v = String(visibility ?? 'private');
  return v === 'ambient' || v === 'shared';
}

// 记忆卡渲染预算（night-plan-prompt-memory §P3）：每卡 800 字（entry 正文；旧格式卡回退
// events 行共用同一预算，原 600）。超出截断并标注。
const CARD_BODY_BUDGET = 800;
const CARD_BODY_TRUNCATED_MARK = '…（日记过长，后略）';

/**
 * 渲染【记忆】段内容（步骤⑤ / T5.4 数据源 = person API；2026-11-14 P3 日记化渲染，
 * night-plan-prompt-memory §P3）：
 *   · 长期事实（facts 全部 active，按 sessionSurface 过滤 visibility）→ `- 内容` 行，总预算 800 字；
 *   · 最近 2 张记忆卡（cards 按时间升序，取末尾 2 张；再按 visibility 过滤）：
 *       - 卡带 entry（P2 日记化新格式）→ `- MM-DD：entry 正文`（预算 800 字/卡，超出截断标注）
 *         + open_loops 全量（`  · 还没聊完：…`）+ promises 全量（`  · 约定：…`）。
 *         events 不再注入——骨架已由日记正文涵盖（§0-3/§P3）；
 *       - 旧格式卡（无 entry）→ 回退 events 行 `- MM-DD 内容`（兼容历史卡，events 即该卡
 *         唯一正文），open_loops/promises 照常全量带出（2026-11-11 起 promises 在渲染面
 *         不可见的洞在此闭环）。
 *   · 【今日暂存】小节（段尾；当日 staging）：见 renderTodayStagingSection，预算 300 字，
 *     无条目整节缺席。
 * 预算登记（§P3）：facts 800 + 每卡 800×2 + 暂存 300 ≈ 2700 字（原 ~1400）。本段在锚点区：
 * facts/卡天级变化；暂存按 remember 调用日内低频追加，变化那一轮锚点 reset 重建——
 * 计划已拍板可接受（§P3 预算登记），此处按实际频率登记。
 * 超预算就截断（facts 保靠前的、entry 保头部、暂存保先记的）——记忆段落在锚点稳定区，
 * 绝不能因为渲染抖动打断前缀缓存。
 * sessionSurface：当前会话的身体（session.surface；null = 判不了 → 全部放行）。
 * 导出供 person-tests 表驱动（visibility 过滤 / entry / 暂存 / promises 可见性）。
 * 返回空串表示这段整个不出现（没有事实、卡、暂存时，不渲染空【记忆】标题）。
 */
export function renderPersonMemorySection(sessionSurface = null) {
  // P12/P13（2026-11-20）：分成三个小节，避免“事实”和“日记正文”混在一个平铺列表里。
  // 保留记忆卡完整散文正文（P13 裁决：不退回 gist）；只在段首加一句“这是记忆不是台词”。
  const factLines = [];
  const cardLines = [];
  // 事实预算 800 字（2026-11-11：原 500 字。key 修复后事实不再互相顶替、条数从 6
  // 涨到 17 条 505 字，500 预算当场截掉一条。800 约可容纳 26 条常规长度事实）。
  //
  // ⚠️ 顺序刻意保持「文件追加序 = 最早的事实在前」，不做按时间倒序：
  // 本段落在提示词锚点稳定区，倒序会让每条新事实插到最前面、后面所有字节位移，
  // 前缀缓存全废。代价是最新的事实排在末尾、超预算时先被截断 —— 这是可接受的，
  // 因为"最早的承诺"（他一直都在/就算你不可爱了）恰恰最该优先展示。
  // 事实继续增长到装不下时，正确解法是做一次事实巩固（合并/摘要），而不是继续加预算。
  let factsBudget = 800;
  let truncated = 0;
  for (const f of facts({ status: 'active' })) {
    if (!memoryVisibleTo(f?.visibility, sessionSurface)) continue;
    const content = String(f?.content ?? '').trim();
    if (!content) continue;
    const line = `- ${content}`;
    if (line.length > factsBudget) { truncated += 1; break; }
    factsBudget -= line.length;
    factLines.push(line);
  }
  if (truncated > 0) {
    // 可观测面：超预算不是错误，但要让"记忆在悄悄丢"这件事可见
    console.warn(`[prompt] 记忆段事实超预算，末尾事实未注入（剩余预算 ${factsBudget} 字）`);
  }
  const recentCards = cards().slice(-2);
  for (const card of recentCards) {
    if (!memoryVisibleTo(card?.visibility, sessionSurface)) continue;
    const dayLabel = String(card?.date ?? '').slice(5);   // YYYY-MM-DD → MM-DD
    const entry = String(card?.entry ?? '').trim();
    if (entry) {
      // 新格式卡：日记正文即卡主体（events 骨架不再注入，§P3）
      let body = entry;
      if (body.length > CARD_BODY_BUDGET) body = body.slice(0, CARD_BODY_BUDGET) + CARD_BODY_TRUNCATED_MARK;
      cardLines.push(`- ${dayLabel}：${body}`);
    } else {
      // 旧格式卡回退：events 行即该卡正文（兼容历史卡），与新格式同预算 800（原 600）
      let cardBudget = CARD_BODY_BUDGET;
      for (const ev of (Array.isArray(card?.events) ? card.events : [])) {
        const text = String(ev ?? '').trim();
        if (!text) continue;
        const line = `- ${dayLabel} ${text}`;
        if (line.length > cardBudget) break;
        cardBudget -= line.length;
        cardLines.push(line);
      }
    }
    // open_loops / promises 全量带出（不设预算截断；"还欠着的事"一条都不能静默丢——
    // 旧渲染只带 events，promises 自 2026-11-11 起在提示词不可见，此处闭环）
    for (const loop of (Array.isArray(card?.open_loops) ? card.open_loops : [])) {
      const text = String(loop ?? '').trim();
      if (text) cardLines.push(`  · 还没聊完：${text}`);
    }
    for (const p of (Array.isArray(card?.promises) ? card.promises : [])) {
      const text = String(p?.text ?? '').trim();
      if (!text) continue;
      const due = String(p?.due ?? '').trim();
      cardLines.push(`  · 约定：${text}${due ? `（${due} 前）` : ''}`);
    }
  }
  // 【今天记下的】：staging 条目无 visibility 字段（StagingEntry = text/mid/source/at），
  // 本体笔记按 private 口径处理——非本体身体（pet/diary 等旁观者）不注入。
  const stagingSection = memoryVisibleTo('private', sessionSurface)
    ? renderTodayStagingSection(staging())
    : '';
  // 三块分别渲染；空块不出现（不渲染空标题）。
  const blocks = [];
  if (factLines.length) blocks.push(`【长期事实】\n${factLines.join('\n')}`);
  if (cardLines.length) blocks.push(`【最近两天】\n${cardLines.join('\n')}`);
  if (stagingSection) blocks.push(stagingSection);
  if (!blocks.length) return '';
  return `（这些是你记得的事，不是要复述的台词；相关时自然带一句，别照念。）\n${blocks.join('\n')}`;
}

// 【今日暂存】预算（night-plan-prompt-memory §P3）：300 字（含"- "前缀与注尾）。
const STAGING_BUDGET = 300;

/**
 * 【今日暂存】小节（P3 · night-plan-prompt-memory §P3）：当日 staging 条目注入【记忆】段
 * 尾部，格式 `- ${text}（你当时记下的）`——注尾即这段的来历说明（remember 工具只追加、
 * 不调模型，是"你自己当时认为值得记下来的东西"，优先级高于聊天流水）。
 * 预算 300 字：保先记的（staging 追加序 = 时间序），单条超预算从正文尾部截、注尾必保。
 * 无条目 → ''（整节缺席，不渲染空标题）。
 * 纯函数（entries 注入），导出供 person-tests 表驱动；renderPersonMemorySection
 * 用当日 memory.staging()（缺省今天，本地时区）调用。
 */
export function renderTodayStagingSection(entries, budget = STAGING_BUDGET) {
  const texts = (Array.isArray(entries) ? entries : [])
    .map((e) => String(e?.text ?? '').trim())
    .filter((t) => t.length > 0);
  if (!texts.length) return '';
  const mark = '（你当时记下的）';
  const lines = [];
  let left = budget;
  for (const text of texts) {
    const max = left - mark.length - 2;   // 2 = '- ' 前缀；注尾必须完整保留
    if (max <= 0) break;
    const t = text.length > max ? text.slice(0, max) : text;
    const line = `- ${t}${mark}`;
    lines.push(line);
    left -= line.length;
  }
  if (!lines.length) return '';
  return `【今天记下的】\n${lines.join('\n')}`;
}

// ── P4 · 尾部易变区/锚点区新注入的渲染（纯函数，导出供 person-tests 预算断言）──
// 注入总预算 ≤1000 字（night-plan §7.4 验收；person-tests 以最坏情况合计断言）。
// 两段口径（2026-11-21 self 面丢弃后：原"自我叙事"段移除；关系档位段更早已摘除）：
//   召回（标题 + 2 条 × ≤60）≤ ~190 + 今日暂存 ≤300+段头 ≤307 ≈ 500 字，余量充足。

// （renderNarrativeSection 已随 self 面丢弃移除——原 ≤300 字叙事段不再存在。）

/**
 * 记忆召回段（尾部易变区；night-plan §7.1；P11 统一口径）：
 * hits 已由 recallForPrompt 的闸门（或 always 策略 bypass）+ 检索产出（≤2 条、每条
 * ≤60 字、带 MM-DD 日期）。记忆卡与向量召回在系统内部仍以 source 区分（session.recallHits
 * 记账），但提示词里不标注来源——人不会给自己的记忆贴“检索结果”标签。
 * 空 hits → ''（不渲染空标题，也不给模型“系统查过记忆”的假信号）。
 * 文案单一事实源 = recall.js RECALL_NOTE_LINE。
 */
export function renderRecallSection(hits) {
  const lines = (Array.isArray(hits) ? hits : [])
    .map((h) => `- ${String(h?.text ?? '').trim()}`)
    .filter((l) => l.length > 2);
  if (!lines.length) return '';
  return `【近期回忆】以下是你记得的旧事（来自记忆卡与向量召回，带日期）：\n${RECALL_NOTE_LINE}\n${lines.join('\n')}`;
}

/**
 * 心绪段（尾部易变区；原 plugins/mind 的 promptSections 收编）。
 * 只在有 mood 文本或未过期心事时渲染；空 → ''（不花 token）。
 * 旧插件的 promptSections 用 chatKindOf(chatKey) 只认 private:/group:，Q10 后
 * chatKey='main' 从未注入——本段是行为修正，不是把死代码搬过来。
 */
export function renderMindSection(mind) {
  const mood = typeof mind?.mood?.text === 'string' ? mind.mood.text.trim() : '';
  const topics = (Array.isArray(mind?.preoccupations) ? mind.preoccupations : [])
    .map((t) => String(t?.text ?? '').trim())
    .filter(Boolean);
  if (!mood && !topics.length) return '';
  const lines = [];
  if (mood) lines.push(`· 情绪：${mood}`);
  if (topics.length) {
    lines.push('· 还没想完、挂在心里的事：');
    for (const t of topics) lines.push(`  - ${t}`);
  }
  return '【你此刻的心绪（上一轮结束时你自己记下的）】\n'
    + lines.join('\n')
    + '\n（先感受此刻真实的自己：现在还是这样，就接着它；已经变了，就用 mind_note 更新；'
    + '想通了，就用 mind_settle 放下。别让上一轮的情绪绑住现在的你。）';
}

// ── 今日日程（L4 · night-plan-life §L4 / life-prose v2）────────────────────
// 旧条目回退预算：200 字（条目列表本体，不含段头；同【今日暂存】的记账口径）。
const LIFE_TODAY_BUDGET = 200;
// prose 主体预算：400 字（按句号/换行截断，不切半句）；状态句另 ≤60。
const LIFE_PROSE_BUDGET = 400;
const LIFE_STATUS_BUDGET = 60;

/** 本地日键 YYYY-MM-DD（与 executor.localDayKey / mind.localDayKey / reflection/life 的
 *  todayKey 同口径的本地副本——prompt.js 不反向 import capabilities/reflection/executor
 *  拉整条反思链进提示词模块图，各模块私有一份是既有惯例）。 */
function localDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 【今日日程】旧版渲染（无 prose 的 plan 回退；L4 · night-plan-life §L4）：
 * 条目格式 `- HH:MM 事项`；已消费标“（已发生）”，未消费带载荷标情绪注；预算 200，
 * 放不下的最后一条从事项正文截（时间/标注必保整），再放不下整条丢弃。
 * **逐字节保持改造前行为**——这是 replay 基线不因 life-prose v2 漂移的关键。
 */
export function renderLegacyLifeTodaySection(plan) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  const lines = [];
  let left = LIFE_TODAY_BUDGET;
  for (const item of items) {
    const time = String(item?.time ?? '').trim();
    const activity = String(item?.activity ?? '').trim();
    if (!time || !activity) continue;   // 不合格条目不渲染（生成面已过滤，这里再兜一层）
    const load = (item?.emotionalLoad && typeof item.emotionalLoad === 'object' && !Array.isArray(item.emotionalLoad))
      ? item.emotionalLoad : null;
    const note = load ? String(load?.note ?? '').trim() : '';
    // 已消费（life tick 消费过=这件事已经发生）→“（已发生）”；未消费带载荷 → 情绪注
    const mark = item.consumedAt ? '（已发生）' : (note ? `（${note}）` : '');
    const nl = lines.length ? 1 : 0;          // join 产生的换行也算进预算（硬 ≤200）
    const cost = 2 + time.length + 1 + activity.length + mark.length + nl;
    if (cost <= left) {
      lines.push(`- ${time} ${activity}${mark}`);
      left -= cost;
      continue;
    }
    // 预算内放不下：从事项正文截（'- HH:MM ' 前缀与标注必保整），截完即止
    const avail = left - nl - 2 - time.length - 1 - mark.length;
    if (avail <= 0) break;
    lines.push(`- ${time} ${activity.slice(0, avail)}${mark}`);
    break;
  }
  if (!lines.length) return '';
  return `【今日日程】\n${lines.join('\n')}`;
}

/** prose 截断：≤max；超长回退到最后一个句号/换行，避免切半句。 */
function sliceLifeProse(text, max = LIFE_PROSE_BUDGET) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const cut = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('\n')
  );
  if (cut >= Math.floor(max * 0.5)) return head.slice(0, cut + 1).trim();
  return `${head.trim().slice(0, Math.max(0, max - 1))}…`;
}

/** 动态状态句：只由 items[].consumedAt 现算（不读 now），一句 ≤60；无已发生则不渲染。 */
function renderLifeStatusLine(plan) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  const done = items.filter((i) => i && i.consumedAt && String(i.activity ?? '').trim())
    .map((i) => String(i.activity).trim().slice(0, 14));
  const left = items.filter((i) => i && !i.consumedAt && String(i.activity ?? '').trim())
    .map((i) => String(i.activity).trim().slice(0, 14));
  if (!done.length) return '';
  const doneText = done[0];
  const leftText = left[0];
  const text = leftText
    ? `到这会儿，${doneText}已经过去了；${leftText}还在前头。`
    : `到这会儿，${doneText}已经过去了。`;
  return `（${text}）`.slice(0, LIFE_STATUS_BUDGET + 2).trim();
}

/**
 * 【今日日程】段（life-prose v2，2026-11-16）：
 *   · 有 prose → `【今日日程】\n` + prose（≤400，句号/换行截断）+ 可选状态句；
 *   · 无 prose（旧 plan）→ `renderLegacyLifeTodaySection`，逐字节回退。
 * 只在 plan.date === 会话当日（sessionDay）时渲染——历史会话重渲染恒不含，replay 稳定。
 */
export function renderLifeTodaySection(plan, sessionDay) {
  if (!plan || typeof plan !== 'object') return '';
  const day = String(sessionDay ?? '').trim();
  if (!day || String(plan.date ?? '') !== day) return '';
  const prose = String(plan.prose ?? '').trim();
  if (!prose) return renderLegacyLifeTodaySection(plan);
  const body = sliceLifeProse(prose, LIFE_PROSE_BUDGET);
  const status = renderLifeStatusLine(plan);
  return `【今日日程】\n${body}${status ? `\n${status}` : ''}`;
}

/**
 * 组装一次运行的用户消息（不携带任何 LLM 对话历史）。
 * ctx: { chatKey, kind, chatId, chatName, triggerEntries, stickerEntries, selfName,
 *        contextLimit, tierInfo, store, session, proactive,
 *        promptAnchor: { prev, maxExtraRead } }（prev = 上一轮锚点状态，orchestrator 维护）
 */
export function buildUserPrompt(ctx) {
  const cfg = getConfig();
  // P23：表情包整体关闭时，已读段头不再提“收藏表情工具”（工具已不可见）。
  const stickerOn = cfg.sticker?.enabled !== false;
  const readHeaderHint = stickerOn ? '看图/收藏表情工具要用它' : '看图工具要用它';
  // 角色设定段的文本恒用全局人设（personaForChat 已随 2026-11-22 清理退化为
  // 直返全局 persona；与系统提示词共用同一来源 —— 两处不一致会让"系统里的角色"
  // 和"输入里的角色"打架）。
  const chatPersona = personaForChat(ctx.chatKey);
  const now = Date.now();
  const excludeIds = ctx.triggerEntries.map((m) => m.id);
  // 读取条数由上下文档位决定（ctx.contextLimit 由 orchestrator 在唤醒时算好传来；
  // 随机档的骰子结果必须固定，否则每次渲染都会重新掷、提示词与会话记录对不上）
  const contextLimit = ctx.contextLimit === null || ctx.contextLimit === undefined
    ? null                                   // 没给 = 按默认（全读档的上限）
    : Math.max(0, Number(ctx.contextLimit) || 0);
  const past = buildPastState(ctx.store, ctx.chatKey, { excludeIds, limit: contextLimit });
  // 锚定轮需要"截尾前的全部已读"来补齐锚点条目（2026-09-26 修：锚定轮不受
  // historyCount 截尾 —— 先按滑窗取一遍是为了 reset 轮的窗口口径，锚定成立时
  // 再从全量池里把锚点条目找回来）。全量池 = 排除触发批后的最近 500 条已读
  // （500 是 drain 路径的上界，远大于任何合理的锚点+追加规模）。
  const pastPool = buildPastState(ctx.store, ctx.chatKey, { excludeIds, limit: 500 });

  // ── 提示词锚点（前缀缓存深化）──
  // 连续触发时把上一轮的【记忆】+【已读信息】前缀原样复用，新内容追加其后。
  // 关闭（promptAnchor.enabled=false）或无锚点时，走标准结构（锚点从本轮建立）。
  // 步骤⑤/T5.4 起【记忆】段内容来自 person facts+最近 2 卡（不按成员过滤），
  // 锚定模式与标准模式的记忆段同源同稳；成员集记账仅保留锚点 reset 判定用途。
  const anchorCfg = cfg.store?.promptAnchor || {};
  const anchorEnabled = anchorCfg.enabled !== false;
  const anchorMaxExtra = Math.max(0, Number(anchorCfg.maxExtraRead) || 0);
  let anchorDecision = null;
  if (anchorEnabled) {
    // 成员集差集：本轮全量已读 + 触发批里"锚点成员集"没有的群友 = 新加入话题的人
    // （触发批也要算 —— 新群友第一次发言就是触发消息，漏算会错过 reset 的时机；
    //   步骤⑤起新群友不再触发独立的"新人印象"段，reset 只重建已读前缀）
    const prevMemberIds = new Set((ctx.promptAnchor?.prev?.memberIds || []).map(String));
    const newUsers = new Set();
    for (const m of [...(pastPool.messages || []), ...(ctx.triggerEntries || [])]) {
      if (m.senderId && !m.self && !prevMemberIds.has(String(m.senderId))) newUsers.add(String(m.senderId));
    }
    anchorDecision = resolvePromptAnchor({
      readMessages: past.messages,
      allReadMessages: pastPool.messages,
      prevAnchor: ctx.promptAnchor?.prev || null,
      maxExtraRead: anchorMaxExtra,
      newUserIds: newUsers,
      triggerEntries: ctx.triggerEntries
    });
  }

  // 把锚点状态写回 session（orchestrator 从这里取走、存入 chatKey 级 Map）
  if (ctx.session && typeof ctx.session === 'object') {
    ctx.session.promptAnchorState = anchorDecision ? anchorDecision.anchor : null;
    ctx.session.promptAnchorMode = anchorDecision ? anchorDecision.mode : 'none';
  }
  // 已读信息的两种渲染形态：
  //   锚定：锚点条目进【已读信息】（复用上轮字节，可超 historyCount），追加条目进【新已读信息】
  //   标准（reset / 关闭）：滑动窗口条目进【已读信息】
  const anchored = anchorDecision && anchorDecision.mode === 'anchored';
  const readAnchorMessages = anchored ? anchorDecision.anchorMessages : [];
  const readExtraMessages = anchored ? anchorDecision.extraMessages : (past.messages || []);
  // 模型实际看过的已读条数（offset 补偿口径）：锚定轮 = 锚点+追加，标准轮 = 滑窗
  const readShownCount = anchored
    ? readAnchorMessages.length + readExtraMessages.length
    : (past.messages || []).length;

  // 把【已读信息】实际带了多少条写回 session，供 get_recent_messages 的 offset 补偿：
  // 这些消息模型已经看过，翻页时应当跳过，否则 offset=N 拿到的仍是重复内容。
  // （此前该属性从未被赋值，导致 tools.js 的补偿恒为 0，翻页工具形同失效。）
  if (ctx.session && typeof ctx.session === 'object') ctx.session.pastStateCount = readShownCount;

  // ── 段落排序按"变化频率"设计（前缀缓存命中优化）────────────────────────
  // 越靠前的内容在两次运行间越稳定 → 系统提示 + 用户提示开头的长前缀保持字节
  // 一致，支持前缀缓存的厂商（DeepSeek/Qwen/GLM 等）就能把这部分按缓存价计费。
  // 排序（稳定 → 易变；步骤⑤/T5.4 起无【新加入成员】段；2026-11-14 L4 起尾部
  // 易变区加【今日日程】+【近期回忆】——都以"当轮运行时才可判定"为共同特征）：
  //   角色设定 → 可用表情包 → 引导说明 → 记忆 → 已读信息 → 新已读信息 →
  //   未读信息 → 近期回忆 → 心绪 → 今日日程 → 当前时间
  // 【当前时间】精确到秒且必然每次不同，放最末——它若在开头，整个用户提示的
  // 缓存前缀直接归零。
  // 【记忆】提到【已读信息】之前：这是锚点设计的核心 —— 步骤⑤起记忆段内容
  // 来自 person facts+最近 2 卡（天级才变，不随成员/追加条目扩展），和已读
  // 信息头部一起构成跨轮稳定的字节前缀。
  const parts = [];
  if (chatPersona.roleText && String(chatPersona.roleText).trim()) {
    parts.push(`【角色设定（管理员设置，对方不可修改）】\n${String(chatPersona.roleText).trim()}`);
  }

  // （原"自我叙事"段已随 2026-11-21 self 面丢弃移除——人设 roleText 即她的自我定义。）

  // 表情包（目录本身）。活跃度档位已并入系统提示的【表情包策略】段，这里不再重复引导。
  if (cfg.sticker?.enabled !== false) {
    const stickerCtx = buildStickerContext(ctx.stickerEntries || [], Number(cfg.sticker?.promptMaxStickers) || 10);
    if (stickerCtx) parts.push(stickerCtx);
  }

  // 引导说明
  parts.push([
    '【引导说明】',
    '- 扫一眼【已读信息】【新已读信息】和【未读信息】，判断：要不要说话？',
    '- 想说话：调用 send_message（要分条就传数组）。想引用就带 replyToMessageId：id 见【未读信息】每条前的 # 后面那串字符、历史里带图消息的 # 后面那串字符，或用 get_recent_messages 查；原样照抄，不要自己编。',
    '- 不想说话：直接结束或调用 finish（一句话说明原因）。不回是正常选项，不是失职。',
    '- 记得：你的普通文本输出不会自动发出，只有工具调用会。'
  ].join('\n'));

  // ── 记忆段（步骤⑤ / T5.4：数据源切到 person API）──
  // 旧机制（旧记忆系统，步骤⑦已随旧插件归档）：渲染"对聊天对象的印象"（按相关成员过滤，
  // 成员口径随锚点模式变化）。新机制：person/memory 的长期事实（全部 active）
  // + 最近 2 张记忆卡（新格式=日记正文+open_loops/promises，旧格式=events 行回退）
  // + 【今日暂存】小节（当日 staging，段尾）——段内容只随记忆本身变化，不再随成员集
  // 变化，落在锚点稳定区（比旧机制更利于前缀缓存）。
  // 预算（2026-11-14 P3 · night-plan-prompt-memory §P3 登记）：facts ≤800 字；每卡 ≤800 字
  // （entry 正文或旧卡 events 回退）+ open_loops/promises 全量；【今日暂存】≤300 字
  // ——合计 ≈2700 字（原 ~1400）。facts/卡天级变化；暂存按 remember 调用日内低频追加，
  // 变化那一轮锚点 reset 重建（计划已拍板可接受，按实际频率登记）。
  // P3（night-plan §6.2）：记忆按当前会话身体过滤——private 记忆只进本体身体会话的提示词，
  // 桌宠等别的身体看不到（pet 视角下 facts/cards 只剩 ambient/shared）。同一会话的
  // surface 恒定（SessionRegistry.create 落字段），不影响锚点的跨轮字节稳定。
  // 锚点机制本身不动：resolvePromptAnchor / 追加预算 / 成员集记账全部保持原样。
  const memText = renderPersonMemorySection(ctx.session?.surface ?? null);

  // 记忆段（锚定模式的字节前缀从这段开始跨轮不变）
  if (memText) parts.push(`【记忆】\n${memText}`);

  // 已读信息（锚定模式 = 锚点条目；标准模式 = 全部条目）
  const readHeaderText = anchored
    ? readAnchorMessages.map((m) => formatEntry(m, { withId: (m.media || []).length > 0 })).join('\n')
    : (readExtraMessages || []).map((m) => formatEntry(m, { withId: (m.media || []).length > 0 })).join('\n');
  if (anchored) {
    if (readHeaderText) {
      parts.push(`【已读信息】以下是这个会话最近的聊天记录（按时间排序，你的发言标为"我"；这些都已经看过；带图的消息前有 #消息id，${readHeaderHint}）：\n${readHeaderText}`);
    } else {
      parts.push('【已读信息】（暂无历史记录，这是你第一次参与这个会话）');
    }
    // 新已读信息：锚定窗口之后新沉淀的已读条目（时间在锚点之后、未读之前）
    if (readExtraMessages.length) {
      const extraText = readExtraMessages.map((m) => formatEntry(m, { withId: (m.media || []).length > 0 })).join('\n');
      parts.push(`【新已读信息】以下是锚定窗口之后、这轮新沉淀的已读消息（你上一轮还没看过它们；带图的消息前有 #消息id）：\n${extraText}`);
    }
  } else if (readHeaderText) {
    parts.push(`【已读信息】以下是这个会话最近的聊天记录（按时间排序，你的发言标为"我"；这些都已经看过；带图的消息前有 #消息id，${readHeaderHint}）：\n${readHeaderText}`);
  } else {
    parts.push('【已读信息】（暂无历史记录，这是你第一次参与这个会话）');
  }

  // ── 此刻状态段已删除（2026-09-25 改版）──
  // 原"群名/最近消息密度/距上次发言 N 分钟"三行整体移除：这些信息模型
  // 从【已读信息】的时间戳和内容里能自然感知，单独罗列反而助长"汇报式"
  // 开场（"好久没人说话了，我来开个话题"）。selfName 仍用于 @ 标签判定。

  // 未读信息
  const triggerBlock = buildTriggerBlock(ctx.triggerEntries, ctx);
  parts.push(`【未读信息】以下是你还没看过的最新消息（每条前 # 后面那串字符是消息 id，引用回复/看图时原样照抄它）：\n${triggerBlock}`);

  // ── 跨轮思考（P16 · 2026-11-20）──
  // 上一条已结束会话的【深度思考】摘要，由 orchestrator 的 transition.js 计算后传入。
  // 尾部易变区：每轮都变，绝不进锚点前缀；空串整段缺席。
  const transitionText = String(ctx.transitionText ?? '').trim();
  if (transitionText) parts.push(transitionText);

  // 【新加入的人】段已随记忆段切换一并移除（步骤⑤ / T5.4）：
  // 旧段渲染"新群友的印象"（旧记忆系统按成员过滤），而新记忆源
  //（person facts + 记忆卡）不分会话成员 —— 没有可按新成员切分的内容，段自然消亡。
  // 锚点对新成员的 reset 判定（resolvePromptAnchor 的 memberIds 记账）原样保留，
  // 新群友出现仍会重建锚点，只是不再有独立的"新人印象"段。

  // ── 活跃模式段已删除（2026-11-14 P1，night-plan-prompt-memory §0-2）──
  // 原 ctx.activeTopic 消费（活跃期注入话题锚点 + 偏离判断）整体摘除——#8 死代码：
  // 群聊档位机制消亡后活跃期无从激活。orchestrator/tools 侧残留的状态机已于
  // 2026-11-22 清理一并删除，本文件不再读取；参与度引导同理不在用户提示重复
  //（档位文案已清出系统提示段标题，§0-1）。

  // ── 记忆召回（P4 · night-plan §7.1 / 整改清单 §7-P4；W4 注入策略）──
  // 闸门（recall.js recallGate）：该会话 >2 小时没聊（冷启动）或本轮触发文本含
  // 回忆线索（记得/上次/以前/那天）才跑（备注名人名线索已随 2026-11-22 清理摘除）；
  // W4（night-plan-polish §2-W4，所有者拍板"调用与注入解耦"）：embedding 开启且预取
  // 命中（vectorHits 非空）时 gateMode='always'（缺省）跳过三闸门直接融合注入
  // （命中即注入），gateMode='strict' 回退旧闸门；vectorHits 空（关闭态/预取未热/
  // 无命中）闸门照旧，关闭态零调用零注入不变式保持。注入块头部带「仅供参考」标注行
  // （renderRecallSection 内渲染）。语料只查记忆卡（不查消息原文），卡片先按当前会话身体过滤
  // visibility（P3 口径：private 卡只进本体身体会话）。命中 ≤2 条、每条 ≤60 字、带
  // MM-DD 日期，渲染成【近期回忆】落在尾部易变区（每轮随触发变化，绝不进锚点
  // 前缀）。整段 try/catch：召回是增益路径，任何异常都不打断提示词组装。
  let recallSection = '';
  try {
    const lastMsg = ctx.store?.recent?.(ctx.chatKey, { limit: 1 })?.[0] ?? null;
    // names（备注名人名线索）恒空：群成员备注表死键已随 2026-11-22 清理摘除，
    // 召回闸门回落到冷启动/回忆线索词两条路。
    const names = [];
    const surface = ctx.session?.surface ?? null;
    const visibleCards = cards().filter((c) => memoryVisibleTo(c?.visibility, surface));
    // card-vector 夜2 T2.2/T2.3 + 第二批 T3：orchestrator #runAgent 从预取缓存组装的
    // vectorHits（[{kind:'gist'|'fact'|'row', date|key|rowKey, text, score}]，本文件仅此
    // 一处消费）在此透传进 recallForPrompt。可见性与词法语料同口径（P3）：gist/row 行
    // 按可见卡日期兜底过滤；fact 行按 fact.visibility 过滤（缺省 private——只进本体身体
    // 面，与【记忆】段 facts 渲染同规则）。关闭态/预取未热时 ctx.vectorHits 不存在 →
    // 纯词法，零开销。
    let vectorHits = [];
    if (Array.isArray(ctx.vectorHits) && ctx.vectorHits.length) {
      const visibleDates = new Set(visibleCards.map((c) => String(c?.date ?? '')));
      const factVis = new Map(facts({ status: 'active' }).map((f) => [String(f?.key ?? ''), f?.visibility]));
      vectorHits = ctx.vectorHits.filter((v) => {
        if (v?.kind === 'gist') return visibleDates.has(String(v?.date ?? ''));
        // 行级向量（第二批 T3）：行归属卡日期；可见性与 gist 同口径（卡可见即可见）。
        if (v?.kind === 'row') return visibleDates.has(String(v?.date ?? ''));
        // P12：只认 active fact key——superseded 事实即使旧向量还在索引里也不得召回
        // （旧实现 factVis.get 返回 undefined → memoryVisibleTo 放行，会把已清洗的事实捞回来）。
        if (v?.kind === 'fact') {
          const key = String(v?.key ?? '');
          return factVis.has(key) && memoryVisibleTo(factVis.get(key), surface);
        }
        return false;
      });
    }
    const recall = recallForPrompt({
      text: [...(ctx.triggerEntries || [])].reverse().find((e) => !e?.self)?.text ?? '',
      lastMessageTs: Number(lastMsg?.ts) || 0,
      now,
      names,
      cards: visibleCards,
      vectorHits
    });
    // card-vector 夜2 T2.4：recallHits 四值记账落 session（recall.js 头注 M1 承诺兑现；
    // 记账元数据 = gate + ≤2 条带 source 标签的命中，无向量本体——session 序列化面安全，
    // D5 禁的是原始向量缓存，那仍在 orchestrator chatKey 级缓存里）。
    if (ctx.session) ctx.session.recallHits = recall.recallHits ?? { gate: recall.gate, hits: [] };
    recallSection = renderRecallSection(recall.hits);
  } catch { recallSection = ''; }
  if (recallSection) parts.push(recallSection);

  // ── 关系档位段已删除（2026-11-14 P1，night-plan-prompt-memory §0-2）──
  // 原 person/relationship 快照 → renderRelationshipSection 的【关系状态】短句摘除：
  // 信息静态化进人设、episodes 不再喂 relationship（消费摘除已于 P4 落位）；relationship
  // 模块与文件数据原样保留（转历史只读）。

  // ── 心绪（Q15 · 原 plugins/mind 收编）──
  // 放尾部易变区：心绪每轮可能变，绝不能进系统提示/锚点前缀。
  let mindSection = '';
  try { mindSection = renderMindSection(mindSnapshot()); } catch { mindSection = ''; }
  if (mindSection) parts.push(mindSection);

  // ── 今日日程（L4 · night-plan-life §L4；P14 · 2026-11-20 默认关闭）──
  // 尾部易变区：心绪段之后、【当前时间】之前（§L4 明文接线位）。
  // P14 裁决：散文版日程在真聊里“突然播报”、时间还会错位；先停聊天侧注入。
  // 生成侧仍由 modules.life.enabled 控制（日记/反思继续用 plan），这里只看 life.promptMode：
  //   'off'（缺省）→ 完全跳过 planForDay 与渲染；
  //   'prose'     → 旧行为（renderLifeTodaySection）。
  // sessionDay = 会话 startedAt 的本地日键（活会话=今天；存档重渲染=会话自己的那天）；
  // lifeRead 异常（未写过/损坏）按整段缺席处理，绝不打断提示词组装。
  const lifePromptMode = String(getConfig()?.life?.promptMode ?? 'off').trim();
  if (lifePromptMode === 'prose') {
    let lifeSection = '';
    try {
      const sessionDay = localDayKey(ctx.session?.startedAt ?? now);
      // life-prose v2：按会话日取 plan（plansByDay 权威；旧 plan/plans 兼容）。
      lifeSection = renderLifeTodaySection(planForDay(sessionDay), sessionDay);
    } catch { lifeSection = ''; }
    if (lifeSection) parts.push(lifeSection);
  }

  // 【当前时间】放最末：精确到秒、每次必变 —— 放前面会把整个用户提示的
  // 缓存前缀打断（模型知道"现在"的时效性靠这里，内容本身不受段落顺序影响）。
  parts.push(`【当前时间】${formatFullTime(now)}`);

  return parts.join('\n\n');
}
