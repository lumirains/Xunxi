// 通话运行器测试（V2 主体 · 内部文档 asr-tts-v2-execution-spec.md §4.3 门禁补强）。
// 承担内容：①call.js import 图断言（src/voice/ 不在 check-boundaries 扫描面
// ——check-boundaries.mjs:55 SCAN_DIRS=['kernel','person','capabilities']，design §7.3
// 五条纪律由本测试自测）；②app.js /api/voice 接线冒烟；③config voice 容器全键核对
//（call-mode §10.1）；④状态机/降级行为（LLM 桩 + TTS 桩 + 真沙箱 store，零网络零引擎）；
// ⑤T6 回想与可用性（night-plan §2-T6：recall.js 生成/幂等/staging/纯函数/前缀两侧同源）。
//
// 数据隔离：先设 XUNXI_DATA_DIR 到 os.tmpdir() 沙箱再动态 import（config/person 在
// import 期解析数据根）；updateConfig 翻开关只写沙箱 config.json；真实数据根零触碰。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xunxi-voice-call-test-'));
process.env.XUNXI_DATA_DIR = DATA_ROOT;

// 沙箱最小配置：voice 初始全关（gate 测试用），behavior 段再经 updateConfig 打开。
fs.writeFileSync(path.join(DATA_ROOT, 'config.json'), JSON.stringify({
  api: { model: 'test-model' }
}, null, 2));

const fsMod = await import('node:fs');
const { createVoiceCall } = await import('../src/voice/call.js');
const recallMod = await import('../src/voice/recall.js');
const engineMgrMod = await import('../src/voice/engine-manager.js');
const { createEngineManager } = engineMgrMod;
const { RECALL_PREFIX_RE, fmtCallDuration, fallbackRecallBody, emotionSignificant } = recallMod;
const { ChatStore } = await import('../src/kernel/store.js');
const { updateConfig, getConfig } = await import('../src/config.js');
const memory = await import('../src/person/memory.js');
const { closeDb } = await import('../src/storage/db.js');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

/** stub 记录器：收全部 system prompt（同进程共享沙箱 DB——hello 的摘要调用与正文轮
 *  都会进 stub，断言必须按调用序取，不能拿单个变量等竞态）。 */
function recorder(replyOf = () => ({ message: { content: '好。' } })) {
  const arr = [];
  return {
    arr,
    stub: async (args) => {
      arr.push(args.messages[0].content);
      return replyOf(arr.length);
    }
  };
}

async function waitFor(fn, timeoutMs = 4000, stepMs = 10) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

/** 极小合法 RIFF/PCM16 wav（44B 头 + N 样本），TTS 桩返回体。 */
function makeWav(samples = 96, sampleRate = 24000) {
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

/** 假 WS（行为面只需 readyState/send/close/事件）；sent 收全部出站帧。 */
class FakeWS extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;   // OPEN
    this.sent = [];
    this.closed = false;
  }

  send(data) { this.sent.push(data); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }

  emitMessage(obj) { this.emit('message', Buffer.from(JSON.stringify(obj)), false); }

  emitBinary(buf) { this.emit('message', buf, true); }   // V3 上行 PCM 帧

  json() { return this.sent.filter((x) => typeof x === 'string').map((s) => JSON.parse(s)); }

  bin() { return this.sent.filter((x) => Buffer.isBuffer(x)); }
}

/** 假 socket（gate 测试：404/403 raw 应答 + destroy）。 */
class FakeSocket {
  constructor() { this.buf = ''; this.destroyed = false; }

  write(s) { this.buf += s; }

  destroy() { this.destroyed = true; }
}

const RECALL_RE = RECALL_PREFIX_RE;   // 前缀契约同源（T6 起唯一定义点=src/voice/recall.js，不再本地复制字面）

// ═══ ① import 图断言（design §7.3 五条纪律；spec §4.3 门禁补强本体）══════════
await test('import 图：call.js 静态 import 无 surfaces/*、orchestrator、sender、registry、sessions、routes', () => {
  const src = fsMod.readFileSync(path.join(APP_ROOT, 'src', 'voice', 'call.js'), 'utf8');
  const staticImports = [...src.matchAll(/^\s*import\s[^;]*from\s+['"]([^'"]+)['"];?/gm)].map((m) => m[1]);
  for (const spec of staticImports) {
    assert.ok(!/surfaces|orchestrator|sender|registry|sessions|routes/.test(spec),
      `call.js 静态 import 违禁目标：${spec}`);
    assert.ok(!/(^|\/)store\.js$/.test(spec), `store 必须由装配层注入，不得 import：${spec}`);
  }
  assert.ok(staticImports.some((s) => /(^|\/)prompt\.js$/.test(s)), '必须接线 buildVoicePrompt');
  assert.ok(staticImports.some((s) => /(^|\/)split\.js$/.test(s)), '必须接线 splitForSpeech');
  assert.ok(staticImports.some((s) => /(^|\/)llm\.js$/.test(s)), 'LLM 口=第一批准口 chatCompletion');
});

await test('文件头纪律：design §7.3 五条逐字在文件头（纪律可被 review grep 到）', () => {
  const src = fsMod.readFileSync(path.join(APP_ROOT, 'src', 'voice', 'call.js'), 'utf8');
  const head = src.slice(0, src.indexOf('import { WebSocketServer }'));
  for (const line of [
    '不 import surfaces/*（不碰身体）',
    '不调用 orchestrator.submit（不入消息触发链、不唤醒 wake）',
    '不读写 sessions（通话不是会话，不进会话列表）',
    '只在挂断时调 store.appendSelf 一次（§8）',
    '引擎不可达 → 整通降级纯文字（§10.2），不抛错'
  ]) {
    assert.ok(head.includes(line), `文件头缺纪律行：${line}`);
  }
});

await test('存档纪律：call.js 零 appendSelf（store 只 recent 只读）；recall.js 写点恰一处（T6 分工）', () => {
  const src = fsMod.readFileSync(path.join(APP_ROOT, 'src', 'voice', 'call.js'), 'utf8');
  const codeOnly = src.replace(/\/\/[^\n]*/g, '');   // 掉注释再扫：文件头纪律引文含"store.appendSelf"字样属引用非代码
  const writes = [...codeOnly.matchAll(/store\.\w+/g)].map((m) => m[0]);
  for (const w of writes) {
    assert.ok(w === 'store.recent',
      `call.js store 只许 recent（摘要只读；写面 T6 起归 recall.js），见到：${w}`);
  }
  assert.ok((codeOnly.match(/store\.appendSelf\(/g) || []).length === 0,
    'call.js 不得再触 appendSelf（T6 起唯一存档写入点=recall.js）');
  const recallSrc = fsMod.readFileSync(path.join(APP_ROOT, 'src', 'voice', 'recall.js'), 'utf8');
  assert.ok((recallSrc.match(/store\.appendSelf\(/g) || []).length === 1, 'appendSelf 写点恰一处（recall.js）');
  const recallCodeOnly = recallSrc.replace(/\/\/[^\n]*/g, '');
  for (const w of [...recallCodeOnly.matchAll(/store\.\w+/g)].map((m) => m[0])) {
    assert.ok(w === 'store.appendSelf', `recall.js store 只许 appendSelf，见到：${w}`);
  }
});

await test('import 图：recall.js 静态 import 无 surfaces/*、orchestrator、sender、registry、sessions、routes、store.js', () => {
  const src = fsMod.readFileSync(path.join(APP_ROOT, 'src', 'voice', 'recall.js'), 'utf8');
  const staticImports = [...src.matchAll(/^\s*import\s[^;]*from\s+['"]([^'"]+)['"];?/gm)].map((m) => m[1]);
  for (const spec of staticImports) {
    assert.ok(!/surfaces|orchestrator|sender|registry|sessions|routes/.test(spec),
      `recall.js 静态 import 违禁目标：${spec}`);
    assert.ok(!/(^|\/)store\.js$/.test(spec), `store 必须由装配层注入，不得 import：${spec}`);
  }
  assert.ok(staticImports.some((s) => /(^|\/)llm\.js$/.test(s)), 'LLM 口=第一批准口 chatCompletion');
  assert.ok(staticImports.some((s) => /person\/memory\.js$/.test(s)), 'staging 必须经 person/memory API（单一写者）');
});

await test('文件头纪律：recall.js 写面/幂等/staging 纪律在文件头（可被 review grep 到）', () => {
  const src = fsMod.readFileSync(path.join(APP_ROOT, 'src', 'voice', 'recall.js'), 'utf8');
  const head = src.slice(0, src.indexOf('import { getConfig'));
  for (const line of [
    '唯一存档写入点',
    'callId 幂等',
    'staging 单一写者纪律',
    '不直写 staging 表/文件',
    '挂断后**异步**生成',
  ]) {
    assert.ok(head.includes(line), `recall.js 文件头缺纪律行：${line}`);
  }
});

await test('前缀契约两侧同源：recall.js RECALL_PREFIX_RE 与 frontend types.ts RECALL_LINE_RE 同值字面且各唯一定义', () => {
  const LITERAL = '/^\\[通话 (\\d+:\\d{2})\\]\\s/';
  const recallSrc = fsMod.readFileSync(path.join(APP_ROOT, 'src', 'voice', 'recall.js'), 'utf8');
  const feSrc = fsMod.readFileSync(path.join(APP_ROOT, 'frontend', 'src', 'lib', 'types.ts'), 'utf8');
  assert.ok(recallSrc.includes(LITERAL), '后端字面缺失（recall.js）');
  assert.ok(feSrc.includes(LITERAL), '前端字面缺失（frontend/src/lib/types.ts）');
  assert.equal(recallSrc.split(LITERAL).length - 1, 1, '后端字面应唯一定义（其他处应 import）');
  assert.equal(feSrc.split(LITERAL).length - 1, 1, '前端字面应唯一定义（types.ts；视图经 useChat 助手消费）');
});

// ═══ ② app.js 接线冒烟 ═══════════════════════════════════════════════════════
await test('app.js：server.on(upgrade) → /api/voice → createVoiceCall（握手接线在位）', () => {
  const src = fsMod.readFileSync(path.join(APP_ROOT, 'src', 'app.js'), 'utf8');
  assert.ok(src.includes("server.on('upgrade'"), '缺 server.on(upgrade) 挂接');
  assert.ok(src.includes("'/api/voice'"), '缺 /api/voice 路径');
  assert.ok(src.includes('createVoiceCall'), '缺 createVoiceCall 装配');
  assert.ok(src.includes('originAllowed(req)'), '握手应过 originAllowed 闸（与 /api 同面）');
});

// ═══ ③ config voice 容器全键核对（call-mode §10.1）═══════════════════════════
await test('config：voice.engine {manage:auto, gpuAllow:true} + call 全键在位', () => {
  const v = getConfig().voice;
  assert.deepEqual({ manage: v.engine?.manage, gpuAllow: v.engine?.gpuAllow },
    { manage: 'auto', gpuAllow: true }, 'engine 容器缺省形状');
  const c = v.call;
  for (const key of ['enabled', 'silenceMs', 'minUtteranceMs', 'maxUtteranceMs', 'firstSentenceMaxChars',
    'maxSentences', 'promptBudget', 'historyTurns', 'recallMinSeconds', 'keepAudio']) {
    assert.ok(key in c, `voice.call.${key} 缺`);
  }
  assert.deepEqual(c.dnd, { start: '23:30', end: '08:00' }, 'voice.call.dnd 形状');
  assert.equal(c.enabled, false, 'voice.call.enabled 缺省 false（零入口）');
  assert.equal(c.keepAudio, false, 'keepAudio 缺省 false（E1 通话形态）');
});

// ═══ ④ 升级闸（voice.call.enabled=false → 404；来源闸 → 403）══════════════════
await test('升级闸：voice 全关时 /api/voice 握手 404（入口不存在=design §12 回滚口径）', async () => {
  const call = createVoiceCall({ store: new ChatStore(), log: () => {} });
  const socket = new FakeSocket();
  await call.handleUpgrade({ url: '/api/voice', headers: {} }, socket, null);
  assert.ok(socket.buf.includes('404'), `应答 404，got=${JSON.stringify(socket.buf)}`);
  assert.ok(socket.destroyed, '断链');
});

await test('升级闸：来源不被信任 → 403（originAllowed 注入闸，先于 WS 握手）', async () => {
  updateConfig({ voice: { enabled: true, call: { enabled: true } } });
  const call = createVoiceCall({ store: new ChatStore(), log: () => {}, originAllowed: () => false });
  const socket = new FakeSocket();
  await call.handleUpgrade({ url: '/api/voice', headers: {} }, socket, null);
  assert.ok(socket.buf.includes('403'), `应答 403，got=${JSON.stringify(socket.buf)}`);
  assert.ok(!socket.buf.includes('404'), '不应落在开关 404（开关已开）');
  assert.ok(socket.destroyed, '断链');
});

// ═══ ⑤ 状态机与降级（LLM/TTS 桩注入，零网络）═════════════════════════════════
function makeCall({ store, chatCompletion, synthesizeRaw, transcribeWav, asrAvailable, originAllowed } = {}) {
  return createVoiceCall({
    store,
    log: () => {},
    originAllowed,
    deps: { chatCompletion, synthesizeRaw, transcribeWav, asrAvailable }
  });
}

await test('hello → ready{callId}；握手前二进制帧静默忽略（未 listening 不攒不报错）', async () => {
  const call = makeCall({ store: new ChatStore() });
  const ws = new FakeWS();
  call.handleConnection(ws);
  ws.emitBinary(Buffer.alloc(1280));   // 握手前 PCM 帧（异常客户端）
  ws.emitMessage({ type: 'hello' });
  const ready = ws.json().find((m) => m.type === 'ready');
  assert.ok(ready && Number.isInteger(ready.callId), `ready.callId 缺：${JSON.stringify(ws.json())}`);
  ws.emitBinary(Buffer.from([1, 2, 3, 4]));   // 二进制帧（V3 由 listening 态消费）
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!ws.json().some((m) => m.type === 'error'), '二进制帧不应报错');
});

await test('文字进 → LLM 整段 → 切句 → segment_start/二进制/segment_end（ogg 缺省档）', async () => {
  const ttsArgs = [];
  const wav = makeWav();
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async () => ({ message: { content: '嗯，我在呢。怎么了，这么晚打电话。' } }),
    synthesizeRaw: async (text, opts) => { ttsArgs.push({ text, opts }); return { bytes: wav, mime: 'audio/wav' }; }
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '在吗？' });
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'segment_end').length === 2), '两段 segment_end 未到');
  const starts = ws.json().filter((m) => m.type === 'segment_start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].isFirst, true, '首段 isFirst=true');
  assert.equal(starts[1].isFirst, false);
  assert.deepEqual(ws.bin(), [wav, wav], '每段一个二进制帧=整段字节');
  assert.deepEqual(ttsArgs, [
    { text: '嗯，我在呢。', opts: { format: 'ogg' } },
    { text: '怎么了，这么晚打电话。', opts: { format: 'ogg' } }
  ]);
});

await test('audio-format 换档：{value:wav} → synthesizeRaw 收 {format:wav}', async () => {
  const ttsArgs = [];
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async () => ({ message: { content: '好呀。' } }),
    synthesizeRaw: async (text, opts) => { ttsArgs.push(opts); return { bytes: makeWav(), mime: 'audio/wav' }; }
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'audio-format', value: 'wav' });
  ws.emitMessage({ type: 'text', text: '晚安' });
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'segment_end').length === 1));
  assert.deepEqual(ttsArgs, [{ format: 'wav' }]);
});

await test('LLM 失败 → error{internal}，通话不断（下一轮可用）；不落任何回想', async () => {
  let shouldThrow = true;
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async () => {
      if (shouldThrow) throw new Error('模型请求失败');
      return { message: { content: '接上了。' } };
    },
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' })
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '喂？' });
  assert.ok(await waitFor(() => ws.json().some((m) => m.type === 'error' && m.code === 'internal')), '缺 error 帧');
  shouldThrow = false;
  ws.emitMessage({ type: 'text', text: '现在呢' });
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'segment_end').length === 1), 'LLM 恢复后应出声');
  assert.ok(!ws.json().some((m) => m.type === 'ended'), '通话不应被挂断');
});

await test('连续 2 句 TTS 失败 → 余句 text_fallback；下轮整段原样一帧（降级纯文字）', async () => {
  let turn = 0;
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async () => {
      turn += 1;
      // 末段 ≥8 字避开 R6 尾并 → 恰三段（['第一句。','第二句。','第三句说完了呀。']）
      return { message: { content: turn === 1 ? '第一句。第二句。第三句说完了呀。' : '又一轮的话。' } };
    },
    synthesizeRaw: async () => null   // TTS 恒失败（gate 关/死端口同形状）
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '说点什么' });
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'text_fallback').length >= 3), '三句都该出字');
  assert.equal(ws.bin().length, 0, '零二进制帧');
  const fb = ws.json().filter((m) => m.type === 'text_fallback').map((m) => m.text);
  assert.deepEqual(fb, ['第一句。', '第二句。', '第三句说完了呀。'], `逐句原文回退：${JSON.stringify(fb)}`);
  ws.emitMessage({ type: 'text', text: '再说' });
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'text_fallback').length >= 4));
  const last = ws.json().filter((m) => m.type === 'text_fallback').pop();
  assert.equal(last.text, '又一轮的话。', '降级后整段原样一帧');
  assert.ok(!ws.json().some((m) => m.type === 'ended'), '通话不断');
});

await test('半双工 V2：她说话期间新文字排队一条（深度 1，超出回 busy），说完自动接上', async () => {
  let release;
  let calls = 0;
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async () => {
      calls += 1;
      if (calls === 1) return new Promise((res) => { release = () => res({ message: { content: '好呀。' } }); });
      return { message: { content: '排到的话我接上了。' } };
    },
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' })
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '第一条' });
  await new Promise((r) => setTimeout(r, 30));      // 等 thinking 置位
  ws.emitMessage({ type: 'text', text: '第二条（排队）' });
  ws.emitMessage({ type: 'text', text: '第三条（应 busy）' });
  assert.ok(ws.json().some((m) => m.type === 'error' && m.code === 'busy'), '第三条应回 busy');
  release();
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'segment_end').length >= 2), '两条轮都该完成');
  const busyCount = ws.json().filter((m) => m.type === 'error' && m.code === 'busy').length;
  assert.equal(busyCount, 1, 'busy 恰一次（排队深度 1）');
});

await test('挂断：stop → ended{reason:client} + messages 恰一行 [通话 M:SS] 模板行（回想 LLM 失败回落）；重复信令幂等', async () => {
  const store = new ChatStore();
  const chat = makeCall({
    store,
    chatCompletion: async (args) => {
      // 回想调用（system 含回想指令）→ 抛错：走 §8.3 失败回落模板路径；主轮正常出声
      if (String(args?.messages?.[0]?.content ?? '').includes('回想')) throw new Error('stub: recall down');
      return { message: { content: '好。' } };
    },
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' })
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '第一条' });
  ws.emitMessage({ type: 'text', text: '第二条' });
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'segment_end').length >= 2));
  ws.emitMessage({ type: 'stop' });
  assert.ok(await waitFor(() => ws.json().some((m) => m.type === 'ended' && m.reason === 'client')), '缺 ended 帧');
  assert.ok(ws.closed, '服务端应关闭连接');
  // 重复挂断信令（重连重放同 callId 语义）：ended/appendSelf 都不得重放
  ws.emitMessage({ type: 'stop' });
  ws.emit('close');
  const countRows = () => store.recent('main', { limit: 100 }).filter((m) => RECALL_RE.test(String(m?.text ?? ''))).length;
  assert.ok(await waitFor(() => countRows() === 1), '挂断后异步回想应落恰一行');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(countRows(), 1, `messages 恰一行回想（幂等后仍 1），got ${countRows()}`);
  const rows = store.recent('main', { limit: 100 }).filter((m) => RECALL_RE.test(String(m?.text ?? '')));
  assert.match(rows[0].text, /\[通话 \d+:\d{2}\] 刚才和他通了个电话，聊了 2 句。/);
});

await test('ws close 语义同 stop：客户端直接断也走挂断链落一行（0 句模板行）', async () => {
  const store = new ChatStore();
  const before = store.recent('main', { limit: 100 }).filter((m) => RECALL_RE.test(String(m?.text ?? ''))).length;
  const chat = makeCall({ store });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '第一条' });
  await new Promise((r) => setTimeout(r, 20));
  ws.close();   // 客户端直接断（pagehide/锁屏语义）——socket 已亡，ended 帧不可达，断言落档
  assert.ok(await waitFor(() => store.recent('main', { limit: 100 })
    .filter((m) => RECALL_RE.test(String(m?.text ?? ''))).length === before + 1), 'close 也应走挂断链');
  const rows = store.recent('main', { limit: 100 }).filter((m) => RECALL_RE.test(String(m?.text ?? '')));
  assert.equal(rows.length, before + 1, `共享沙箱 DB 增量恰 1（前序测试已有 ${before} 行）`);
});

// ═══ ⑤b V3 上行闭环（night-plan §2-T5：PCM 攒段 / 尾点信令 / 半双工双保险 / 降级）═══
const UP_FRAME = Buffer.alloc(1280);   // 一帧静音 PCM16/16k/40ms（服务端不解释内容，只攒段）

/** wav 头解包（transcribeWav 桩收到的字节必须已是 16k mono s16 wav 容器）。 */
function wavInfo(buf) {
  return {
    riff: buf.toString('ascii', 0, 4),
    sampleRate: buf.readUInt32LE(24),
    channels: buf.readUInt16LE(22),
    bits: buf.readUInt16LE(34),
    dataLen: buf.readUInt32LE(40)
  };
}

await test('V3 上行：listening 期 PCM 帧攒段 → utterance_end → transcribeWav(16k wav) → 她回复 + state 帧序列', async () => {
  const asrCalls = [];
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async () => ({ message: { content: '嗯，慢慢说，我在听。' } }),
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' }),
    asrAvailable: async () => true,
    transcribeWav: async (wav) => { asrCalls.push(wav); return { text: '今天有点累' }; }
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  for (let i = 0; i < 10; i++) ws.emitBinary(UP_FRAME);
  ws.emitMessage({ type: 'utterance_end', ms: 400 });
  assert.ok(await waitFor(() => asrCalls.length === 1), 'transcribeWav 未被调用');
  const info = wavInfo(asrCalls[0]);
  assert.deepEqual(info, { riff: 'RIFF', sampleRate: 16000, channels: 1, bits: 16, dataLen: 10 * 1280 },
    `wav 容器形状：${JSON.stringify(info)}`);
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'segment_end').length === 1), '她应出声');
  const phases = ws.json().filter((m) => m.type === 'state').map((m) => m.value);
  assert.deepEqual(phases, ['listening', 'thinking', 'speaking', 'listening'], `state 帧序列：${JSON.stringify(phases)}`);
  const turn = ws.json(); void turn;
  const errFrames = ws.json().filter((m) => m.type === 'error');
  assert.equal(errFrames.length, 0, `不应有 error：${JSON.stringify(errFrames)}`);
});

await test('V3 转写文本进主链：system 段 6 含原文、messages=[system,user]（与文字轮同链路）', async () => {
  const argsArr = [];
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async (args) => { argsArr.push(args); return { message: { content: '好。' } }; },
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' }),
    asrAvailable: async () => true,
    transcribeWav: async () => ({ text: '周末去看展吗' })
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  for (let i = 0; i < 10; i++) ws.emitBinary(UP_FRAME);
  ws.emitMessage({ type: 'utterance_end', ms: 400 });
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'segment_end').length === 1));
  const turn = argsArr.find((a) => a.messages[1]?.content === '周末去看展吗');
  assert.ok(turn, `转写文本应作为本轮 user 进 LLM：${JSON.stringify(argsArr.map((a) => a.messages.map((m) => m.role)))}`);
  assert.deepEqual(turn.messages.map((m) => m.role), ['system', 'user'], 'messages 形状不变（handoff §9-11 口径）');
  assert.ok(turn.messages[0].content.includes('他：周末去看展吗'), '段 6 通话内历史含转写原文');
});

await test('V3 ASR 失败：error{code:asr}"没听清" + 回 listening；不落 history 不落 store，下一轮可用', async () => {
  const store = new ChatStore();
  const before = store.recent('main', { limit: 100 }).length;
  let asrCalls = 0;
  const chat = makeCall({
    store,
    chatCompletion: async () => ({ message: { content: '嗯，我在呢。' } }),
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' }),
    asrAvailable: async () => true,
    // 第 1 次失败（引擎失败/转写为空同形状），第 2 次（重说）成功
    transcribeWav: async () => { asrCalls += 1; return asrCalls === 1 ? null : { text: '这回听清了' }; }
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  for (let i = 0; i < 10; i++) ws.emitBinary(UP_FRAME);
  ws.emitMessage({ type: 'utterance_end', ms: 400 });
  assert.ok(await waitFor(() => ws.json().some((m) => m.type === 'error' && m.code === 'asr' && /没听清/.test(String(m.message)))), '缺 asr error 帧');
  const phases = ws.json().filter((m) => m.type === 'state').map((m) => m.value);
  assert.equal(phases[phases.length - 1], 'listening', '失败后回 listening（可直接重说）');
  assert.equal(store.recent('main', { limit: 100 }).length, before, '失败不落任何条目');
  // 重说：状态机已回 listening，第二条 utterance 正常走通
  for (let i = 0; i < 10; i++) ws.emitBinary(UP_FRAME);
  ws.emitMessage({ type: 'utterance_end', ms: 400 });
  assert.ok(await waitFor(() => asrCalls === 2 && ws.json().filter((m) => m.type === 'segment_end').length === 1), '重说应走通');
  assert.ok(!ws.json().some((m) => m.type === 'ended'), '通话不断');
});

await test('V3 过短 utterance（<minUtteranceMs 300ms）：静默丢弃，无 ASR 无 error，状态不离开 listening', async () => {
  let asrCalls = 0;
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async () => ({ message: { content: '好。' } }),
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' }),
    asrAvailable: async () => true,
    transcribeWav: async () => { asrCalls += 1; return { text: '咳咳' }; }
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitBinary(UP_FRAME);   // 2 帧 = 80ms < 300ms（咳嗽/误触，design §6.1）
  ws.emitBinary(UP_FRAME);
  ws.emitMessage({ type: 'utterance_end', ms: 80 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(asrCalls, 0, '过短不应进 ASR');
  assert.ok(!ws.json().some((m) => m.type === 'error'), '静默丢弃不回 error');
  assert.ok(!ws.json().some((m) => m.type === 'state' && m.value !== 'listening'), '状态不离开 listening');
  // 完整 utterance 紧随其后：证明状态机没有被卡死
  for (let i = 0; i < 10; i++) ws.emitBinary(UP_FRAME);
  ws.emitMessage({ type: 'utterance_end', ms: 400 });
  assert.ok(await waitFor(() => asrCalls === 1), '后续完整 utterance 应正常收');
});

await test('V3 她说期间上行帧丢弃（服务端状态机侧）：thinking/speaking 期 binary+utterance_end 全忽略', async () => {
  let release;
  let asrCalls = 0;
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async () => new Promise((res) => { release = () => res({ message: { content: '好呀。' } }); }),
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' }),
    asrAvailable: async () => true,
    transcribeWav: async () => { asrCalls += 1; return { text: '插话' }; }
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '第一条' });
  await new Promise((r) => setTimeout(r, 30));   // 等 thinking 置位
  for (let i = 0; i < 10; i++) ws.emitBinary(UP_FRAME);   // 她想/说期间的上行帧
  ws.emitMessage({ type: 'utterance_end', ms: 400 });
  release();
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'segment_end').length === 1), '轮应完成');
  assert.equal(asrCalls, 0, '她说期间 utterance 不应进 ASR');
  const phases = ws.json().filter((m) => m.type === 'state').map((m) => m.value);
  assert.equal(phases[phases.length - 1], 'listening', '轮毕回 listening');
  // 回到 listening 后上行恢复：再来一整段 utterance 正常收
  for (let i = 0; i < 10; i++) ws.emitBinary(UP_FRAME);
  ws.emitMessage({ type: 'utterance_end', ms: 400 });
  assert.ok(await waitFor(() => asrCalls === 1), 'listening 恢复后上行应被消费');
});

await test('V3 60s 上限强制收尾：缓冲攒满 maxUtteranceMs 自动 finalize（客户端尾点失联兜底）', async () => {
  const asrCalls = [];
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async () => ({ message: { content: '好。' } }),
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' }),
    asrAvailable: async () => true,
    transcribeWav: async (wav) => { asrCalls.push(wav); return { text: '说满了' }; }
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  const capFrames = Math.ceil((60000 / 1000) * 32000 / 1280);   // =1500 帧（config 缺省 maxUtteranceMs）
  for (let i = 0; i < capFrames; i++) ws.emitBinary(UP_FRAME);
  assert.ok(await waitFor(() => asrCalls.length === 1), '攒满上限应自动 finalize');
  assert.equal(wavInfo(asrCalls[0]).dataLen, capFrames * 1280, '整段字节全量进 ASR');
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'segment_end').length === 1), '她应出声');
});

await test('V3 识别未开启：error{code:asr_off} 每通一次 + 回 listening；文字轮不受影响（§10.2 降级链）', async () => {
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async () => ({ message: { content: '好。' } }),
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' }),
    asrAvailable: async () => false   // voice.asr gate 关（engine off / baseUrl 空）同形状
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  for (let i = 0; i < 10; i++) ws.emitBinary(UP_FRAME);
  ws.emitMessage({ type: 'utterance_end', ms: 400 });
  assert.ok(await waitFor(() => ws.json().some((m) => m.type === 'error' && m.code === 'asr_off')), '缺 asr_off 引导帧');
  ws.emitMessage({ type: 'text', text: '那我打字说' });
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'segment_end').length === 1), '文字轮不受影响');
  const offCount = ws.json().filter((m) => m.type === 'error' && m.code === 'asr_off').length;
  // 再来一段 utterance：不再重复引导（asrAnnounced 每通一次）
  for (let i = 0; i < 10; i++) ws.emitBinary(UP_FRAME);
  ws.emitMessage({ type: 'utterance_end', ms: 400 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(offCount, 1, `asr_off 引导恰一次，got ${ws.json().filter((m) => m.type === 'error' && m.code === 'asr_off').length}`);
});

await test('voice.asr V3 面：transcribeWav/available 导出；gate 关=available false + transcribeWav null（零网络）', async () => {
  const { voice } = await import('../src/capabilities/voice.js');
  assert.equal(typeof voice.asr.transcribeWav, 'function', '导出面缺 transcribeWav');
  assert.equal(typeof voice.asr.available, 'function', '导出面缺 available');
  updateConfig({ voice: { enabled: false } });
  assert.equal(voice.asr.available(), false, 'voice.enabled=false → available false');
  assert.equal(await voice.asr.transcribeWav(Buffer.alloc(1280)), null, 'gate 关 → null（零网络零字节）');
  updateConfig({ voice: { enabled: true, asr: { engine: 'off' } } });
  assert.equal(voice.asr.available(), false, 'engine off → available false');
  updateConfig({ voice: { enabled: true, asr: { engine: 'gpu-local', baseUrl: '' } } });
  assert.equal(voice.asr.available(), false, 'baseUrl 空 → available false（B2）');
  assert.equal(await voice.asr.transcribeWav(Buffer.alloc(0)), null, '空字节 → null');
});

// ═══ ⑥ buildVoicePrompt 接线（person 派生 + 卡检索 + 摘要 + 历史原文）═════════
// 注意：同进程共享沙箱 DB——`new ChatStore()` 会读到此前测试的消息，hello 触发的
// 摘要调用与正文轮都会进 stub；断言一律按调用序取（recorder），不拿单变量等竞态。
await test('通话前摘要：hello 后一次轻量调用（maxTokens 200 / thinkingMode off / 不含通话回想行），注入段 5', async () => {
  const store = new ChatStore();
  const t = Date.now();
  store.appendIncoming('main', { mid: `m1:${t}`, ts: t - 3000, senderId: 'u', senderName: '他', text: '今天在弄语音功能，延迟有点烦' });
  store.appendIncoming('main', { mid: `m2:${t}`, ts: t - 2000, senderId: 'u', senderName: '他', text: '晚上想早点睡' });
  store.appendSelf('main', { ts: t - 1000, text: '[通话 0:30] 刚才和他通了个电话，聊了 2 句。' });
  const argsArr = [];
  const chat = makeCall({
    store,
    chatCompletion: async (args) => {
      argsArr.push(args);
      // 第 1 次=摘要，第 2 次=正文轮（单句回复，段数可预期）
      return { message: { content: argsArr.length === 1 ? '他今天在弄语音功能，抱怨过延迟。' : '好。' } };
    },
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' })
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '在吗今天' });   // 段 6 过滤 ≤3 字行——用 4+ 字文本
  assert.ok(await waitFor(() => argsArr.length >= 2), `摘要一次 + 本轮一次，got ${argsArr.length}`);
  const pre = argsArr[0];
  assert.equal(pre.maxTokens, 200);
  assert.equal(pre.temperature, 0.3);
  assert.deepEqual(pre.skillContext, { thinkingMode: 'off' });
  const preInput = pre.messages.map((m) => m.content).join('\n');
  assert.ok(preInput.includes('他：今天在弄语音功能'), '摘要输入含原句');
  assert.ok(!preInput.includes('[通话'), '摘要输入不含 self 通话回想行');
  const system = argsArr[1].messages[0].content;
  assert.ok(system.includes('【你们今天聊过】他今天在弄语音功能'), '段 5 注入摘要');
  // 转录只出现一次（偏差登记：不走 messages user/assistant 交替）
  const roles = argsArr[1].messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user'], `messages 形状=${JSON.stringify(roles)}`);
  assert.ok(system.includes('他：在吗今天'), '段 6 含本轮原文');
});

await test('摘要失败回落最近 3 条原句（不阻塞接通）', async () => {
  const store = new ChatStore();
  const t = Date.now();
  store.appendIncoming('main', { mid: `f1:${t}`, ts: t - 3000, senderId: 'u', senderName: '他', text: '原句一号' });
  store.appendIncoming('main', { mid: `f2:${t}`, ts: t - 2000, senderId: 'u', senderName: '他', text: '原句二号' });
  store.appendIncoming('main', { mid: `f3:${t}`, ts: t - 1000, senderId: 'u', senderName: '他', text: '原句三号' });
  const argsArr = [];
  const chat = makeCall({
    store,
    chatCompletion: async (args) => {
      argsArr.push(args);
      if (argsArr.length === 1) throw new Error('摘要模型不可用');   // 只摘要失败，正文轮成功
      return { message: { content: '好。' } };
    },
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' })
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '喂' });
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'segment_end').length >= 1), '摘要失败不应阻塞接通');
  assert.ok(!ws.json().some((m) => m.type === 'error'), '回落不是错误路径');
  assert.ok(argsArr.length >= 2, `got ${argsArr.length}`);
  const system = argsArr[1].messages[0].content;
  assert.ok(system.includes('【你们今天聊过】'), '段 5 在场');
  assert.ok(system.includes('他：原句三号'), '回落=最近 3 条原句拼接');
});

await test('记忆卡：词法命中进【旧事】，零命中省略段 4（embedding 关闭走词法）', async () => {
  const store = new ChatStore();
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  memory.writeCard({
    date: day,
    gist: '他怕黑，约好周末一起看展',
    keywords: ['怕黑', '看展'],
    entry: '他说最近怕黑，约好周末一起去看展。',
    salience: 1, events: [], facts: [], promises: [], open_loops: [], mood: 'calm',
    range: { from: Date.now() - 86400000, to: Date.now() }, source: 'test'
  });
  const rec1 = recorder();
  const chat = makeCall({
    store,
    chatCompletion: rec1.stub,
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' })
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '周末看展的事还记得吗' });
  assert.ok(await waitFor(() => rec1.arr.length >= 1
    && rec1.arr[rec1.arr.length - 1].includes('【这通电话说到现在】')), '正文轮 system 未到');
  const system1 = rec1.arr[rec1.arr.length - 1];
  assert.ok(system1.includes('【旧事】'), '命中卡应进段 4');
  assert.ok(system1.includes('他怕黑，约好周末一起看展'), 'gist 原文在场');

  const rec2 = recorder();
  const chat2 = makeCall({
    store,
    chatCompletion: rec2.stub,
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' })
  });
  const ws2 = new FakeWS();
  chat2.handleConnection(ws2);
  ws2.emitMessage({ type: 'hello' });
  ws2.emitMessage({ type: 'text', text: '天气预报说明天降温呢真冷啊' });
  assert.ok(await waitFor(() => rec2.arr.length >= 1
    && rec2.arr[rec2.arr.length - 1].includes('【这通电话说到现在】')));
  const system2 = rec2.arr[rec2.arr.length - 1];
  assert.ok(system2.includes('天气预报'), '零命中轮 system 在场');
  assert.ok(!system2.includes('【旧事】'), '零命中应省略段 4');
});

await test('状态四行接线：mind/life 派生实读进【现在】（关系行已随 relationship 丢弃移除）', async () => {
  const mind = await import('../src/person/mind.js');
  const life = await import('../src/person/life.js');
  mind.noteMood({ mood: '有点黏', topics: ['等他回消息'], source: 'test' });
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  life.write({
    plansByDay: {
      [day]: { date: day, dayKey: day, items: [{ time: '14:00', activity: '下午改代码' }, { time: '23:00', activity: '早点睡' }] }
    }
  });
  const rec = recorder();
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: rec.stub,
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' })
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '你在忙吗' });
  assert.ok(await waitFor(() => rec.arr.length >= 1 && rec.arr[rec.arr.length - 1].includes('【这通电话说到现在】')));
  const system = rec.arr[rec.arr.length - 1];
  assert.ok(system.includes('【你是谁】'), '段 1 人设在场（缺省 persona.roleText）');
  assert.ok(system.includes('【你在打电话】'), '段 2 voiceRules 在场');
  assert.ok(system.includes('【现在】'), '段 3 状态在场');
  assert.ok(system.includes('心绪：'), '心绪行（mind 派生）');
  assert.ok(system.includes('今天：下午改代码，早点睡'), '今天行（life planForDay 派生，前 2 条）');
  assert.ok(!system.includes('关系：'), '关系行不再出现（2026-11-21 relationship 整体丢弃）');
});

// ═══ ⑦ synthesizeRaw 真闸（离线：gate 形状；引擎联机验收归 T4）═══════════════
await test('voice.tts.synthesizeRaw：gate 关 → null；baseUrl 空 → null（零网络）；导出形状双形态', async () => {
  const { voice } = await import('../src/capabilities/voice.js');
  assert.equal(typeof voice.tts.synthesizeRaw, 'function', '导出面缺 synthesizeRaw');
  updateConfig({ voice: { enabled: true, tts: { engine: 'off', baseUrl: '' } } });
  assert.equal(await voice.tts.synthesizeRaw('嗯'), null, 'engine off → null');
  assert.equal(await voice.tts.synthesize('嗯'), null, 'synthesize 落档包装同 gate');
  updateConfig({ voice: { enabled: true, tts: { engine: 'gpu-local', baseUrl: '' } } });
  assert.equal(await voice.tts.synthesizeRaw('嗯', { format: 'wav' }), null, 'baseUrl 空 → null（B2）');
  assert.equal(await voice.tts.synthesizeRaw(''), null, '空文本 → null');
});

// ═══ ⑧ T6 回想与可用性（night-plan §2-T6：recall.js 生成/幂等/staging/纯函数）════
function recallStub(body, stagingLine = '') {
  return async (args) => {
    if (String(args?.messages?.[0]?.content ?? '').includes('回想')) {
      return { message: { content: stagingLine ? `${body}\n${stagingLine}` : body } };
    }
    return { message: { content: '嗯，慢慢来。' } };
  };
}

const recallRowsOf = (store) =>
  store.recent('main', { limit: 100 }).filter((m) => RECALL_RE.test(String(m?.text ?? '')));

await test('T6 回想成功：挂断后异步生成 → 正文拼 [通话 M:SS] 前缀落档；LLM 参数 maxTokens 800 / temp 0.6 / 无思考无工具', async () => {
  const store = new ChatStore();
  const before = recallRowsOf(store).length;
  const beforeStg = memory.staging().length;
  const argsArr = [];
  const chat = makeCall({
    store,
    chatCompletion: async (args) => {
      if (String(args?.messages?.[0]?.content ?? '').includes('回想')) {
        argsArr.push(args);
        return { message: { content: '刚才和他通了个电话，聊起他调语音引擎的进展，语气比白天松快了不少。\n和他通了电话，聊到语音引擎，他当时挺顺。' } };
      }
      return { message: { content: '嗯，慢慢来。' } };
    },
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' })
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '语音引擎调到哪一步了' });
  assert.ok(await waitFor(() => ws.json().some((m) => m.type === 'segment_end')));
  ws.emitMessage({ type: 'stop' });
  assert.ok(await waitFor(() => ws.json().some((m) => m.type === 'ended')), 'ended 帧先行（不阻塞挂断响应）');
  assert.ok(await waitFor(() => recallRowsOf(store).length === before + 1), '挂断后异步回想应落档');
  const rows = recallRowsOf(store);
  const row = rows[rows.length - 1];
  assert.match(row.text, /^\[通话 \d+:\d{2}\] 刚才和他通了个电话/, '前缀由代码拼装 + 正文含"通了电话"语义');
  assert.equal(memory.staging().length, beforeStg, '短通话（<120s 且情绪不显著）不进 staging');
  const args = argsArr[0];
  assert.ok(args, '回想 LLM 调用发生过');
  assert.equal(args.maxTokens, 800, 'maxTokens 800（350 为所有者改拍板值；T8 真模型实证思考吃满预算上浮——recall.js RECALL_MAX_TOKENS 注）');
  assert.equal(args.temperature, 0.6, 'temperature 0.6');
  assert.equal(args.skillContext?.thinkingMode, 'off', '无思考（skillContext.thinkingMode off）');
  assert.ok(!('tools' in args), '无工具（tools 不传）');
  const user = String(args.messages?.[1]?.content ?? '');
  assert.ok(user.includes('他：语音引擎调到哪一步了'), '逐句记录含他的原句');
  assert.ok(user.includes('我：嗯，慢慢来。'), '逐句记录含她的原句（who=me → 我）');
  assert.ok(user.includes('共 1 句'), '句数在场');
});

await test('T6 staging：≥recallMinSeconds → 经 person/memory 追加暂存句；恢复缺省后短通话不追加', async () => {
  const store = new ChatStore();
  updateConfig({ voice: { call: { recallMinSeconds: 0.001 } } });   // 沙箱把阈值压到 1ms（写死回落后恢复）
  let midStg = 0;
  try {
    const beforeStg = memory.staging().length;
    const chat = makeCall({
      store,
      chatCompletion: recallStub('刚才和他通了个电话，他说引擎终于稳了。', '和他通了电话，聊到引擎，他当时挺开心。'),
      synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' })
    });
    const ws = new FakeWS();
    chat.handleConnection(ws);
    ws.emitMessage({ type: 'hello' });
    ws.emitMessage({ type: 'text', text: '引擎稳了' });
    assert.ok(await waitFor(() => ws.json().some((m) => m.type === 'segment_end')));
    ws.emitMessage({ type: 'stop' });
    assert.ok(await waitFor(() => memory.staging().length === beforeStg + 1), '过阈值通话应进 staging');
    const st = memory.staging();
    assert.ok(String(st[st.length - 1]?.text ?? '').startsWith('和他通了电话'),
      `staging 文本形状：${JSON.stringify(st[st.length - 1]?.text)}`);
  } finally {
    updateConfig({ voice: { call: { recallMinSeconds: 120 } } });
  }
  midStg = memory.staging().length;
  // 恢复缺省 120s 后的短通话：情绪不显著 → 只落 messages 一行，不进 staging
  const chat2 = makeCall({
    store,
    chatCompletion: async (args) => {
      if (String(args?.messages?.[0]?.content ?? '').includes('回想')) throw new Error('stub: recall down');
      return { message: { content: '好。' } };
    },
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' })
  });
  const ws2 = new FakeWS();
  chat2.handleConnection(ws2);
  ws2.emitMessage({ type: 'hello' });
  ws2.emitMessage({ type: 'text', text: '就一句' });
  assert.ok(await waitFor(() => ws2.json().some((m) => m.type === 'segment_end')));
  ws2.emitMessage({ type: 'stop' });
  assert.ok(await waitFor(() => recallRowsOf(store).length >= 1), '短通话仍落 messages 一行');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(memory.staging().length, midStg, '缺省阈值下短通话不进 staging');
});

await test('T6 零句通话：hello 后立即挂断 → 模板行"聊了 0 句"，不发起回想 LLM 调用', async () => {
  const store = new ChatStore();
  const before = recallRowsOf(store).length;
  let recallCalls = 0;
  const chat = makeCall({
    store,
    chatCompletion: async (args) => {
      if (String(args?.messages?.[0]?.content ?? '').includes('回想')) {
        recallCalls += 1;
        return { message: { content: '不该发生' } };
      }
      return { message: { content: '嗯？' } };
    },
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' })
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'stop' });
  assert.ok(await waitFor(() => ws.json().some((m) => m.type === 'ended')));
  assert.ok(await waitFor(() => recallRowsOf(store).length === before + 1), '零句通话也落一行模板');
  const rows = recallRowsOf(store);
  assert.match(rows[rows.length - 1].text, /\[通话 \d+:\d{2}\] 刚才和他通了个电话，聊了 0 句。/);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(recallCalls, 0, '零句不空烧 LLM（模板直出）');
});

await test('T6 输出整形：模型复刻前缀被剥 + 正文超 200 字硬截（模板正文 ≤200）', async () => {
  const store = new ChatStore();
  const before = recallRowsOf(store).length;   // 共享沙箱 DB：按增量取本测的行（§9-15 口径）
  const chat = makeCall({
    store,
    chatCompletion: recallStub(`[通话 9:99] ${'长'.repeat(300)}`),
    synthesizeRaw: async () => ({ bytes: makeWav(), mime: 'audio/wav' })
  });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '说一句' });
  assert.ok(await waitFor(() => ws.json().some((m) => m.type === 'segment_end')));
  ws.emitMessage({ type: 'stop' });
  assert.ok(await waitFor(() => recallRowsOf(store).length === before + 1), '本测回想行未落档');
  const rows = recallRowsOf(store);
  const row = rows[rows.length - 1];
  assert.ok(!row.text.includes('9:99'), '模型复刻的前缀应被剥掉（前缀归代码拼装）');
  assert.equal(row.text.length, 10 + 200, `前缀(10) + 正文硬截 200：len=${row.text.length}`);
  assert.ok(row.text.startsWith('[通话 '), '前缀契约形状保持');
});

await test('T6 纯函数：fmtCallDuration M:SS / fallbackRecallBody 模板 / emotionSignificant 文字口径', () => {
  assert.equal(fmtCallDuration(0), '0:00');
  assert.equal(fmtCallDuration(192000), '3:12', '3 分 12 秒（§8.2 样张口径）');
  assert.equal(fmtCallDuration(61000), '1:01');
  assert.equal(fmtCallDuration(-5), '0:00', '负值钳 0');
  assert.equal(fallbackRecallBody(2), '刚才和他通了个电话，聊了 2 句。', '§8.3 失败回落模板');
  // 2026-11-21 数值丢弃：情绪显著=文字口径（心绪文本变化 或 挂心事集合变化）
  const a = { mood: { text: '平静', textAt: 1 }, preoccupations: [{ id: 'p1', text: '旧事' }] };
  assert.equal(emotionSignificant(a, { mood: { text: '平静' }, preoccupations: [{ id: 'p1', text: '旧事' }] }), false, '首尾全同 → 不显著');
  assert.equal(emotionSignificant(a, { mood: { text: '松了口气' } }), true, '心绪文本变化 → 显著');
  assert.equal(emotionSignificant(a, { mood: { text: '平静' }, preoccupations: [{ id: 'p2', text: '新事' }] }), true, '挂心事集合变化（新挂/放下）→ 显著');
  assert.equal(emotionSignificant(null, { mood: { text: 'x' } }), false, '缺首值 → 不显著（不做无依据判定）');
  assert.equal(emotionSignificant(a, null), false, '缺终值 → 不显著');
});

// ═══ ⑦ T7 D19 引擎装配层与呼叫入口（night-plan §2-T7；零真实引擎——假引擎=
//     node 起服脚本 / 死端口，spawn 面经 env 覆盖注入）═════════════════════════
import http from 'node:http';

/** 本地 stub 引擎：GET / 200（健康探针）+ POST /tts 200 RIFF（TTS 预热）。
 *  listen(0)=内核随机口，返回 { origin, close }。 */
function stubEngineServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/tts') {
        res.setHeader('content-type', 'audio/wav');
        res.end(makeWav(8));
        return;
      }
      res.statusCode = 200;
      res.end('ok');
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => srv.close() });
    });
  });
}

/** 沙箱 config 引擎段复位（各用例自清，防共享单例 config 串味——§9-15 同源纪律）。 */
function resetVoiceConfig() {
  updateConfig({
    voice: {
      enabled: false,
      asr: { engine: 'off', baseUrl: '' },
      tts: { engine: 'off', baseUrl: '' },
      engine: { manage: 'auto', gpuAllow: true }
    }
  });
}

await test('T7 import 图：engine-manager.js 静态 import 无 surfaces/*、orchestrator、sender、registry、sessions、routes、store.js', () => {
  const src = fsMod.readFileSync(path.join(APP_ROOT, 'src', 'voice', 'engine-manager.js'), 'utf8');
  const staticImports = [...src.matchAll(/^\s*import\s[^;]*from\s+['"]([^'"]+)['"];?/gm)].map((m) => m[1]);
  for (const spec of staticImports) {
    assert.ok(!/surfaces|orchestrator|sender|registry|sessions|routes/.test(spec),
      `engine-manager.js 静态 import 违禁目标：${spec}`);
    assert.ok(!/(^|\/)store\.js$/.test(spec), `store 必须由装配层注入，不得 import：${spec}`);
  }
  assert.ok(staticImports.some((s) => /node:child_process/.test(s)), '拉起引擎要 child_process spawn');
  assert.ok(staticImports.some((s) => /(^|\/)capabilities\/voice\.js$/.test(s)),
    'TTS 预热应复用 capabilities/voice.js TTS_FROZEN 冻结组（单一事实源）');
  const head = src.slice(0, src.indexOf('import { spawn }'));
  for (const line of ['capabilities/voice.js 保持无状态', '只清理自己拉起的进程']) {
    assert.ok(head.includes(line), `engine-manager.js 文件头缺纪律行：${line}`);
  }
});

await test('T7 ensureForCall 快路径：引擎均未配置 → 同步返回普通对象（非 Promise），不探测不拉起', () => {
  resetVoiceConfig();
  const mgr = createEngineManager({ log: () => {} });
  const out = mgr.ensureForCall();
  assert.equal(typeof out?.then, 'undefined', '快路径必须同步返回（既有 hello→ready 同步握手不劣化）');
  assert.equal(out.asr.configured, false);
  assert.equal(out.tts.configured, false);
  assert.equal(out.bothDown, false, '配置关不算"双不可用"（拒接只针对配置在册但拉不起）');
  assert.equal(mgr.listOwned().length, 0);
});

await test('T7 ensureForCall 探测就绪：stub 引擎在跑 → ok=true spawned=false；TTS 预热一发成', async () => {
  const stub = await stubEngineServer();
  try {
    updateConfig({
      voice: {
        enabled: true,
        asr: { engine: 'gpu-local', baseUrl: stub.origin },
        tts: { engine: 'gpu-local', baseUrl: stub.origin }
      }
    });
    const mgr = createEngineManager({ log: () => {} });
    const out = await mgr.ensureForCall();   // 配置在册 → Promise（探测在"准备声音"态内）
    assert.equal(out.asr.ok, true);
    assert.equal(out.asr.spawned, false, '在跑的引擎不拉起（所有者手启进程零触碰的前提）');
    assert.equal(out.tts.ok, true);
    assert.equal(out.bothDown, false);
    assert.equal(out.warmup?.ok, true, '预热 POST /tts 应 200（stub RIFF）');
    assert.equal(mgr.listOwned().length, 0, '未拉起=零登记');
  } finally {
    stub.close();
    resetVoiceConfig();
  }
});

await test('T7 manual 只探测不拉起：引擎未运行 → ok=false + reason 登记手动口径；单项缺失不判 bothDown', async () => {
  updateConfig({
    voice: {
      enabled: true,
      asr: { engine: 'gpu-local', baseUrl: 'http://127.0.0.1:9' },
      engine: { manage: 'manual' }
    }
  });
  const mgr = createEngineManager({ log: () => {} });
  const out = await mgr.ensureForCall();
  assert.equal(out.asr.ok, false);
  assert.equal(out.asr.configured, true);
  assert.ok(out.asr.reason.includes('只探测不拉起'), `reason 应说明 manual 口径：${out.asr.reason}`);
  assert.equal(out.tts.configured, false);
  assert.equal(out.bothDown, false, '只有一边配置在册，不判双不可用');
  assert.equal(mgr.listOwned().length, 0, 'manual 零进程');
  resetVoiceConfig();
});

await test('T7 gpuAllow=false：auto 也不拉起 GPU 引擎（design §2.4"明确要求不许用 GPU 才跳过"）', async () => {
  updateConfig({
    voice: {
      enabled: true,
      tts: { engine: 'gpu-local', baseUrl: 'http://127.0.0.1:9' },
      engine: { manage: 'auto', gpuAllow: false }
    }
  });
  const mgr = createEngineManager({ log: () => {} });
  const out = await mgr.ensureForCall();
  assert.equal(out.tts.ok, false);
  assert.ok(out.tts.reason.includes('gpuAllow'), `reason 应说明 GPU 禁用：${out.tts.reason}`);
  assert.equal(mgr.listOwned().length, 0, '禁 GPU=零进程');
  resetVoiceConfig();
});

await test('T7 auto 拉起成功 → 健康探针 → spawned=true；release() 只杀登记的自拉进程（假引擎=node 起服脚本）', async () => {
  const fakePath = path.join(os.tmpdir(), `xunxi-fake-engine-${Date.now()}.mjs`);
  fsMod.writeFileSync(fakePath, [
    "import http from 'node:http';",
    'const port = Number(process.argv[2] ?? 0);',
    "http.createServer((req, res) => { res.statusCode = 200; res.end('ok'); }).listen(port, '127.0.0.1');",
    ''
  ].join('\n'), 'utf8');
  const port = 18000 + Math.floor(Math.random() * 4000);
  process.env.XUNXI_WHISPER_EXE = process.execPath;
  process.env.XUNXI_WHISPER_ARGS = JSON.stringify([fakePath, String(port)]);
  try {
    updateConfig({
      voice: { enabled: true, asr: { engine: 'gpu-local', baseUrl: `http://127.0.0.1:${port}` } }
    });
    const logs = [];
    const mgr = createEngineManager({ log: (m) => logs.push(String(m)) });
    const out = await mgr.ensureForCall();
    assert.equal(out.asr.ok, true, `假引擎应拉起就绪：${JSON.stringify(out.asr)}`);
    assert.equal(out.asr.spawned, true, '端口原无监听 → 本层拉起');
    const ownedSnap = mgr.listOwned();
    assert.equal(ownedSnap.length, 1, '自拉进程登记恰 1 条');
    assert.equal(ownedSnap[0].kind, 'asr');
    assert.ok(ownedSnap[0].pid > 0);
    // release 只杀自己登记的 PID → 端口应答消失（进程真被清）
    const killed = mgr.release();
    assert.equal(killed.length, 1);
    assert.equal(mgr.listOwned().length, 0, 'release 后登记表清空');
    const t0 = Date.now();
    let down = false;
    while (Date.now() - t0 < 5000) {
      try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); }
      catch { down = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(down, 'release 后自拉进程应已退出（端口不再应答）');
  } finally {
    delete process.env.XUNXI_WHISPER_EXE;
    delete process.env.XUNXI_WHISPER_ARGS;
    fsMod.rmSync(fakePath, { force: true });
    resetVoiceConfig();
  }
});

await test('T7 auto 拉起失败重试一次仍败 → ok=false + reason；登记表无残留（spawn error 即出登记）', async () => {
  const port = 18000 + Math.floor(Math.random() * 4000);
  process.env.XUNXI_WHISPER_EXE = path.join(os.tmpdir(), 'xunxi-no-such-engine.exe');
  delete process.env.XUNXI_WHISPER_ARGS;
  try {
    updateConfig({
      voice: { enabled: true, asr: { engine: 'gpu-local', baseUrl: `http://127.0.0.1:${port}` } }
    });
    const mgr = createEngineManager({ log: () => {} });
    const t0 = Date.now();
    const out = await mgr.ensureForCall();
    assert.equal(out.asr.ok, false, 'exe 不存在 → 拉起失败');
    assert.ok(out.asr.reason.includes('重试 1 次'), `reason 应带重试口径：${out.asr.reason}`);
    assert.ok(Date.now() - t0 < 8000, `spawn error 应秒败不空烧预算：${Date.now() - t0}ms`);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mgr.listOwned().length, 0, '失败尝试不残留登记');
  } finally {
    delete process.env.XUNXI_WHISPER_EXE;
    resetVoiceConfig();
  }
});

await test('T7 call.js hello 异步路径：引擎在册（stub 在跑）→ ready 非同步、waitFor 可达；接通后文字轮照常', async () => {
  const stub = await stubEngineServer();
  try {
    updateConfig({
      voice: {
        enabled: true,
        asr: { engine: 'gpu-local', baseUrl: stub.origin },
        tts: { engine: 'gpu-local', baseUrl: stub.origin },
        engine: { manage: 'manual' }   // 只探测：不拉起任何进程
      }
    });
    const wav = makeWav();
    const chat = makeCall({
      store: new ChatStore(),
      chatCompletion: async () => ({ message: { content: '嗯，我在呢。' } }),
      synthesizeRaw: async () => ({ bytes: wav, mime: 'audio/wav' })
    });
    const ws = new FakeWS();
    chat.handleConnection(ws);
    ws.emitMessage({ type: 'hello' });
    assert.ok(!ws.json().some((m) => m.type === 'ready'), '探测是 await——ready 不得同步出现（异步路径生效）');
    assert.ok(await waitFor(() => ws.json().some((m) => m.type === 'ready')), '探测就绪后应 ready');
    const state = ws.json().find((m) => m.type === 'state');
    assert.equal(state?.value, 'listening', 'ready 后照常进 listening');
    ws.emitMessage({ type: 'text', text: '在吗？' });
    assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'segment_end').length === 1), '接通后文字轮主链照常');
  } finally {
    stub.close();
    resetVoiceConfig();
  }
});

await test('T7 双不可用拒接（§10.2-4）：双引擎配置在册但均不可用 → error unavailable + 无 ready + close；不落回想行', async () => {
  updateConfig({
    voice: {
      enabled: true,
      asr: { engine: 'gpu-local', baseUrl: 'http://127.0.0.1:9' },
      tts: { engine: 'gpu-local', baseUrl: 'http://127.0.0.1:9' },
      engine: { manage: 'manual' }   // manual：秒判未运行，不尝试拉起（零进程零等待）
    }
  });
  const store = new ChatStore();
  const before = recallRowsOf(store).length;
  const chat = makeCall({ store });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  assert.ok(await waitFor(() => ws.json().some((m) => m.type === 'error')), '拒接应回 error 帧');
  const err = ws.json().find((m) => m.type === 'error');
  assert.equal(err?.code, 'unavailable', `code 应为 unavailable：${err?.code}`);
  assert.ok(!ws.json().some((m) => m.type === 'ready'), '拒接不发 ready');
  assert.ok(ws.closed, '拒接应断链');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(recallRowsOf(store).length, before, '零句拒绝不是通话——不落 [通话 M:SS] 行');
  resetVoiceConfig();
});

// ═══ ⑨ W2 方言适配器（night-plan-polish §2-W2 / 内部文档 voice-provider-plan.md）════
await test('W2 config：asr.{apiKey,…} + tts.{apiKey,model,voiceId,filterMarkdown,sampleRate,bitrateKbps} 全键在位；dialect 判定=voice.js dialectOf（显式键优先/engine 名派生/缺省 gpu-local）', async () => {
  const { dialectOf } = await import('../src/capabilities/voice.js');
  const a = getConfig().voice.asr;
  for (const key of ['enabled', 'engine', 'baseUrl', 'apiKey', 'model', 'timeoutMs', 'language']) {
    assert.ok(key in a, `voice.asr.${key} 缺`);
  }
  assert.equal(a.apiKey, '', 'asr.apiKey 缺省空串');
  const t = getConfig().voice.tts;
  for (const key of ['enabled', 'engine', 'baseUrl', 'apiKey', 'refVoice', 'model',
    'voiceId', 'filterMarkdown', 'format', 'sampleRate', 'bitrateKbps', 'timeoutMs']) {
    assert.ok(key in t, `voice.tts.${key} 缺`);
  }
  assert.equal(t.voiceId, 'stella', 'tts.voiceId 缺省 stella');
  assert.equal(t.filterMarkdown, true, 'tts.filterMarkdown 缺省 true');
  assert.equal(t.sampleRate, 24000, 'tts.sampleRate 缺省 24000');
  assert.equal(t.bitrateKbps, 24, 'tts.bitrateKbps 缺省 24（听感定稿值）');
  // dialect 判定单一事实源（DEFAULT_CONFIG 不含该键——deepMerge 会把缺省值变成
  // "显式键"压掉 engine 名派生，故派生在运行时做）
  assert.equal(dialectOf({}), 'gpu-local', '无键缺省 → gpu-local（现行为）');
  assert.equal(dialectOf({ engine: 'gpu-local' }), 'gpu-local', 'engine 名派生');
  assert.equal(dialectOf({ engine: 'deepseek-tools' }), 'deepseek-tools', 'engine 直接填方言名');
  assert.equal(dialectOf({ dialect: 'openai-compat', engine: 'gpu-local' }), 'openai-compat', '显式 dialect 优先');
  assert.equal(dialectOf({ dialect: 'bogus' }), null, '显式方言键非法 fail-closed');
  assert.equal(dialectOf({ engine: 'off' }), 'gpu-local', 'engine=off（闸先行已拦，此处只看派生值）');
});

await test('W2 方言 fail-closed：dialect 非法值 → 闸 null 零调用（asr.available false / synthesizeRaw null）', async () => {
  const { voice } = await import('../src/capabilities/voice.js');
  updateConfig({
    voice: {
      enabled: true,
      asr: { engine: 'gpu-local', baseUrl: 'http://127.0.0.1:1', dialect: 'bogus' },
      tts: { engine: 'gpu-local', baseUrl: 'http://127.0.0.1:1', dialect: 'bogus' }
    }
  });
  assert.equal(voice.asr.available(), false, '非法方言 ASR 闸应关');
  assert.equal(await voice.tts.synthesizeRaw('嗯'), null, '非法方言 TTS 闸应关');
  resetVoiceConfig();
});

await test('W2 下行双模：tts.dialect=deepseek-tools → ready 后 audio-mode{pcm,24000}；二进制=PCM 流分块（帧边界无语义）', async () => {
  // 4800B PCM16 数据分 3 块（ReadableStream 顺序出）
  const data = Buffer.alloc(4800);
  data.writeInt16LE(100, 0);
  const chunks = [data.subarray(0, 2000), data.subarray(2000, 3500), data.subarray(3500)];
  let cursor = 0;
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async () => ({ message: { content: '好呀。' } }),
    synthesizeRaw: async () => ({
      stream: new ReadableStream({
        pull(controller) {
          if (cursor < chunks.length) { controller.enqueue(new Uint8Array(chunks[cursor])); cursor += 1; }
          else controller.close();
        }
      }),
      sampleRate: 24000
    })
  });
  updateConfig({ voice: { enabled: true, tts: { dialect: 'deepseek-tools' } } });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '嗯' });
  assert.ok(await waitFor(() => ws.json().some((m) => m.type === 'segment_end')), 'pcm 段未收口');
  const mode = ws.json().find((m) => m.type === 'audio-mode');
  assert.ok(mode, 'ready 后缺 audio-mode 帧');
  assert.equal(mode.value, 'pcm', 'audio-mode.value 应为 pcm');
  assert.equal(mode.sampleRate, 24000, 'audio-mode.sampleRate 应为 24000');
  assert.equal(ws.bin().length, 3, `PCM 流应分 3 帧下发，got=${ws.bin().length}`);
  assert.equal(Buffer.concat(ws.bin()).length, 4800, '分块拼合=流全长（无丢块无重复）');
  const starts = ws.json().filter((m) => m.type === 'segment_start');
  assert.equal(starts.length, 1, '整段一对 start/end（多块同段）');
  resetVoiceConfig();
});

await test('W2 下行双模：gpu-local/openai 方言（segment 缺省）不发 audio-mode 帧、整段一帧（现行为不变）', async () => {
  const wav = makeWav();
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async () => ({ message: { content: '好呀。' } }),
    synthesizeRaw: async () => ({ bytes: wav, mime: 'audio/wav' })
  });
  updateConfig({ voice: { enabled: true, tts: { dialect: 'gpu-local' } } });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '嗯' });
  assert.ok(await waitFor(() => ws.json().some((m) => m.type === 'segment_end')));
  assert.ok(!ws.json().some((m) => m.type === 'audio-mode'), 'segment 模式不发 audio-mode（向后兼容旧客户端）');
  assert.deepEqual(ws.bin(), [wav], '整段一帧');
  resetVoiceConfig();
});

await test('W2 PCM 流中途断：segment_end 收口 + 按失败计（text_fallback）；连续 2 败 → 整通降级', async () => {
  let replyN = 0;
  const chat = makeCall({
    store: new ChatStore(),
    chatCompletion: async (args) => {
      // hello 摘要与正文轮共用 stub（按调用序取——文件头警告）：摘要按其指令文案识别
      if (String(args?.messages?.[0]?.content ?? '').includes('压缩成一段话')) {
        return { message: { content: '摘要。' } };
      }
      replyN += 1;
      return { message: { content: replyN === 1 ? '第一句。第二句说完了呀。' : '再来一轮的话。' } };
    },
    synthesizeRaw: async () => {
      let pulls = 0;   // 每段新流各自归零（每段都是"首块送达后中断"）
      return {
        // W2 契约形状 {stream, sampleRate}（裸 stream 缺 .stream 字段会落 bytes
        // 失败路径——不是本测的对象）
        stream: new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(new Uint8Array(Buffer.alloc(1600)));
            else controller.error(new Error('网络断（stub）'));   // 首块送达后中断
          }
        }),
        sampleRate: 24000
      };
    }
  });
  updateConfig({ voice: { enabled: true, tts: { dialect: 'deepseek-tools' } } });
  const ws = new FakeWS();
  chat.handleConnection(ws);
  ws.emitMessage({ type: 'hello' });
  ws.emitMessage({ type: 'text', text: '说点什么' });
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'text_fallback').length >= 2), '两段都应回退文字');
  assert.equal(ws.bin().length, 2, '每段各收到 1 个中断前数据块');
  ws.emitMessage({ type: 'text', text: '再说' });
  assert.ok(await waitFor(() => ws.json().filter((m) => m.type === 'text_fallback').length >= 3), '连续 2 败 → 下一轮整段一帧回退');
  const lastFb = ws.json().filter((m) => m.type === 'text_fallback').pop();
  assert.equal(lastFb.text, '再来一轮的话。', '整通降级=整段原样一帧出');
  resetVoiceConfig();
});

await test('W2 engine-manager：云端方言（deepseek-tools）不可达 → 只探测不拉起（owned 空、reason 登记）', async () => {
  updateConfig({
    voice: {
      enabled: true,
      asr: { engine: 'off' },
      tts: { engine: 'gpu-local', baseUrl: 'http://127.0.0.1:9', dialect: 'deepseek-tools' },
      engine: { manage: 'auto' }
    }
  });
  const mgr = createEngineManager({ log: () => {} });
  const status = await mgr.ensureForCall();
  assert.equal(status.tts?.configured, true, '云端方言视为已配置');
  assert.equal(status.tts?.ok, false, '不可达 → 不 ok');
  assert.equal(status.tts?.spawned, false, '绝不拉起本地进程');
  assert.ok(String(status.tts?.reason ?? '').includes('不拉起'), `reason 应说明云端方言不拉起：${status.tts?.reason}`);
  assert.equal(mgr.listOwned().length, 0, 'owned 登记表应空（零 spawn）');
  assert.equal(status.bothDown, false, 'asr 未配置 → bothDown false');
  resetVoiceConfig();
});

// 沙箱清理（验完删；先 closeDb 释放 sqlite 句柄——cli-body.mjs:92 EPERM 同根因的在册修法）
try {
  closeDb();
} catch { /* ignore */ }
try {
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  console.log(`[voice-call-test] 沙箱已清理 ${DATA_ROOT}`);
} catch (error) {
  console.warn(`[voice-call-test] 沙箱保留（清理失败）：${DATA_ROOT} ${error?.message ?? error}`);
}

console.log(`\n[voice-call-test] ${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
