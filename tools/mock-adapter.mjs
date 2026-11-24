// Phase 8b 出站接线自测（Q11 起 web-only 新基线）：tools.js 调用点走 ctx.emit / ctx.surface
// —— 零网络、形状不变。QQ 身体断言段（原 C/D/E 的 sender 翻译、F 的 normalize）随身体
// 归档（legacy/qq-adapter）改写为 web 身体断言（断言前提死亡随整改移除 + web 翻译覆盖，
// 加严不弱化口径同 Q7 hostbridge E 段先例）。
// 运行：node tools/mock-adapter.mjs   （在 app 根 = Xunxi/resources/app 下；退出码 0=全过 / 1=有失败）
//
// 覆盖（T8a 规格 + 8b 转换后口径 + Q11 web-only）：
//   A contracts 冻结常量            SURFACES=['web']（Q11：QQ 身体归档后唯一在册）、
//                                  INTENT_TYPES 七值，均 Object.freeze
//   B registry 前缀路由（D18）      pet:/diary:/web: → 对应身体；无前缀（含 private:/group:/
//                                  裸串/空串）→ 默认 web（Q11 起 DEFAULT_SURFACE='web'）；未注册抛错
//   C 现役工具 × ctx.emit 出站接线  假 ctx 与 orchestrator 接线同构（字符串=UI 事件旁路；intent
//                                  对象=registry 前缀路由，M1/D19 不覆盖显式 conversationId）；
//                                  身体 = 真 createWebAdapter（surface 'web'），发送边界 =
//                                  onSent 存档回报 + SSE broadcast（app.js 装配同款形状）——
//                                  工具只产生 intent、零网络；发送边界
//                                  {sent:[{text,messageId,at}],failed:[]} 形状不变（坑 #9）
//   D 身体层拒收路径                空 text → {sent:[],failed:[{error:'消息内容为空'}]}；
//                                  缺 conversationId → {ok:false,error}；attachments 项不合法
//                                  在工具层就拒收（零 intent 零广播）
//   E web 身体 emit 翻译            text/image/typing 参数与返回形状逐字节透传（坑 #9；
//                                  顺序铁律：先 onSent 记档再 broadcast）；不认识的 type →
//                                  {ok:false,error:'unsupported type'}；call → 不支持读回
//   F web 身体纯出站                无 normalize / 无 expandForward（入站与读回展开均不存在）
//   G surface 标注（P3 + W1，Q6+Q8 收缩基线）
//                                  QQ 专属工具四删 + 四去标注 → 断言「无工具带 surface:['qq']」；
//                                  表情知识层三工具 pet 会话可用；缺省 fail-open；registry 注册
//                                  路径同吃过滤（G4 探针）；工具 ctx 无发送/协议句柄键
//
// tools.js 调用点已于 Phase 8b 切换（拆分表 #7），本测试直接验证转换后契约的全链：
// 工具发 intent（不带 id——当前无消费方，io 信封的 intentId 属 brain.submit 写路径）
// → ctx.emit 补 conversationId → 身体翻译成发送链 —— 全链参数与身体实现逐字段一致。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');

// ── 沙箱数据根（绝不碰真实 data/）+ env 先于 import（模块在 eval 期读 env）──────
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'xunxi-mock-adapter-'));
process.env.XUNXI_DATA_DIR = path.join(SANDBOX, 'data');
fs.mkdirSync(process.env.XUNXI_DATA_DIR, { recursive: true });

// ── 零网络硬闸（步骤⑤惯例）：默认 fetch 掷错并计数 ─────────────────────────────
let fetchCalls = 0;
globalThis.fetch = async (url) => {
  fetchCalls += 1;
  throw new Error(`ZERO-NETWORK：不该发生的 fetch → ${String(url)}`);
};

// ── 断言器 ───────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  PASS ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}`); }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), `${label}（got=${JSON.stringify(a)} want=${JSON.stringify(b)}）`); }
function section(name) { console.log(`\n── ${name} ──`); }
async function expectThrow(fn, re, label) {
  try { await fn(); ok(false, `${label}（没有抛错）`); }
  catch (error) { ok(re ? re.test(String(error?.message ?? error)) : true, `${label}（msg=${String(error?.message ?? error).slice(0, 80)}）`); }
}

const imp = (...segs) => import(pathToFileURL(path.join(APP_ROOT, ...segs)).href);   // Windows 盘符路径必须转 file:// URL（步骤④实测教训）

try {
  const { buildToolDefs } = await imp('src', 'tools.js');
  const { getTool, registerTool, unregisterTool, getToolAvailability } = await imp('src', 'tool-registry.js');
  const contracts = await imp('src', 'surfaces', 'contracts.js');
  const { createAdapterRegistry } = await imp('src', 'surfaces', 'registry.js');
  const { createMockAdapter } = await imp('src', 'surfaces', 'mock', 'adapter.js');
  const { createWebAdapter } = await imp('src', 'surfaces', 'web', 'adapter.js');

  // Q6+Q8：跨会话发送开关随 send_to 工具消亡；本测试验 QQ 专属工具已摘除 + web 身体
  // 出站契约的新基线。
  buildToolDefs();   // 幂等注册全部内置工具（插件工具由 app.js 启动时装载，本测试不需要）
  const send = getTool('send_message');
  ok(!!send && typeof send.execute === 'function', 'P0 send_message 已注册且带 execute');

  // ═══ A. contracts 冻结常量 ═══
  section('A. contracts 冻结常量');
  eq(contracts.SURFACES, ['web'], 'A1 SURFACES = [\'web\']（Q11：QQ 身体归档后唯一在册）');
  eq(contracts.INTENT_TYPES, ['text', 'sticker', 'image', 'typing', 'poke', 'reaction', 'diary'], 'A2 INTENT_TYPES 七值（登记合集）');
  ok(Object.isFrozen(contracts.SURFACES), 'A3 SURFACES 已冻结');
  ok(Object.isFrozen(contracts.INTENT_TYPES), 'A4 INTENT_TYPES 已冻结');
  ok(!('InboundEvent' in contracts), 'A5 只有常量与 typedef，零实现（typedef 不出现在运行时）');

  // ═══ B. registry 前缀路由 ═══
  section('B. registry 前缀路由（D18；Q11 起默认身体 = web）');
  {
    const reg = createAdapterRegistry();
    const webStub = { surface: 'web', capabilities: () => ({}), async emit() { return {}; } };
    const petStub = { surface: 'pet', capabilities: () => ({}), async emit() { return {}; } };
    const diaryStub = { surface: 'diary', capabilities: () => ({}), async emit() { return {}; } };
    reg.register(webStub); reg.register(petStub); reg.register(diaryStub);
    ok(reg.route('pet:default') === petStub, 'B1 pet: 前缀 → pet 身体');
    ok(reg.route('diary:2026-11-08') === diaryStub, 'B2 diary: 前缀 → diary 身体');
    ok(reg.route('web:main') === webStub, 'B3 web: 前缀 → web 身体（路由键真实形态）');
    ok(reg.route('private:123') === webStub, 'B4 历史 private: → 默认 web（历史键值零迁移，store 键盲）');
    ok(reg.route('group:456') === webStub, 'B5 历史 group: → 默认 web');
    ok(reg.route('main') === webStub, 'B6 Q10 裸存储键 → 默认 web（§9-19-9 边界消亡的实证形态）');
    ok(reg.route('') === webStub, 'B7 空串 → 默认 web');
    ok(reg.route('bogus:1') === webStub, 'B8 未知前缀按"无前缀"处理 → 默认 web（D18：前缀表只认 pet:/diary:/web:）');
    ok(reg.get('web') === webStub && reg.get('pet') === petStub, 'B9 get 按注册实例返回');
    ok(reg.get('nope') === null, 'B10 get 未注册 → null');
    eq(reg.list().map((b) => b.surface).sort(), ['diary', 'pet', 'web'], 'B11 list 列出全部已注册身体');
    const reg2 = createAdapterRegistry();
    await expectThrow(() => Promise.resolve().then(() => reg2.route('pet:default')), /pet/, 'B12 默认身体缺失：pet: 路由抛错并点名 pet');
    await expectThrow(() => Promise.resolve().then(() => reg2.route('main')), /web/, 'B13 默认身体缺失：无前缀路由抛错并点名 web');
  }

  // ═══ C. 现役工具 × ctx.emit 出站接线（web 身体；只产生 intent、零网络、形状不变）═══
  section('C. 现役工具 × ctx.emit 出站接线（web 身体 + 存档/广播边界；形状不变）');

  /**
   * 假 ctx 工厂（与 orchestrator 出站接线同构）。
   * ctx.emit 双分流：字符串 = 旧 UI 事件（'session-update'/'feedback'）旁路记录；
   * intent 对象 = registry 前缀路由（M1/D19：intent 未带 conversationId 才补 ctx.chatKey）。
   * 身体 = 真 createWebAdapter（surface 'web'）注册进测试内独立 registry（不动全局单例）；
   * 发送边界登记：onSent（存档回报，app.js 装配同款参数）+ broadcast（SSE 载荷），
   * 并记录进身体的 intent。ctx.surface 来自 mock 身体（读回空容忍，草案 §4 规则 4）。
   */
  function makeCtx(overrides = {}) {
    const mock = createMockAdapter();
    const uiEvents = [];
    const intents = [];      // ctx.emit 实际发进身体的 intent（补 conversationId 后）
    const broadcasts = [];   // 身体发出的 SSE 载荷
    const sentArchives = []; // 身体的 onSent 存档回报
    const webBody = createWebAdapter({
      broadcast: (type, payload) => broadcasts.push({ type, payload }),
      onSent: (report) => sentArchives.push(report)
    });
    const reg = createAdapterRegistry();
    reg.register(webBody);
    const baseEmit = webBody.emit.bind(webBody);
    webBody.emit = async (intent) => { intents.push(intent); return baseEmit(intent); };   // 记录进身体的 intent
    const ctx = {
      chatKey: 'main',
      session: { id: 'mock-session', sent: [] },
      emit: (a, b) => {
        if (typeof a === 'string') { uiEvents.push([a, b]); return undefined; }
        const cid = a.conversationId ?? ctx.chatKey;
        return reg.route(cid).emit({ ...a, conversationId: cid });
      },
      surface: {
        call: (method, args) => mock.call(method, args),
        capabilities: () => mock.capabilities()
      }
    };
    Object.assign(ctx, overrides);
    return { ctx, mock, webBody, intents, broadcasts, sentArchives, uiEvents, reg };
  }

  {
    // C1 发送边界形状（独立 ctx：text intent 直接走 ctx.emit → 身体 → 存档+广播）
    const { ctx, broadcasts, sentArchives } = makeCtx();
    const shape = await ctx.emit({ type: 'text', payload: { text: '在吗', replyTo: null, atUserId: null }, urgency: 'normal', replyTo: null });
    eq({ sent: shape.sent.length, failed: shape.failed }, { sent: 1, failed: [] },
      'C1 发送边界返回 {sent:[…],failed:[]} 形状不变（坑 #9）');
    eq(Object.keys(shape.sent[0]).sort(), ['at', 'messageId', 'text'], 'C1a sent[0] 键集合 {text,messageId,at}');
    ok(/^web-\d+-0$/.test(shape.sent[0].messageId), `C1b messageId 形状 web-<ts>-<i>（got=${shape.sent[0].messageId}）`);
    eq(broadcasts[0]?.payload, { conversationId: 'main', role: 'self', text: '在吗', ts: broadcasts[0]?.payload?.ts, messageId: shape.sent[0].messageId },
      'C1c broadcast 载荷 {conversationId,role:self,text,ts,messageId}');
    eq(sentArchives[0], { chatKey: 'main', type: 'text', archiveText: '在吗', messageId: shape.sent[0].messageId, ts: sentArchives[0]?.ts },
      'C1d onSent 存档回报 {chatKey,type,archiveText,messageId,ts}');
  }

  {
    // C2 send_message：一条字符串 → 恰 1 个 text intent（M1 补当前会话）→ 工具返回形状不变
    const { ctx, intents, broadcasts, sentArchives, uiEvents } = makeCtx();
    const r = await send.execute(ctx, { messages: '在吗' });
    eq(intents, [{
      type: 'text',
      payload: { text: ['在吗'], replyTo: null, atUserId: null },
      urgency: 'normal',
      replyTo: null,
      conversationId: 'main'
    }], 'C2 恰产生 1 个 text intent（normalizeMessageList 归一成数组；工具不带 cid，ctx.emit 按 M1/D19 补当前会话）');
    eq(broadcasts.map((b) => [b.type, b.payload.text]), [['chat-message', '在吗']],
      'C2b 身体翻译：1 次 chat-message 广播、文本逐字节透传');
    eq(sentArchives.map((s) => s.archiveText), ['在吗'], 'C2c 存档回报逐条落（Q11 装配同款 recorder 参数）');
    eq(uiEvents, [['session-update', 'mock-session']], 'C3 旧 UI 事件路径原样保留（session-update 旁路，不进身体）');
    const payload = JSON.parse(r.content);
    eq({ sent: payload.sent, messageIds: payload.messageIds.map((m) => typeof m === 'string' && m.startsWith('web-')) },
      { sent: 1, messageIds: [true] }, 'C4 工具返回 sent=1 / messageIds=[web-*]（身体 messageId 透传）');
    ok(!r.isError && typeof payload.note === 'string' && payload.note.includes('已发送'), 'C5 工具返回非 error，note 引导语在场');
    eq(ctx.session.sent, [{ type: 'text', text: '在吗', at: payload.messageIds[0] ? ctx.session.sent[0]?.at : '' }],
      'C6 session.sent 记账形状不变（type/text/at 三键）');
    ok(r.content.includes('messageId'), 'C7 工具 content 仍是 JSON 字符串形态（ok() 包装未变）');
  }

  {
    // C8（Q6+Q8 收缩）：send_message attachments 不合法/找不到表情 → 工具层拒收，
    // 零 intent、零广播（原 send_to C8/C9 断言随工具消亡，本位改为媒体层拒收路径）
    const { ctx, intents, broadcasts } = makeCtx({
      stickers: { async find() { return null; }, markUsed() {} }
    });
    const r = await send.execute(ctx, { messages: ['看这个'], attachments: [{ kind: 'sticker', id: 'nope' }] });
    ok(r.isError === true && r.content.includes('找不到表情 nope'), 'C8 attachments sticker 找不到 → 工具层拒收（err 形状不变）');
    eq(intents, [], 'C9 拒收路径零 intent（媒体层：解析失败不产生发送）');
    eq(broadcasts, [], 'C9b 拒收路径零广播');
  }

  {
    // C8c（Q6+Q8 媒体层）：无 attachments 时意图形状与旧版逐字节一致（payload 无 attachments 键）
    const { ctx, intents } = makeCtx({ stickers: { async find() { return null; }, markUsed() {} } });
    await send.execute(ctx, { messages: '在吗' });
    eq(intents[0]?.payload, { text: ['在吗'], replyTo: null, atUserId: null },
      'C8c 无 attachments 的 text intent 与旧版逐字节一致（字段整体缺省，不落空数组）');
  }

  {
    // C3 ctx.surface 来自 mock 身体：读回空容忍（草案 §4 规则 4）+ 能力握手
    // （清债夜2：ctx.surface 收窄为 { call, capabilities }——原 C11 断言的读回展开
    //   窄通道随生产侧摘除一并删除，评审 P2-6②口径；mock 身体方法同步移除。）
    const { ctx, mock } = makeCtx();
    eq(await ctx.surface.call('get_forward_msg', { message_id: 1 }), {}, 'C10 mock 身体 call 返回 {}（空读回容忍）');
    ok(typeof ctx.surface.expandForward === 'undefined', 'C11 ctx.surface 不再暴露读回展开窄通道（清债夜2 摘除，评审 P2-6②）');
    eq(ctx.surface.capabilities(), mock.capabilities(), 'C12 ctx.surface.capabilities 来自 mock 身体');
    eq(mock.capabilities(), {
      surface: 'mock', canText: true, canVoice: false, canSticker: false,
      canImage: false, canAnimate: false, canTyping: false, maxTextLength: 0, supportsReply: false
    }, 'C13 mock 能力表：canText:true 其余 false');
    eq(await mock.emit({ type: 'text', conversationId: 'x' }), { ok: true, messageId: null }, 'C14 mock emit 恒 {ok:true,messageId:null}');
  }

  // ═══ D. 身体层拒收路径（web-only）═══
  section('D. 身体层拒收路径（web-only：空文本/缺 cid 不抛错，按不可用标记回报）');
  {
    const { webBody, broadcasts, sentArchives } = makeCtx();
    // D1 空 text intent → {sent:[],failed:[{error:'消息内容为空'}]}（身体层拒收，不抛）
    eq(await webBody.emit({ type: 'text', conversationId: 'main', payload: { text: ['   '] } }),
      { sent: [], failed: [{ error: '消息内容为空' }], }, 'D1 空 text → {sent:[],failed:[消息内容为空]}');
    // D2 缺 conversationId → {ok:false,error}（身体层校验，不抛）
    eq(await webBody.emit({ type: 'text', payload: { text: 'x' } }),
      { ok: false, error: 'web.emit：缺 conversationId' }, 'D2 缺 conversationId → {ok:false,error}');
    eq(sentArchives, [], 'D3 拒收意图零存档（无 onSent 回报 = 无发送发生）');
    eq(broadcasts, [], 'D3b 拒收路径零广播');
  }

  {
    // D4-D5（Q6+Q8 收缩）：attachments 项形状不合法在工具层就被拒收——零 intent、零广播
    // （原 send_to 非法 target 断言随工具消亡，拒收路径覆盖改到媒体层）
    const good = makeCtx({ stickers: { async find() { return null; }, markUsed() {} } });
    const r2 = await send.execute(good.ctx, { messages: ['x'], attachments: [{ kind: 'bogus' }] });
    ok(r2.isError === true && r2.content.includes('attachments 项不合法'), 'D4 attachments 项不合法拒收（err 形状不变）');
    eq(good.intents, [], 'D5 拒收路径零 intent');
    eq(good.broadcasts, [], 'D5b 拒收路径零广播');
  }

  // ═══ E. web 身体 emit 翻译（坑 #9：形状逐字节透传；顺序铁律先记档再广播）═══
  section('E. web 身体 emit 翻译与读回绑定');
  {
    const broadcasts = [];
    const sentArchives = [];
    const web = createWebAdapter({
      broadcast: (type, payload) => broadcasts.push({ type, payload, at: Date.now() }),
      onSent: (report) => sentArchives.push({ ...report, at: Date.now() })
    });

    eq(web.surface, 'web', 'E1 surface 名');
    eq(web.capabilities(), {
      surface: 'web', canText: true, canVoice: true, canImage: true, canSticker: false,
      canAnimate: false, canTyping: true, maxTextLength: 8000, supportsReply: true
    }, 'E2 capabilities：web 能力表（canSticker:false——表情包不是这副嗓子；canVoice:true=V2 语音条 TTS 链路已通，闸在 config.voice 缺省关）');

    const out1 = await web.emit({ type: 'text', conversationId: 'main', payload: { text: ['a', 'b'] } });
    eq({ sent: out1.sent.length, failed: out1.failed }, { sent: 2, failed: [] }, 'E3 双条 text → sent=2 分条发送');
    ok(sentArchives.length === 2 && broadcasts.length === 2, 'E4 存档与广播各 2 条');
    ok(sentArchives[0].at <= broadcasts[0].at && sentArchives[1].at <= broadcasts[1].at,
      'E5 顺序铁律：每条先 onSent 记档再 broadcast（广播失败不丢档）');
    eq(sentArchives.map((s) => s.chatKey), ['main', 'main'], 'E6 存档 chatKey=conversationId');
    eq(broadcasts.map((b) => b.payload.text), ['a', 'b'], 'E7 分条文本逐字节透传（mdToPlain 后）');
    eq(out1.sent.map((s) => s.text), ['a', 'b'], 'E8 返回 sent 的 text 与广播一致');
    ok(out1.sent.every((s) => /^web-\d+-\d+$/.test(s.messageId)), 'E9 messageId 形状 web-<ts>-<i>');

    // mediaIds：attachments 只随最后一条分条广播（媒体跟话走），存档带 [图片] 尾注
    const out2 = await web.emit({ type: 'text', conversationId: 'main', payload: { text: ['看图'], attachments: [{ mediaId: 'abcd1234abcd1234' }] } });
    const lastBroadcast = broadcasts[broadcasts.length - 1];
    eq(lastBroadcast.payload.mediaIds, ['abcd1234abcd1234'], 'E10 mediaIds 只在最后一条广播出现（Q6+Q8 媒体层）');
    eq(sentArchives[sentArchives.length - 1].archiveText, '看图 [图片]', 'E11 存档文本带 [图片] 尾注（字节不进存档，E1）');
    eq(out2.sent[0].text, '看图', 'E12 返回 sent.text 无尾注（尾注只在存档）');

    const out3 = await web.emit({ type: 'image', conversationId: 'main', payload: { mediaId: 'abcd1234abcd1234', note: '截图' } });
    eq(out3, { sent: [{ text: '截图', messageId: out3.sent?.[0]?.messageId, at: out3.sent?.[0]?.at }], failed: [] },
      'E13 image → {sent:[{text,messageId,at}],failed:[]}（mediaId 走广播）');
    eq(broadcasts[broadcasts.length - 1].payload.mediaIds, ['abcd1234abcd1234'], 'E14 image 广播带 mediaIds');
    eq(await web.emit({ type: 'image', conversationId: 'main', payload: {} }),
      { sent: [], failed: [{ error: 'image 意图缺 mediaId（媒体层 Q6+Q8 起 body 只认内容哈希 id）' }] },
      'E15 image 缺 mediaId → 拒收标记（不抛）');

    const outTypingOn = await web.emit({ type: 'typing', conversationId: 'main', payload: { on: true } });
    ok(outTypingOn?.ok === true, 'E16 typing → {ok:true}（web 前端打字动画事件源）');
    eq(broadcasts[broadcasts.length - 1], { type: 'chat-typing', payload: { conversationId: 'main', on: true }, at: broadcasts[broadcasts.length - 1].at },
      'E17 typing 广播 chat-typing{conversationId,on}');
    await web.emit({ type: 'typing', conversationId: 'main', payload: { on: false } });
    eq(broadcasts[broadcasts.length - 1].payload.on, false, 'E18 typing on:false 透传');

    eq(await web.emit({ type: 'reaction', conversationId: 'main', payload: {} }), { ok: false, error: 'unsupported type' }, 'E19 别的身体的词表（reaction）→ unsupported，不崩溃');
    eq(await web.emit({ type: 'diary', conversationId: 'diary:x', payload: {} }), { ok: false, error: 'unsupported type' }, 'E20 diary 词表归日记本身体 → unsupported');
    eq(await web.emit({ type: 'bogus', conversationId: 'main' }), { ok: false, error: 'unsupported type' }, 'E21 未知 type → unsupported，不崩溃');

    eq(await web.call('get_forward_msg', { message_id: 1 }), { ok: false, error: 'web 身体不支持读回' }, 'E22 call → 不支持读回标记（web 是纯出站身体）');

    await expectThrow(() => createWebAdapter({ onSent: () => {} }), /broadcast/, 'E23 缺 broadcast 拒绝构造');
    await expectThrow(() => createWebAdapter({ broadcast: () => {} }), /onSent/, 'E24 缺 onSent 拒绝构造');
  }

  // ═══ F. web 身体纯出站（Q11：入站管线/读回展开均不存在）═══
  section('F. web 身体纯出站（无 normalize / 无 expandForward）');
  {
    const { webBody } = makeCtx();
    ok(typeof webBody.normalize === 'undefined', 'F1 web 身体无 normalize（入站唯一入口是 POST /api/web/send → submit）');
    ok(typeof webBody.expandForward === 'undefined', 'F2 web 身体无 expandForward（读回展开随 QQ 载体消亡）');
    eq(webBody.capabilities().supportsReply, true, 'F3 capabilities 仍声明 supportsReply（引用语义由 payload.replyTo 承载）');
  }

  // ═══ G. surface 标注（P3 · night-plan §6.1；Q6+Q8 收缩基线）═══
  section('G. surface 标注（Q6+Q8 收缩）：QQ 专属工具已摘除，注册表零 surface:[\'qq\'] 标注');
  {
    // G1（night-plan §Q6 基线）：QQ 专属工具四删（send_sticker/send_poke/read_forward/
    //    collect_sticker）+ 四去标注（send_image/list_stickers/get_sticker_image/sticker_note
    //    表情能力保留进全身体）→ 断言改为「无工具带 surface:['qq']」。
    //    过滤机制本身的回归由 G4 探针覆盖（注册表路径同吃 surface 过滤）。
    const qqTooled = buildToolDefs().filter((d) => Array.isArray(d.surface) && d.surface.map(String).includes('qq'));
    eq(qqTooled.map((d) => d.id), [], 'G1 无工具带 surface:[\'qq\']（QQ 专属工具已摘除/去标注）');
    // G1b 保留的表情知识层三工具在 pet/web 会话照常可用（不再被过滤层挡）
    for (const id of ['list_stickers', 'get_sticker_image', 'sticker_note']) {
      const stPet = getToolAvailability(id, { toolsCfg: {}, sessionSurface: 'pet' });
      ok(getTool(id) && stPet.enabled === true,
        `G1b ${id}（表情知识层保留）pet 会话可用（surface 标注已摘）`);
    }
    // G2 通用工具不填 surface → 过滤层空操作，pet 会话照常可用
    ok(getToolAvailability('send_message', { toolsCfg: {}, sessionSurface: 'pet' }).enabled === true,
      'G2 通用工具 send_message 在 pet 会话仍可用（不填 surface）');
    // G3 sessionSurface 缺省（旧调用方/磁盘旧会话无该字段）→ 放行（注册表层既定口径）
    ok(getToolAvailability('send_image', { toolsCfg: {} }).enabled === true,
      'G3 sessionSurface 缺省 → 放行（fail-open 口径不变；探针工具改用 send_image——send_sticker 已随 Q6+Q8 删除）');
    // G4 skill 注册路径同样吃 surface 过滤（探针不带 skillId，只验证 surface 元数据路径）
    const probeId = 'surface_probe__qq_tool';
    registerTool({ id: probeId, name: 'surface探针', description: 'P3 surface 过滤探针', execute: async () => ({ content: '' }), surface: ['qq'] });
    const stProbePet = getToolAvailability(probeId, { toolsCfg: {}, sessionSurface: 'pet' });
    ok(stProbePet.enabled === false && stProbePet.code === 'surface', 'G4 探针（registry 注册路径）pet 会话 code=surface');
    ok(getTool(probeId).surface.map(String).includes('qq'), 'G4b 探针 surface 元数据在注册表内保留');
    ok(unregisterTool(probeId) === true, 'G4c 探针注销（注册表无残留）');
    // G5 工具 ctx 收窄（P3）：测试假 ctx 与 orchestrator 接线同构——无发送/协议句柄键，
    //    只有 emit/surface 双口。orchestrator 侧以 grep 取证（tools/check-boundaries 注释同口径）。
    const { ctx: narrowCtx } = makeCtx();
    ok(!('sender' in narrowCtx) && !('onebot' in narrowCtx), 'G5 工具 ctx 无 sender/onebot 键');
    ok(typeof narrowCtx.emit === 'function' && typeof narrowCtx.surface?.call === 'function',
      'G5b ctx.emit / ctx.surface.call 在场（出站 + 读回双口）');
  }

  // ── 零网络总闸 ──
  section('零网络总闸');
  eq(fetchCalls, 0, 'Z1 全程零 fetch 调用');

  console.log(`\n${failures.length ? 'MOCK-ADAPTER SELFTEST FAILED' : 'MOCK-ADAPTER SELFTEST OK'}：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length) for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}
