// 语音切句器（call-mode §5.2 全规则；内部文档 asr-tts-v2-execution-spec.md §2.2 R1-R7）。
// V2 前半场 S8-② 先行落地——**纯函数、零 import、未接线**（消费方=V2 主体 src/voice/call.js）。
//
// 职责：LLM 整段文本 → { index, text, isFirst }[]，供 TTS 队列逐句合成。
// 纪律（design §5.2 原文）：**只切不改**——不补标点、不删语气词，她说的每个字都要被
// 念出来；段拼接与输入**逐字节全等**（唯一例外：纯空白/无实词输入返回 []，无可念内容）。
//
// 规则表（规格 §2.2 为契约，tools/voice-split-test.mjs 全覆盖）：
//   R1 强切点   。！？；…  .!?;  换行（\n \r）——命中即切，标点随左段
//   R2 弱切点   ，、, —— 仅当前缓冲 >18 字才切；数字千分位（点/逗号前后皆数字）不切
//   R3 首句特判 首段缓冲达 15 字强制切：优先窗口内最后一个弱切点，无则硬切 15 字
//   R4 强制切   缓冲 >25 字：兜底链 = 最后弱切点 > 最近空格 > 最近连词（切在连词前）
//               > 硬切 20 字（规格 §0.2-5 澄清：缓冲残留弱切点时按弱切点切优于词中硬切）
//   R5 不切     引号内（CJK 配对「」『』“”‘’ + 直引号 " 配对）强/弱/强制全不切——
//               硬切/弱切落点若把一对引号撕开，自动右移到闭引号之后（引号段原子）；
//               小数点（点前后皆数字）；英文缩写（Mr./e.g./etc.… 词根命中表，含 e.g. 内部点）
//   R6 尾句合并 末段非空白字符 <8 字并入前段（单段不并）——与 R3 的交互是已知取舍：
//               15-23 字无标点短句会被并回单段（实测合成耗时与句长几乎无关——call-mode
//               §3.1 修正注，单段不损首声延迟，规格登记照此实现）
//   R7 保序不丢字不改写  段拼接 === 输入；不补标点不删语气词，只切不改
//
// 边界约定：硬切/弱切落点落在数字串中间时右移到该数字串末尾（宁超预算不撕数字）；
// 直引号 ' 不参与配对（英文撇号 it's 会误开引号，风险大于收益）；首段含前导标点/
// 空白（无实词入头）时 15 字窗口按含标点计——契约只有"逐字节全等"是硬的，窗口近似。

const STRONG = new Set(['。', '！', '？', '；', '…', '.', '!', '?', ';', '\n', '\r']);
const WEAK = new Set(['，', '、', ',']);
const QUOTE_OPEN = new Set(['「', '『', '“', '‘']);
const QUOTE_CLOSE = new Map([
  ['」', '「'],
  ['』', '『'],
  ['”', '“'],
  ['’', '‘']
]);
const SPACES = new Set([' ', '\t', '　']);
// 连词表（保守集：只收切了明显更顺口的；命中即"切在连词前"，连词归下一段开头）
const CONNECTORS = ['但是', '可是', '不过', '然而', '因为', '所以', '而且', '然后', '于是', '虽然', '如果', '就是'];
// 英文缩写词根（小写；'e.g'/'i.e'/'u.s' 含内部点——反向收集时点也收进来）
const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'eg', 'ie', 'no',
  'jr', 'sr', 'inc', 'ltd', 'co', 'fig', 'e.g', 'i.e', 'u.s', 'u.k'
]);

// 阈值（design §5.2 / config.voice.call.firstSentenceMaxChars 对应；可覆写供测试）
const D = { firstMax: 15, weakMin: 18, forceMax: 25, hardCut: 20, tailMin: 8 };

const digit = (c) => /\d/.test(c ?? '');
const wordish = (c) => /[A-Za-z.]/.test(c ?? '');
const hasWord = (s) => /[\p{L}\p{N}]/u.test(s);

/** 缓冲内最后一个可用的弱切点下标（跳过千分位；maxIdx 限定搜索窗口）。 */
function lastWeakIn(s, maxIdx = s.length) {
  const hi = Math.min(maxIdx, s.length);
  for (let i = hi - 1; i >= 0; i--) {
    if (!WEAK.has(s[i])) continue;
    if (digit(s[i - 1]) && digit(s[i + 1])) continue;   // 千分位
    return i;
  }
  return -1;
}

/** '.' 是否受保护（小数点：前后皆数字；英文缩写：点前词根命中表 / e.g. 内部点）。 */
function dotProtected(text, i) {
  if (digit(text[i - 1]) && digit(text[i + 1])) return true;
  // e.g. / i.e. 的第一个点：点后单字母再跟点（防 "e." "g." 被撕开）
  if (/[a-z]/.test(text[i + 1] ?? '') && text[i + 2] === '.') return true;
  let j = i - 1;
  let word = '';
  while (j >= 0 && wordish(text[j])) { word = text[j] + word; j -= 1; }
  return ABBREV.has(word.replace(/\.+$/, '').toLowerCase());
}

/**
 * 切句（纯函数）。
 * @param {string} text 待切的整段文本（原样，不预处理）
 * @param {{firstMax?:number, weakMin?:number, forceMax?:number, hardCut?:number, tailMin?:number}} [opts]
 * @returns {{index:number, text:string, isFirst:boolean}[]}
 */
export function splitForSpeech(text, opts = {}) {
  const { firstMax, weakMin, forceMax, hardCut, tailMin } = { ...D, ...opts };
  if (typeof text !== 'string' || !text) return [];

  const out = [];
  let buf = '';
  const quoteStack = [];   // CJK 引号配对栈
  let straightDq = false;  // 直引号 " 配对开关
  const inQuote = () => quoteStack.length > 0 || straightDq;

  /** 把 buf 收尾：有实词 → 新段；纯标点/空白 → 并入前段（无前段则留在 buf 随下段走）。 */
  const flush = () => {
    if (!buf) return;
    if (hasWord(buf)) { out.push(buf); buf = ''; }
    else if (out.length) { out[out.length - 1] += buf; buf = ''; }
  };

  /** 在 idx（含）后切：左段有实词成段，纯标点并入前段，否则回贴 buf（保字节）。 */
  const cutAfter = (idx) => {
    if (idx < 0) idx = 0;
    if (idx >= buf.length) { flush(); return; }
    const left = buf.slice(0, idx + 1);
    buf = buf.slice(idx + 1);
    if (hasWord(left)) out.push(left);
    else if (out.length) out[out.length - 1] += left;
    else buf = left + buf;   // 防御：无实词且无前段——回贴，绝不丢字
  };

  /** 切点引号保护：左段若把引号对撕开，右移切点到闭引号之后；找不到则放弃本次切。 */
  const balancedCut = (idx) => {
    let depth = 0;
    let dq = false;
    for (let k = 0; k <= Math.min(idx, buf.length - 1); k += 1) {
      const c = buf[k];
      if (QUOTE_OPEN.has(c)) depth += 1;
      else if (QUOTE_CLOSE.has(c)) { if (depth) depth -= 1; }
      else if (c === '"') dq = !dq;
    }
    if (depth > 0 || dq) {
      let j = Math.min(idx, buf.length - 1) + 1;
      while (j < buf.length && !QUOTE_CLOSE.has(buf[j]) && buf[j] !== '"') j += 1;
      if (j >= buf.length) return;   // 理论不可达（本函数只在 inQuote()=false 时被调）；防御
      cutAfter(j);
      return;
    }
    cutAfter(idx);
  };

  /** 硬切（数字保护）：切点落在数字串中间时右移到该数字串末尾。 */
  const hardCutAt = (idx) => {
    let i = idx;
    while (i + 1 < buf.length && digit(buf[i]) && digit(buf[i + 1])) i += 1;
    balancedCut(i);
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    buf += ch;

    // 引号状态（在切点判定前更新）
    if (QUOTE_OPEN.has(ch)) quoteStack.push(ch);
    else if (QUOTE_CLOSE.has(ch)) {
      if (quoteStack[quoteStack.length - 1] === QUOTE_CLOSE.get(ch)) quoteStack.pop();
    } else if (ch === '"') straightDq = !straightDq;

    if (inQuote()) continue;

    // R1 强切点（'.' 的小数点/缩写保护）
    if (STRONG.has(ch)) {
      if (ch === '.' && dotProtected(text, i)) continue;
      flush();
      continue;
    }

    // R3 首句特判（首段缓冲达 firstMax 强制切；引号延迟期间顺延）
    if (out.length === 0 && buf.length >= firstMax) {
      const w = lastWeakIn(buf, firstMax);
      if (w >= 0) balancedCut(w);
      else hardCutAt(firstMax - 1);
      continue;
    }

    // R4 强制切（缓冲 > forceMax：弱切点 > 空格 > 连词 > 硬切）
    if (buf.length > forceMax) {
      const w = lastWeakIn(buf);
      if (w >= 0) { balancedCut(w); continue; }
      let sp = -1;
      for (let j = buf.length - 1; j >= 0; j -= 1) { if (SPACES.has(buf[j])) { sp = j; break; } }
      if (sp >= 0) { balancedCut(sp); continue; }
      let cp = -1;
      for (const c of CONNECTORS) {
        const k = buf.lastIndexOf(c);
        if (k > cp) cp = k;
      }
      if (cp > 0) { balancedCut(cp - 1); continue; }
      hardCutAt(hardCut - 1);
      continue;
    }

    // R2 弱切点（仅缓冲 > weakMin；千分位不切——next 取原文下一字符，逗号刚到时下一字符未入 buf）
    if (WEAK.has(ch) && buf.length > weakMin && !(digit(buf[buf.length - 2]) && digit(text[i + 1]))) {
      flush();
    }
  }
  flush();

  // R6 尾句合并（末段非空白字符 < tailMin 并入前段；单段不并）
  if (out.length >= 2) {
    const last = out[out.length - 1];
    if (last.replace(/\s+/g, '').length < tailMin) {
      out.pop();
      out[out.length - 1] += last;
    }
  }

  return out.map((t, index) => ({ index, text: t, isFirst: index === 0 }));
}
