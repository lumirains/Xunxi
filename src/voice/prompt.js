// 语音专用提示词（call-mode 稿 §4；内部文档 asr-tts-v2-execution-spec.md §2.1 为契约）。
// V2 前半场 S8-③ 先行落地——**新文件未接线**：全仓无任何模块 import 本文件，
// replay 主链（buildSystemPrompt/buildUserPrompt）零字节交集 → 基线 IDENTICAL 零重冻结。
// V2 主体（src/voice/call.js）接线时消费 buildVoicePrompt + buildCallPreamble（后者随
// V2 主体补，见规格 §2.1 末段——通话开始一次轻量调用生成【你们今天聊过】）。
//
// 纪律（design §4.1 四条 + D14）：
//   · 无工具：通话模式不注册任何 tool，话就是模型输出本身，不经 send_message；
//   · 无思考：调用方传 skillContext.thinkingMode:'off'（llm.js context.thinkingMode
//     既有口径）——本文件只管提示词，请求形状在 call.js；
//   · **六段封顶**：段序固定一字一岗，任何新增内容必须挤掉同等预算的旧内容（D14 拍板）；
//     预算上限 config.voice.call.promptBudget（缺省 3000 tokens，按"中文 1 字≈1 token
//     上界"用字符数估），超限砍序=旧事卡 → 历史轮减半 → 段6 硬截；段 1/2/3 永不砍；
//   · 首句 ≤15 字靠两处：prompt 引导（voiceRules 第三条"十个字以内"）+ 服务端切句
//     兜底（src/voice/split.js R3，firstSentenceMaxChars=15）——不能只靠概率。
//
// 数据面：本文件只做纯函数（快照/卡由 call.js 取好传入）——不 import person/*、
// 不读 store，离线可测；.getConfig 是唯一依赖（config.js 模块加载零文件读取副作用，
// prompt.js 主链同款消费方式）。
import { getConfig } from '../config.js';

// ── 段 2 · 通话规则（design §4.3 全文草案，逐字照录不改写）───────────────────
// 段头不写【场景规则】（那是文字模式的段名），写【你在打电话】——段名本身就在定调。
export function voiceRules() {
  return [
    '【你在打电话】',
    '- 你在和他通电话。你说的话会被直接合成成声音，所以他只能听见你说了什么，看不见任何符号。',
    '- 一次说一到三句就停。不要长篇，不要分点，不要 Markdown，不要用括号写动作或表情。',
    '- 第一句要短，十个字以内。先把话接上，剩下的慢慢说。',
    '- 可以"嗯""啊""欸""那个……"，可以停顿，可以说"我想想"。真人不总是流畅的。',
    '- 听不清就问"你说什么"；没听懂就说没懂。不要猜，也不要假装听见了。',
    '- 不要说"我拿起杯子""我笑了笑"这类描述——他看不见你，只能听见你的声音。',
    '- 说错了可以自己改口："不对，我是说……"。',
    '- 这不是汇报。不要总结、不要分条、不要"首先其次最后"。'
  ].join('\n');
}

// ── 段 3 · 状态一行版（design §4.5）─────────────────────────────────────────
// 不复用 prompt.js 的 renderMindSection/renderLifeTodaySection——那些是带标题带分条
// 的多行段落，给文字模式写的。电话版四行无标题无分条：
//   【现在】
//   心绪：平静偏暖
//   今天：下午在改代码，晚上想早点睡
//   记得：怕黑 / 约好周末看展 / 不喜欢被叫小助手
// 规则：每行 ≤20 字（记得行按 §4.5 示例样张放宽到 ≤24——样张该行 25 字，20 装不下
// 三条 gist，见规格偏差登记）；缺项整行省略（不写"无"）；总长（含段头）≤80 字，超出
// 从末行起逐行舍弃；"记得"最多 3 条、来自记忆卡 gist 一行摘要；不做时间戳、
// 不做字段名中文化以外的加工。
//
// 派生规则（写死三条，不做打分——D18 派生纪律同款；关系行已随 2026-11-21
// relationship 整体丢弃移除，关系语境由人设静态承载）：
//   心绪行 = mind.mood.text 原文截 17（行首"心绪："3 字计在 20 内）；
//   今天行 = life plan（planForDay 当日返回值）未消费条目前 2 条 activity 原文以"，"连接；
//   记得行 = gists（MemoryCard.gist，person/contracts.js:84 ≤40 字）贪心填充。
export function renderVoiceState({ mind, life, gists } = {}) {
  const lines = [];

  const mood = String(mind?.mood?.text ?? '').trim();
  if (mood) lines.push(`心绪：${mood.slice(0, 17)}`);

  const items = Array.isArray(life?.items) ? life.items : [];
  const pending = items
    .filter((it) => it && !it.consumedAt && String(it?.activity ?? '').trim())
    .map((it) => String(it.activity).trim());
  if (pending.length) lines.push(`今天：${pending.slice(0, 2).join('，')}`.slice(0, 20));

  const gistList = (Array.isArray(gists) ? gists : []).map((g) => String(g ?? '').trim()).filter(Boolean);
  if (gistList.length) {
    let row = '记得：';
    for (const g of gistList.slice(0, 3)) {
      const sep = row.endsWith('：') ? '' : ' / ';
      if (row.length + sep.length + g.length <= 24) row += sep + g;
      else {
        const remain = 24 - row.length - sep.length;
        if (remain > 2) row += sep + g.slice(0, remain);
        break;
      }
    }
    lines.push(row);
  }

  while (lines.length && `【现在】\n${lines.join('\n')}`.length > 80) lines.pop();
  if (!lines.length) return '';
  return `【现在】\n${lines.join('\n')}`;
}

// ── 段表与预算（design §4.2；六段封顶 ≤3000 tokens）──────────────────────────
//
// | # | 段                 | 段头               | 预算        | 来源 |
// | 1 | 人设               | 【你是谁】         | 原样不精简  | persona.roleText |
// | 2 | 通话规则           | 【你在打电话】     | 200-300     | voiceRules() |
// | 3 | 状态一行版         | 【现在】           | 80-120      | renderVoiceState(state) |
// | 4 | 旧事卡             | 【旧事】           | 300-500     | cards（≤5 张 `- MM-DD gist`）|
// | 5 | 通话前摘要         | 【你们今天聊过】   | ≤300 字     | preamble（V2 主体生成）|
// | 6 | 通话内最近 8 轮原文| 【这通电话说到现在】| 500-800    | history（≤historyTurns 轮，每轮 ≤120 字）|
//
// ⚠️ 不要往里加【当前时间】或任何第七段——六段封顶是 D14 拍板（§4.1-3）。
//
// @param {object} [opts]
// @param {{botName?:string, roleText?:string}} [opts.persona] 缺省 getConfig().persona
// @param {{mind?:object, life?:object, gists?:string[]}} [opts.state]
//        快照包——call.js 取（mind.snapshot()/planForDay(今日)/最近卡的 gist），
//        本文件不读存储
// @param {Array<{date?:string, gist?:string, summary?:string}>} [opts.cards] 旧事卡（检索
//        结果，≤5 张生效；null/空 → 段 4 省略）
// @param {string} [opts.preamble] 通话前摘要（buildCallPreamble 产物，V2 主体接线）
// @param {Array<{who?:'user'|'me', text?:string}>} [opts.history] 通话内轮次（who=me 是
//        她说的；原文必须保留——§4.7 摘要会丢指代，电话里"你刚才说什么"最伤沉浸感）
// @returns {string}
export function buildVoicePrompt({ persona, state = null, cards = null, preamble = '', history = [] } = {}) {
  const cfg = persona ?? getConfig().persona;
  const voiceCfg = getConfig()?.voice?.call ?? {};

  const roleText = String(cfg?.roleText ?? '').trim();
  const seg1 = roleText ? `【你是谁】\n${roleText}` : '';
  const seg2 = voiceRules();
  const seg3 = renderVoiceState(state ?? {});

  const seg4Of = (list) => {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return '';
    const lines = arr.slice(0, 5).map((c) => {
      const date = String(c?.date ?? '');
      const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(5) : date;
      const body = clip(String(c?.gist ?? '').trim() || String(c?.summary ?? '').trim(), 60);
      return body ? `- ${day} ${body}` : '';
    }).filter(Boolean);
    return lines.length ? `【旧事】\n${lines.join('\n')}` : '';
  };
  const seg5Of = (pre) => {
    const t = clip(pre, 300);
    return t ? `【你们今天聊过】${t}` : '';
  };
  const seg6Of = (hist, turns) => {
    const lines = (Array.isArray(hist) ? hist.slice(-turns) : [])
      .map((h) => `${h?.who === 'me' ? '你' : '他'}：${clip(h?.text, 120)}`)
      .filter((l) => l.length > 3);
    return lines.length ? `【这通电话说到现在】\n${lines.join('\n')}` : '';
  };

  const budget = Number(voiceCfg.promptBudget) > 0 ? Number(voiceCfg.promptBudget) : 3000;
  const turns = Number(voiceCfg.historyTurns) > 0 ? Number(voiceCfg.historyTurns) : 8;
  let seg4 = seg4Of(cards);
  let seg5 = seg5Of(preamble);
  let seg6 = seg6Of(history, turns);

  const assemble = () => [seg1, seg2, seg3, seg4, seg5, seg6].filter(Boolean).join('\n\n');
  // 预算闸（§4.2 注"超了先砍记忆卡"）：砍段 4 → 历史轮数减半（保底 2 轮）→ 段 6 硬截
  if (assemble().length > budget) {
    seg4 = '';
    if (assemble().length > budget && Array.isArray(history) && history.length > 2) {
      seg6 = seg6Of(history, Math.max(2, Math.floor(history.length / 2)));
    }
    if (assemble().length > budget && seg6) {
      const without6 = [seg1, seg2, seg3, seg4, seg5].filter(Boolean).join('\n\n');
      const avail = budget - without6.length - 2;
      seg6 = avail > 40 ? seg6.slice(0, avail) : '';
    }
  }
  return assemble();
}

/** 预算截断（trim 后硬截——截断是预算纪律不是改写，不摘要不补标点）。 */
function clip(s, max) {
  const t = String(s ?? '').trim();
  return t.length <= max ? t : t.slice(0, max);
}
