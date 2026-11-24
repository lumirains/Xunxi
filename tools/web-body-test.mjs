// web 身体离线自测（夜间计划 W2，内部文档 web-body-plan.md §5 Step 2 断言清单 8 条）。
// 运行：node tools/web-body-test.mjs   （在 app 根 = Xunxi/resources/app 下；退出码 0=全过 / 1=有失败）
//
// 覆盖（plan Step 2 断言清单，T1–T8 一一对应）：
//   T1 capabilities：surface='web' 且九字段齐全（canVoice:true = V2 语音条链路已通，
//      闸在 config.voice 缺省关；canSticker:false 仍是真诚的能力声明）
//   T2 单条 text → {sent:[{text:'你好',...}],failed:[]} 铁律形状 + sent[0].at 是字符串
//      （T2c 顺序铁律：先 onSent 记档再 broadcast；T2d/T2e 交付报告与 SSE 载荷形状，
//        对齐 app.js:655 QQ recorder 与 :586 SSE emit——W4 装配的消费方契约）
//   T3 多段文本 → sent.length=2 且两次广播间隔 > 0（gapMs 分条节奏生效）
//   T4 空白文本 → sent 空数组、failed 非空（且零副作用）
//   T5 未知 type（sticker）→ 严格 {ok:false,error:'unsupported type'} 不抛（词表个体）
//   T6 缺 conversationId → {ok:false,...} 不抛
//   T7 call() → {ok:false,error:'web 身体不支持读回'} 不抛（web 纯出站，无读回）
//   T8 零网络：全程 fetch 计数为 0
//   T9 typing → broadcast('chat-typing',{on}) + {ok:true}（计划 8 条之外的补充：night-plan
//      §4 W2-2 的 adapter 纪律明列"typing 返回 {ok:true}"，无断言等于没守）
//   T11 发送去重（Q12 · night-plan §Q12：内容指纹对齐 SendQueue #isDuplicate 口径）：
//      同文二连发第二次不重复入 sent（零广播零记档，{sent:[],failed:[]}）；不同文本照发；
//      路由键 'web:main' 与裸存储键 'main' 同指纹互挡（指纹按存储键归一 = `main::${text}`）；
//      批内复读只发一条；广播失败不提前记账（原文重试照发）；窗口过期后可重发；
//      窗口 0 = 完全关闭（含批内复读照发）
//   T12 image 意图走 sender（Q12 发送链提取的行为证据）：广播带 mediaIds + onSent
//      type=image + 同图二连发第二次跳过（sender 去重管线）；顺序铁律在 image 分支同成立
//   T13 语音条 TTS（V2 · voice-walkie；§8.A 第四批准口的身体侧行为证据）：tts 注入
//      成功 → tts 在 onSent 之前调用（顺序铁律扩展为 tts→onSent→broadcast）+ onSent
//      载荷 media=[{kind:'audio',id}] + broadcast 载荷 audioIds:[id]（同条同档 1:1）；
//      tts null/抛异常 → 该段纯文字继续（载荷零 audioIds 键、不抛不整段失败）；不传
//      tts → 载荷与 V0 逐字节一致（零回归）；去重跳过的分条不合成
//   Z1 沙箱零写入：XUNXI_DATA_DIR 沙箱全程无文件产生（web adapter/sender 零副作用；
//      将来谁给身体加 store/文件写入，这闸就地拦下）
//   T10 会话键归一回归（storage v2 DB 版）：meta 预置旧键 → 写入 → 归一 main + 单一时间线
//      （W5 归一 + Q10 单一时间线的 DB 对应物：messages 单表、meta 恰两行、data/messages/
//        零文件；原文件机制断言退役对照表见内部文档 handoff-sqlite-v2.md 夜2 节）
//
// 照 tools/mock-adapter.mjs 头部做法：mkdtemp 沙箱放 os.tmpdir()（绝不碰真实 data/）+
// fetch 计数桩（默认掷错并计数）；不设 DRY_RUN（web 发送链无 DRY_RUN 入口——那是
// archived QQ sender 的环境闸）；env 先于 import；验完 finally 删沙箱。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');

// ── 沙箱数据根（绝不碰真实 data/）+ env 先于 import ─────────────────────────────
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'xunxi-web-body-test-'));
process.env.XUNXI_DATA_DIR = path.join(SANDBOX, 'data');
fs.mkdirSync(process.env.XUNXI_DATA_DIR, { recursive: true });

// ── 零网络硬闸（步骤⑤惯例）：默认 fetch 掷错并计数 ─────────────────────────────
let fetchCalls = 0;
globalThis.fetch = async (url) => {
  fetchCalls += 1;
  throw new Error(`ZERO-NETWORK：不该发生的 fetch → ${String(url)}`);
};

// ── 断言器（照 mock-adapter.mjs）──────────────────────────────────────────────
let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  PASS ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}`); }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), `${label}（got=${JSON.stringify(a)} want=${JSON.stringify(b)}）`); }
function section(name) { console.log(`\n── ${name} ──`); }

const imp = (...segs) => import(pathToFileURL(path.join(APP_ROOT, ...segs)).href);   // Windows 盘符路径必须转 file:// URL（mock-adapter 同款）

try {
  const { createWebAdapter } = await imp('src', 'surfaces', 'web', 'adapter.js');

  /** adapter + 桩工厂：trace 记录 onSent/broadcast 先后（顺序铁律证据），broadcastTimes 记墙钟（T3 节奏证据）。 */
  function makeAdapter() {
    const trace = [];           // 'onSent' | 'broadcast:<type>' 按发生序
    const broadcasts = [];      // [{ type, payload }]
    const sentReports = [];     // onSent 交付报告
    const broadcastTimes = [];  // 每次 broadcast 的 Date.now()
    const adapter = createWebAdapter({
      broadcast: (type, payload) => { trace.push(`broadcast:${type}`); broadcastTimes.push(Date.now()); broadcasts.push({ type, payload }); },
      onSent: (report) => { trace.push('onSent'); sentReports.push(report); }
    });
    return { adapter, trace, broadcasts, sentReports, broadcastTimes };
  }

  // ═══ T1 capabilities 九字段（plan 断言 1）═══
  section('T1 capabilities：surface=web 且字段齐全（canVoice:true=V2 语音条；canSticker:false 仍真诚）');
  {
    const { adapter } = makeAdapter();
    eq(adapter.capabilities(), {
      surface: 'web',
      canText: true, canVoice: true, canImage: true,
      canSticker: false, canAnimate: false, canTyping: true,
      maxTextLength: 8000, supportsReply: true
    }, 'T1 capabilities 逐字段（canVoice:true V2 语音条 TTS 链路已通——闸在 config.voice 缺省关，能力声明=链路非开关状态）');
    eq(adapter.surface, 'web', 'T1b adapter.surface = \'web\'');
  }

  // ═══ T2 单条 text（plan 断言 2 + 顺序铁律）═══
  section('T2 单条 text：{sent,failed} 铁律形状 + 先记档再广播');
  {
    const { adapter, trace, broadcasts, sentReports } = makeAdapter();
    const out = await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '你好' } });
    ok(Array.isArray(out.sent) && out.sent.length === 1 && out.sent[0].text === '你好'
      && Array.isArray(out.failed) && out.failed.length === 0,
      `T2 返回 {sent:[{text:'你好',...}],failed:[]}（got=${JSON.stringify(out)}）`);
    ok(typeof out.sent[0].at === 'string' && out.sent[0].at.length > 0
      && /^web-\d+-0$/.test(out.sent[0].messageId),
      `T2b sent[0].at 是字符串且 messageId=web-<ts>-<i>（got=${JSON.stringify(out.sent[0])}）`);
    eq(trace, ['onSent', 'broadcast:chat-message'], 'T2c 顺序铁律：先 onSent 记档再 broadcast（广播失败不丢档）');
    ok(sentReports.length === 1
      && sentReports[0].chatKey === 'web:main' && sentReports[0].type === 'text'
      && sentReports[0].archiveText === '你好' && sentReports[0].messageId === out.sent[0].messageId
      && typeof sentReports[0].ts === 'number',
      `T2d onSent 交付报告 {chatKey,type,archiveText,messageId,ts}（app.js:655 QQ recorder 同款消费形状）`);
    ok(broadcasts.length === 1 && broadcasts[0].type === 'chat-message'
      && broadcasts[0].payload.conversationId === 'web:main' && broadcasts[0].payload.role === 'self'
      && broadcasts[0].payload.text === '你好' && broadcasts[0].payload.messageId === out.sent[0].messageId
      && typeof broadcasts[0].payload.ts === 'number',
      `T2e broadcast('chat-message') 载荷 {conversationId,role:'self',text,ts,messageId}（SSE 消费形状）`);
  }

  // ═══ T3 多段文本 + 分条节奏（plan 断言 3）═══
  section('T3 多段文本：sent.length=2 且两次广播间隔 > 0');
  {
    const { adapter, broadcasts, broadcastTimes } = makeAdapter();
    const out = await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: ['第一句', '第二句'] } });
    ok(Array.isArray(out.sent) && out.sent.length === 2
      && out.sent[0].text === '第一句' && out.sent[1].text === '第二句',
      `T3 多段文本 sent.length=2 且保序（got=${JSON.stringify(out.sent?.map((s) => s.text) ?? out)}）`);
    ok(broadcasts.length === 2 && broadcastTimes[1] - broadcastTimes[0] > 0,
      `T3b 两次广播间隔 > 0（gapMs 分条节奏生效，got=${broadcastTimes[1] - broadcastTimes[0]}ms）`);
  }

  // ═══ T4 空白文本（plan 断言 4）═══
  section('T4 空白文本：sent 空、failed 非空、零副作用');
  {
    const { adapter, trace } = makeAdapter();
    const out = await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '  ' } });
    ok(Array.isArray(out.sent) && out.sent.length === 0 && Array.isArray(out.failed) && out.failed.length > 0,
      `T4 sent 为空数组、failed 非空（got=${JSON.stringify(out)}）`);
    eq(trace, [], 'T4b 空白文本零广播零记档（不产生任何副作用）');
  }

  // ═══ T5 未知 type（plan 断言 5）═══
  section('T5 未知 type：严格 unsupported 标记不抛（词表个体）');
  {
    const { adapter } = makeAdapter();
    eq(await adapter.emit({ type: 'sticker', conversationId: 'web:main', payload: {} }),
      { ok: false, error: 'unsupported type' }, 'T5 sticker → 严格 {ok:false,error:\'unsupported type\'}');
  }

  // ═══ T6 缺 conversationId（plan 断言 6）═══
  section('T6 缺 conversationId：{ok:false} 不抛');
  {
    const { adapter } = makeAdapter();
    const out = await adapter.emit({ type: 'text', payload: { text: 'x' } });   // 无 conversationId
    ok(out && out.ok === false && typeof out.error === 'string' && out.error.length > 0,
      `T6 返回 {ok:false,error} 而不抛（got=${JSON.stringify(out)}）`);
  }

  // ═══ T7 call() 无读回（plan 断言 7）═══
  section('T7 call()：{ok:false} 不抛（web 纯出站身体）');
  {
    const { adapter } = makeAdapter();
    const out = await adapter.call('anything', {});
    ok(out && out.ok === false && out.error === 'web 身体不支持读回',
      `T7 call('anything') → {ok:false,error:'web 身体不支持读回'} 而不抛（got=${JSON.stringify(out)}）`);
  }

  // ═══ T9 typing（计划 8 条外的补充：night-plan §4 W2-2 纪律"typing 返回 {ok:true}"）═══
  section('T9 typing：broadcast(chat-typing) + {ok:true}');
  {
    const { adapter, broadcasts } = makeAdapter();
    const on = await adapter.emit({ type: 'typing', conversationId: 'web:main', payload: { on: true } });
    eq(on, { ok: true }, 'T9 typing on:true → {ok:true}');
    eq(broadcasts, [{ type: 'chat-typing', payload: { conversationId: 'web:main', on: true } }],
      'T9b broadcast(\'chat-typing\') 载荷（前端三点动画事件源）');
    const off = await adapter.emit({ type: 'typing', conversationId: 'web:main', payload: { on: false } });
    ok(off?.ok === true && broadcasts[1]?.payload.on === false, `T9c typing on:false 透传（got=${JSON.stringify(broadcasts[1]?.payload)}）`);
  }

  // ═══ T11 发送去重（Q12 · night-plan §Q12：内容指纹对齐 SendQueue #isDuplicate 口径）═══
  section('T11 发送去重：窗口内同文二连发第二次不重复入 sent（不广播不记档）');
  {
    // T11a 同文二连发：第二次 {sent:[],failed:[]}，broadcast/存档计数停在 1
    {
      const { adapter, broadcasts, sentReports } = makeAdapter();
      const first = await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '重复文本' } });
      ok(first.sent.length === 1 && first.failed.length === 0, `T11a 首次发送成功入 sent（got=${JSON.stringify(first)}）`);
      const second = await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '重复文本' } });
      ok(Array.isArray(second.sent) && second.sent.length === 0 && Array.isArray(second.failed) && second.failed.length === 0,
        `T11a-2 同文二连发第二次不重复入 sent：{sent:[],failed:[]}（got=${JSON.stringify(second)}）`);
      ok(broadcasts.length === 1 && sentReports.length === 1,
        `T11a-3 第二次零广播零记档（broadcasts=${broadcasts.length} 存档=${sentReports.length}；sent↔broadcast↔存档 1:1 不变式保持）`);
    }
    // T11b 不同文本不受影响（指纹按内容，不是全局闸）
    {
      const { adapter, broadcasts } = makeAdapter();
      await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '甲' } });
      const out = await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '乙' } });
      ok(out.sent.length === 1 && broadcasts.length === 2, `T11b 不同文本照发（got=${JSON.stringify(out)}）`);
    }
    // T11c 跨前缀同指纹：路由键 'web:main' 与裸存储键 'main' 同指单一时间线（Q10 chatKey
    //      收敛），指纹按存储键归一 = `main::${text}`——前缀不同的两次同文照样互挡。
    {
      const { adapter, broadcasts } = makeAdapter();
      await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '跨前缀' } });
      const out = await adapter.emit({ type: 'text', conversationId: 'main', payload: { text: '跨前缀' } });
      ok(out.sent.length === 0 && out.failed.length === 0 && broadcasts.length === 1,
        `T11c 路由键/裸存储键同指纹互挡（got=${JSON.stringify(out)} broadcasts=${broadcasts.length}）`);
    }
    // T11d 批内复读：一次 emit 里 ['复读','复读'] 只发一条（计划先行判重）
    {
      const { adapter, broadcasts } = makeAdapter();
      const out = await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: ['复读', '复读'] } });
      ok(out.sent.length === 1 && out.sent[0]?.text === '复读' && broadcasts.length === 1,
        `T11d 批内复读只发一条（got=${JSON.stringify(out.sent)}）`);
    }
    // T11e 广播失败不提前记账：失败的那次不进去重窗口，原文重试照发（SendQueue 口径）
    {
      let boom = true;
      const broadcasts = [];
      const adapter = createWebAdapter({
        broadcast: (type) => { if (boom) throw new Error('广播炸了'); broadcasts.push(type); },
        onSent: () => {}
      });
      const failOut = await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '重试文本' } });
      ok(failOut.sent.length === 0 && failOut.failed.length === 1 && /广播炸了/.test(failOut.failed[0]?.error ?? ''),
        `T11e 广播抛错 → failed 如实回报（got=${JSON.stringify(failOut)}）`);
      boom = false;
      const retry = await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '重试文本' } });
      ok(retry.sent.length === 1 && broadcasts.length === 1,
        `T11e-2 失败后原文重试照发（未提前记账，got=${JSON.stringify(retry)}）`);
    }
    // T11f/T11g 窗口语义（直接构造 sender 注入窗口：生产路径走 config.send.dedupeWindowMs，
    // 构造参数仅供测试注入，显式数值优先）
    {
      const { createWebSender } = await imp('src', 'surfaces', 'web', 'sender.js');
      const mk = (win) => {
        const sends = [];
        const sender = createWebSender({ broadcast: (t, p) => sends.push({ t, p }), onSent: () => {}, dedupeWindowMs: win });
        return { sender, sends };
      };
      const { sender, sends } = mk(30);
      await sender.sendBatch('web:main', ['窗口过期']);
      await new Promise((r) => setTimeout(r, 60));   // > 窗口 30ms
      const again = await sender.sendBatch('web:main', ['窗口过期']);
      ok(again.sent.length === 1 && sends.length === 2,
        `T11f 窗口过期后同文可重发（got=${JSON.stringify(again.sent)} sends=${sends.length}）`);
      const off = mk(0);
      await off.sender.sendBatch('web:main', ['关闭去重']);
      const off2 = await off.sender.sendBatch('web:main', ['关闭去重']);
      ok(off2.sent.length === 1 && off.sends.length === 2,
        `T11g dedupeWindowMs=0 完全关闭去重（got=${JSON.stringify(off2.sent)} sends=${off.sends.length}）`);
      const offDup = await off.sender.sendBatch('web:main', ['批内', '批内']);
      ok(offDup.sent.length === 2, `T11g-2 窗口 0 时批内复读也照发（got=${offDup.sent?.length} 条）`);
    }
  }

  // ═══ T12 image 意图走 sender（Q12 发送链提取的行为证据）═══
  section('T12 image 意图走 sender：广播 mediaIds + onSent(type=image) + 同图二连发第二次跳过');
  {
    const { adapter, broadcasts, sentReports, trace } = makeAdapter();
    const out = await adapter.emit({ type: 'image', conversationId: 'web:main', payload: { mediaId: 'abcd1234abcd1234', note: '看这张' } });
    ok(out.sent.length === 1 && out.failed.length === 0 && out.sent[0].text === '看这张' && /^web-\d+-img$/.test(out.sent[0].messageId),
      `T12 image → {sent:[{text:note,messageId:web-<ts>-img}],failed:[]}（got=${JSON.stringify(out)}）`);
    eq(trace, ['onSent', 'broadcast:chat-message'], 'T12b 顺序铁律在 image 分支同样成立：先 onSent 记档再 broadcast');
    ok(broadcasts[0].payload.mediaIds?.[0] === 'abcd1234abcd1234' && broadcasts[0].payload.text === '看这张',
      `T12c 广播载荷带 mediaIds（Chat.vue 经 /api/media/<id> 读图，got=${JSON.stringify(broadcasts[0].payload)}）`);
    ok(sentReports[0].type === 'image' && sentReports[0].archiveText === '看这张',
      `T12d onSent 交付报告 type=image、archiveText=note（存档不落字节，E1）`);
    const again = await adapter.emit({ type: 'image', conversationId: 'web:main', payload: { mediaId: 'abcd1234abcd1234' } });
    ok(again.sent.length === 0 && again.failed.length === 0 && broadcasts.length === 1,
      `T12e 同图二连发第二次跳过（sender 去重管线 = image 走 sender 的行为证据，got=${JSON.stringify(again)}）`);
    await adapter.emit({ type: 'image', conversationId: 'web:main', payload: { mediaId: 'eeeeffffeeeeffff' } });
    ok(sentReports[1].archiveText === '[图片]',
      `T12f 无 note → 存档占位符 [图片]、广播 text 空（got=${JSON.stringify(sentReports[1])}）`);
  }

  // ═══ T13 语音条 TTS（V2 · voice-walkie；tts 装配注入的身体侧行为证据）═══
  section('T13 语音条 TTS：tts→onSent→broadcast 顺序 + media/audioIds 同条同档 + 失败纯文字回退');
  {
    /** tts 注入版 adapter 桩工厂（makeAdapter 的 tts 扩展；tts 调用也入 trace）。 */
    function makeTtsAdapter(tts) {
      const trace = [];
      const broadcasts = [];
      const sentReports = [];
      const adapter = createWebAdapter({
        broadcast: (type, payload) => { trace.push(`broadcast:${type}`); broadcasts.push({ type, payload }); },
        onSent: (report) => { trace.push('onSent'); sentReports.push(report); },
        tts: tts ? async (text) => { trace.push('tts'); return tts(text); } : undefined
      });
      return { adapter, trace, broadcasts, sentReports };
    }

    // T13a 成功路径：合成在 onSent/broadcast 之前，media/audioIds 同条同档（1:1 不变式）
    {
      const ttsLog = [];
      const { adapter, trace, broadcasts, sentReports } = makeTtsAdapter(async (text) => {
        ttsLog.push(text);
        return { mediaId: 'abcd1234abcd1234', mime: 'audio/wav' };
      });
      const out = await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '嗯，我在呢。' } });
      ok(out.sent.length === 1 && out.failed.length === 0,
        `T13a tts 成功 → {sent:1,failed:0}（返回形状铁律不变，got=${JSON.stringify(out)}）`);
      eq(trace, ['tts', 'onSent', 'broadcast:chat-message'],
        'T13b 顺序铁律扩展：tts 合成在 onSent 记档之前（每段在 onSent/broadcast 之前合成）');
      eq(sentReports[0].media, [{ kind: 'audio', id: 'abcd1234abcd1234' }],
        'T13c onSent 载荷带 media=[{kind,id}]（E1 只存 id；元素形状与入站 attachments/entryAudioIds 同款）');
      eq(broadcasts[0].payload.audioIds, ['abcd1234abcd1234'],
        'T13d broadcast 载荷带 audioIds:[id]（sse.ts ChatMessagePayload 消费形状）');
      ok(sentReports[0].archiveText === '嗯，我在呢。',
        'T13e 存档文本不加尾注（音频与文字同条同档——text 本身就是 TTS 源，与图片 [图片] 尾注不同理）');
      eq(ttsLog, ['嗯，我在呢。'], 'T13f tts 每个计划分条恰调一次');
    }

    // T13b 失败路径：tts 返回 null / 抛异常 → 该段纯文字继续（不抛不整段失败）
    {
      const { adapter, broadcasts, sentReports } = makeTtsAdapter(async () => null);
      const out = await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '纯文字' } });
      ok(out.sent.length === 1 && out.failed.length === 0 && out.sent[0].text === '纯文字',
        `T13g tts null → 纯文字继续（{sent:1,failed:0}，got=${JSON.stringify(out)}）`);
      ok(!('audioIds' in broadcasts[0].payload) && !('media' in sentReports[0]),
        'T13h 失败段载荷零 audioIds/media 键（形状与 V0 逐字节一致）');
      const thrown = makeTtsAdapter(async () => { throw new Error('tts-boom'); });
      const out2 = await thrown.adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '再试' } });
      ok(out2.sent.length === 1 && out2.failed.length === 0,
        `T13i tts 抛异常 → 该段纯文字继续不外抛（got=${JSON.stringify(out2)}）`);
    }

    // T13c 零回归：不传 tts → 载荷与 V0 逐字节一致；去重跳过的分条不合成
    {
      const { adapter, broadcasts } = makeAdapter();
      await adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '无注入' } });
      eq(Object.keys(broadcasts[0].payload).sort(), ['conversationId', 'messageId', 'role', 'text', 'ts'],
        'T13j 不传 tts → 广播载荷键集与 V0 逐字节一致（零回归）');
      const ttsLog = [];
      const dedupe = makeTtsAdapter(async (text) => { ttsLog.push(text); return { mediaId: 'aaaa1111aaaa1111', mime: 'audio/wav' }; });
      await dedupe.adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '复读' } });
      const second = await dedupe.adapter.emit({ type: 'text', conversationId: 'web:main', payload: { text: '复读' } });
      ok(second.sent.length === 0 && second.failed.length === 0 && dedupe.broadcasts.length === 1,
        `T13k 去重跳过的分条零广播（T11 管线在 tts 注入下不变，got=${JSON.stringify(second)}）`);
      eq(ttsLog, ['复读'], 'T13l 被去重跳过的第二次不合成（只对实际发送的计划分条合成）');
    }
  }

  // ── 零网络总闸 + 沙箱零写入 ──
  section('零网络总闸与沙箱零写入');
  eq(fetchCalls, 0, 'T8 全程零 fetch 调用（fetch 计数桩，plan 断言 8）');
  eq(fs.readdirSync(SANDBOX), ['data'], 'Z1 沙箱内只有测试自建的 data 目录（web adapter 零副作用）');
  eq(fs.readdirSync(process.env.XUNXI_DATA_DIR), [], 'Z1b XUNXI_DATA_DIR data/ 零写入');

  // ═══ T10 会话键归一回归（storage v2 DB 版；W5 修复口径延续 + Q10 单一时间线收敛）═══
  // V2 起存储后端 = SQLite（main.json 文件机制退役）。原"改名文件内嵌旧键 chatKey"的
  // 场景改为 meta 表预置旧键（'web:main'，迁移残留形态）+ 一条历史行。回归语义不变：
  //   · 无论 meta 存什么旧键，载入与写入一律归一存储键 'main'（W5 教训）；
  //   · 单一时间线 = messages 单表 + meta 恰 chatKey/nextLocalId 两行（单文件断言的对应物）；
  //   · data/messages/ 目录不再产生（写路径绝不落文件的负断言）。
  section('T10 会话键归一回归（DB 版）：meta 旧键载入 → 写入 → 归一 main + 单一时间线');
  {
    const SANDBOX2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xunxi-web-body-migrate-'));
    let dbmod = null;
    try {
      process.env.XUNXI_DATA_DIR = path.join(SANDBOX2, 'data');   // config.js 在首次 import 期解析 DATA_DIR
      const { ChatStore } = await imp('src', 'kernel', 'store.js');  // 此刻才首次 import（facade → store.js → storage/db.js → config.js）
      dbmod = await imp('src', 'storage', 'db.js');
      const db = dbmod.getDb();
      db.prepare('INSERT INTO messages (id, mid, ts, self, senderId, senderName, text, reply, media, isPoke, atMe, atNames, read, day, seq, recalled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(1, null, 1, 0, '10000', '旧', '历史消息', null, '[]', 0, null, '[]', 1, '1970-01-01', 1, null);
      db.prepare("INSERT INTO meta (key, value) VALUES ('chatKey', 'web:main')").run();   // 旧键（迁移残留形态）
      db.prepare("INSERT INTO meta (key, value) VALUES ('nextLocalId', '2')").run();
      const store2 = new ChatStore(0);
      ok(JSON.stringify(store2.listChats()) === '["main"]', `T10a listChats() = ['main']（单一时间线，got=${JSON.stringify(store2.listChats())}）`);
      const entry = store2.appendIncoming('main', { mid: 42, ts: 2, senderId: 'owner', senderName: '我', text: '迁移后第一条' });
      ok(entry != null, 'T10b 旧键 meta 下的时间线能在 main 键下加载并入库');
      ok(store2.recent('main', { limit: 10 }).length === 2, `T10c 历史与新消息同档（got=${store2.recent('main', { limit: 10 }).length} want=2）`);
      eq(dbmod.getMeta('chatKey'), 'main', 'T10d 写入后存储键已归一为 main（原：保存后文件内嵌 chatKey 归一）');
      ok(!fs.existsSync(path.join(SANDBOX2, 'data', 'messages')) && !fs.existsSync(path.join(SANDBOX2, 'data', 'web_main.json')),
        'T10e 文件机制退役：写路径绝不落 data/messages/（原：旧文件名不复活）');
      eq([db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key IN ('chatKey', 'nextLocalId')").get().n],
        [2, 2], 'T10f 单一时间线：messages 单表 2 行 + meta 恰两行（原：data/messages/ 单文件）');
      ok(store2.recent('web:main', { limit: 10 }).length === 2,
        'T10g 旧路由键形参同落单一时间线（store 键盲，路由键/存储键分离）');
    } finally {
      if (dbmod) { try { dbmod.closeDb(); } catch { /* 已关闭 */ } }
      fs.rmSync(SANDBOX2, { recursive: true, force: true });   // Windows 文件锁：删沙箱前必须先关 DB 连接
    }
  }

  console.log(`\n${failures.length ? 'WEB-BODY SELFTEST FAILED' : 'WEB-BODY SELFTEST OK'}：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length) for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true });   // 验完删沙箱（os.tmpdir() 下，不在仓库内）
}
