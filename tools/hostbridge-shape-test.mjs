// hostbridge-shape-test.mjs —— P1 出站收口验收断言（night-plan §4.7：hostBridge 返回形状
// 与旧一致 + 身体意图层单路径）。
//
// 运行：cd 代码根 && node tools/hostbridge-shape-test.mjs   （退出码 0=全过 / 1=有失败）
//
// 零网络、零真实数据（纪律 #6）：
//   · 数据根重定向到临时目录（XUNXI_DATA_DIR，先于 import 设置）；
//   · fetch 掷错计数（零网络硬闸）；
//   · registry 的 web 身体换成测试内 spy 身体（不广播真 SSE）。
//
// 覆盖（Q11 基线改写）：
//   A  hostBridge.sendText → registry.route(chatKey).emit(
//      {type:'text',payload:{text:[…]},conversationId}) 到达身体，返回值映射回插件的旧形状
//      {ok,via:'core',sent,messageId,deduped}（messageId 从身体 {sent,failed} 透传）。
//      前提更新（Q11）：QQ 身体归档、DEFAULT_SURFACE='web'、config.surface.intents
//      回滚开关已摘——路由全单路径，任意 chatKey（含历史 private: 前缀）都落 web 身体。
//   B  回滚开关死亡证明（Q11 新增，加严不弱化）：向 config 写入遗留键
//      surface.intents=false 后发送**仍**命中身体——开关无消费面（原 B/C2 段的
//      "直连路径"断言前提随分支摘除死亡，改写为死亡证明）。
//   C  #fireReminder（提醒）：统一出站口 → 身体 text intent；markFired 语义不变。
//   D  web 身体 typing 分支：emit → chat-typing 广播 + {ok:true}（原协议端
//      setInputStatus 翻译随身体归档死亡，改写 web 语义）。
//   E  入站形状（Q11 改写）：app 装配面零协议端句柄（app.onebot 不存在——原 E1
//      "分发断开"断言前提死亡）；submitIo 登记机制（web 入站 /api/web/send 同用）
//      经 orchestrator.submit(event, io) 直驱保持覆盖（io.emit 走 registry 到达身体）。
//
// 注：#typingStart/#typingStop 的定时器守卫在 orchestrator 内部，私有方法无法从测试
//     直达；其 emit 调用点由 grep 取证（src/orchestrator.js #typingStart/#typingStop），
//     翻译语义由 D 段覆盖。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');

// ── 沙箱数据根 + env 先于 import（config.js 在模块加载期读 DATA_DIR）─────────────
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'xunxi-hostbridge-test-'));
process.env.XUNXI_DATA_DIR = path.join(SANDBOX, 'data');
fs.mkdirSync(process.env.XUNXI_DATA_DIR, { recursive: true });

// ── 零网络硬闸 ────────────────────────────────────────────────────────────────
let fetchCalls = 0;
globalThis.fetch = async (url) => {
  fetchCalls += 1;
  throw new Error(`ZERO-NETWORK：不该发生的 fetch → ${String(url)}`);
};

// ── 断言器 ────────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  PASS ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}`); }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), `${label}（got=${JSON.stringify(a)} want=${JSON.stringify(b)}）`); }
function section(name) { console.log(`\n── ${name} ──`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const imp = (...segs) => import(pathToFileURL(path.join(APP_ROOT, ...segs)).href);

let app = null;
try {
  const { createApp } = await imp('src', 'app.js');
  const { getHostBridge } = await imp('src', 'plugin-loader.js');
  const { registry } = await imp('src', 'surfaces', 'registry.js');
  const { createWebAdapter } = await imp('src', 'surfaces', 'web', 'adapter.js');
  const { Orchestrator } = await imp('src', 'orchestrator.js');
  const { updateConfig, getConfig } = await imp('src', 'kernel', 'config.js');

  // 装配（不 start()：不起 HTTP、不跑各循环；Q11 起无协议端连接段）
  app = createApp({ log: () => {} });
  const realAdapter = registry.get('web');
  ok(!!realAdapter && realAdapter.surface === 'web', 'A0 createApp 已注册 web 身体（registry 单例）');
  eq(registry.list().map((b) => b.surface), ['web'], 'A0a registry.list() 只有 web（Q11 验收断言）');
  ok(app.onebot === undefined && app.sender === undefined, 'A0b 装配返回对象零协议端/发送队列句柄（Q11 摘 this 持有）');

  // spy 身体：登记收到的 intent，返回带 messageId 的 {sent,failed}（真实形状同款）
  const seenIntents = [];
  registry.register({
    surface: 'web',
    capabilities: () => realAdapter.capabilities(),
    async emit(intent) {
      seenIntents.push(intent);
      return { sent: [{ text: 'x', messageId: 'MID-SPY-1' }], failed: [] };
    }
  });

  const hb = getHostBridge();
  ok(typeof hb?.sendText === 'function', 'A0c hostBridge.sendText 在场');

  // ═══ A. hostBridge.sendText：单路径 → 身体意图层 ═══
  section('A. hostBridge.sendText → 身体意图层（Q11：单路径，无回滚分支）');
  eq(getConfig().surface, undefined, 'A1 config.surface 段已摘（回滚开关键不存在）');
  const r1 = await hb.sendText('private:12345', '  好的  ');
  eq(seenIntents, [{
    type: 'text',
    payload: { text: ['好的'] },
    conversationId: 'private:12345'
  }], 'A2 身体收到 1 个 text intent（payload.text=去空格后的单元素数组，conversationId=chatKey）');
  eq(r1, { ok: true, via: 'core', sent: 1, messageId: 'MID-SPY-1', deduped: false },
    'A3 返回旧形状逐字段一致：{ok,via,sent,messageId,deduped}（messageId 透传自身体 {sent,failed}）');
  eq(Object.keys(r1), ['ok', 'via', 'sent', 'messageId', 'deduped'], 'A4 返回键集合与旧形状完全一致（不多不少）');
  ok(seenIntents[0].id === undefined, 'A5 intent 不带 id（io 信封 intentId 属 brain.submit 写路径，当前无消费方）');

  // 空文本仍抛旧错误（行为不变）
  let emptyThrow = '';
  try { await hb.sendText('private:12345', '   '); } catch (e) { emptyThrow = String(e?.message ?? e); }
  eq(emptyThrow, '消息内容为空', 'A6 空文本照旧抛「消息内容为空」');

  // ═══ C1. 提醒（#fireReminder）：统一出站口 → 身体 ═══
  section('C1. 提醒 #fireReminder → 统一出站口（单路径）');
  {
    const senderCalls = [];
    const fired = [];
    const orch = new Orchestrator({
      store: {}, stickers: {}, sessions: {},
      emit: () => {},
      reminders: {
        due: () => (fired.length ? [] : [{ id: 't1', chatKey: 'private:12345', text: '该喝水了' }]),
        markFired: (id) => fired.push(id),
        prune: () => {}
      }
    });
    const before = seenIntents.length;
    orch.startReminderLoop();
    const deadline = Date.now() + 12000;
    while (seenIntents.length === before && Date.now() < deadline) await sleep(200);
    orch.stopReminderLoop();
    // E5（night-plan-qq-exit Q1）：#fireReminder 构造 intent 补 sourceEventId——提醒无
    // submit 语境 → null。字段顺序 = 构造点写入序：type/payload/sourceEventId，再经
    // #emitOutbound spread 补 conversationId。
    eq(seenIntents.slice(before), [{
      type: 'text',
      payload: { text: ['⏰ 提醒：该喝水了'] },
      sourceEventId: null,
      conversationId: 'private:12345'
    }], 'C1a 提醒经统一出站口到身体（text intent，前缀「⏰ 提醒：」，E5 带 sourceEventId=null）');
    ok(senderCalls.length === 0, 'C1b 零直连发送调用（编排器无 sender 句柄可直呼——Q11 摘持有）');
    eq(fired, ['t1'], 'C1c 发送成功后 markFired（调度语义不变）');
    orch.reminders = null;   // 防止 stop 后残留循环再触发
  }

  // ═══ B. 回滚开关死亡证明（Q11 新增）：遗留键写入后仍走身体 ═══
  section('B. 回滚开关死亡证明：surface.intents=false 写入后发送仍命中身体');
  updateConfig({ surface: { intents: false } });
  const beforeB = seenIntents.length;
  const r2 = await hb.sendText('private:12345', '开关死亡测试');
  eq(seenIntents.length, beforeB + 1, 'B1 遗留键写入后发送仍命中身体（开关无消费面——分支已随 QQ 身体归档摘除）');
  eq(r2, { ok: true, via: 'core', sent: 1, messageId: 'MID-SPY-1', deduped: false },
    'B2 返回形状不变（同一身体应答）');
  ok(fetchCalls === 0, 'B3 全程零 fetch');

  // ═══ D. web 身体 typing 分支（Q11 改写：chat-typing 广播）═══
  section('D. web 身体 emit(typing) → chat-typing 广播');
  {
    const broadcasts = [];
    const adapter = createWebAdapter({
      broadcast: (type, payload) => broadcasts.push([type, payload]),
      onSent: () => {}
    });
    const on = await adapter.emit({ type: 'typing', payload: { on: true }, conversationId: 'main' });
    const off = await adapter.emit({ type: 'typing', payload: { on: false }, conversationId: 'main' });
    ok(on?.ok === true && off?.ok === true, 'D1 typing on/off 不抛错');
    eq(broadcasts, [
      ['chat-typing', { conversationId: 'main', on: true }],
      ['chat-typing', { conversationId: 'main', on: false }]
    ], 'D2 翻译逐字节：chat-typing 广播（conversationId, on）');
    eq(await adapter.emit({ type: 'poke', conversationId: 'main', payload: {} }),
      { ok: false, error: 'unsupported type' }, 'D3 别的身体的词表（poke）→ unsupported，不抛错');
    eq(broadcasts.length, 2, 'D4 unsupported type 零广播');
  }

  // ═══ E. 入站形状（Q11 改写）：装配面零协议端句柄 + submitIo 登记机制保持覆盖 ═══
  section('E. 入站形状：装配面零协议端句柄（Q11）+ submitIo 登记机制（web 同路径）');
  {
    // E1（Q11 改写）：app 装配面零协议端句柄——原 E1「四类事件投 app.onebot.onEvent 零入库」
    //     断言前提随句柄摘除死亡（onebot.js/入站管线已归档 legacy/，事件无投递口可言）。
    //     以 A0b 的 app.onebot/app.sender undefined 断言承接死亡证明。
    //
    // E2 submitIo 登记机制：InboundEvent → orchestrator.submit(event, io) 直驱
    //     （web 入站 /api/web/send 构造同一形状走同一机制）。
    //     Q10/Q11 口径：conversationId 收存储键 'main'（web 入站真实形状）——submit 按
    //     surface 推导路由键 'web:main'（routeKeyOf）并以其为 submitIo 簿记键；io.emit 的
    //     registry 兜底用裸 'main' 落 DEFAULT web 身体（当前 spy）。
    const sub = await app.orchestrator.submit({
      id: 'probe:q11-e2', surface: 'web', conversationId: 'main', type: 'message',
      actor: { id: 'owner', name: '我' }, ts: Date.now(),
      payload: { text: 'io 登记探针' }, hints: { addressed: true }, visibility: 'private'
    }, {
      capabilities: () => ({}),
      emit: (intent) => {
        const target = intent?.conversationId ?? 'main';
        return registry.route(target).emit({ ...intent, conversationId: target });
      }
    });
    ok(sub?.ok === true, 'E2a orchestrator.submit(event, io) 直驱入库（web 入站同形状）');
    const ioReg = app.orchestrator.submitIo.get('web:main');
    ok(ioReg && typeof ioReg.emit === 'function' && typeof ioReg.capabilities === 'function',
      'E2b submit 已把 io 登记到会话粒度（BrainIo：emit/capabilities；簿记键=路由键 web:main）');
    eq(typeof (ioReg?.emit?.({ type: 'text', payload: { text: ['io 探针'] } }) ), 'object',
      'E2c 登记的 io.emit 可用（落点=registry.route → 当前 spy 身体）');
    ok(seenIntents.some((i) => i?.payload?.text?.[0] === 'io 探针'), 'E2d io.emit 经 registry 到达身体（io.emit 走 registry，night-plan §5.2）');
  }

  // ═══ 收尾 ═══
  // Q11：config.surface 段已摘（A1），B 段写入的遗留键 deepMerge 并入后零消费面，
  // 无需还原（每 gate 独立进程，沙箱数据根即抛）。

  section('零网络总闸');
  eq(fetchCalls, 0, 'Z1 全程零 fetch 调用');

  console.log(`\n${failures.length ? 'HOSTBRIDGE SHAPE TEST FAILED' : 'HOSTBRIDGE SHAPE TEST OK'}：${passed} 项通过，${failures.length} 项失败`);
  process.exitCode = failures.length ? 1 : 0;
} catch (error) {
  console.error('[hostbridge-shape-test] 运行异常:', error?.stack ?? error);
  process.exitCode = 1;
} finally {
  try { await app?.stop(); } catch { /* 沙箱内尽力清理 */ }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
}
