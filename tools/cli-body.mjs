// tools/cli-body.mjs —— CLI body（night-plan §5.4 / 整改清单 §7-P2；Q11 起 web-only）。
// stdin 读一行文本 → 构造 InboundEvent（contracts.js §2.1 信封）→ orchestrator.submit(event, io)
// → 打印收到的 intents。全程不联网、不调模型：沙箱数据根 + 零网络硬闸 +
// 记录型 web 身体（真 createWebAdapter 包 emit，坑 #9 {sent,failed} 形状）。
// 未配置模型时触发批按现有闸门保留未读（wake 自然跳过，消息不丢）；
// 出站演示用一条已到点提醒走真实管线：#fireReminder → #emitOutbound → registry.route
// → 身体（Q11：QQ 身体已归档 legacy/qq-adapter，DEFAULT_SURFACE='web'，本工具注册
// web 记录型身体；submit 的 io 落点=registry，night-plan §5.2）。
// 运行：echo 在吗 | node tools/cli-body.mjs [--chat main] [--text 直接给文本]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

// ── 沙箱数据根（绝不碰真实 data/）+ env 先于动态 import（模块 import 期解析 DATA_ROOT）──
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'xunxi-cli-body-'));
process.env.XUNXI_DATA_DIR = path.join(SANDBOX, 'data');
let fetchCalls = 0;
globalThis.fetch = async (url) => { fetchCalls += 1; throw new Error(`ZERO-NETWORK：不该发生的 fetch → ${String(url)}`); };

// Q10 chatKey 收敛 + Q11 DEFAULT 'web'（night-plan §Q10/§Q11）：cid 缺省 'main'——存储键
// 单一时间线；surface 'web' 带前缀路由 → orchestrator 路由键 'web:main'，registry.route
// 落本工具注册的 web 记录型身体。
const CHAT = arg('chat', 'main');
let TEXT = arg('text', '');
if (!TEXT) TEXT = (fs.readFileSync(0, 'utf8').split(/\r?\n/).find((l) => l.trim()) ?? '').trim();
if (!TEXT) { console.error('usage: echo 文本 | node tools/cli-body.mjs [--chat main] [--text 文本]'); process.exit(2); }

const { Orchestrator } = await import('../src/orchestrator.js');
const { ChatStore } = await import('../src/kernel/store.js');
const { SessionRegistry } = await import('../src/kernel/sessions.js');
const { ReminderStore } = await import('../src/reminders.js');
const { createWebAdapter } = await import('../src/surfaces/web/adapter.js');
const { registry } = await import('../src/surfaces/registry.js');

// 记录型 web 身体：真 adapter 包 emit 登记收到的 intent（坑 #9：{sent,failed} 形状不变），
// broadcast/onSent 记账供断言；零网络零外部依赖。
const intents = [];
const broadcasts = [];
const sentArchives = [];
const body = createWebAdapter({
  broadcast: (type, payload) => broadcasts.push({ type, payload }),
  onSent: (report) => sentArchives.push(report)
});
const baseEmit = body.emit.bind(body);
body.emit = async (intent) => { intents.push(intent); return baseEmit(intent); };   // 身体边界登记真实 intent
registry.register(body);

const orch = new Orchestrator({
  store: new ChatStore(0), stickers: null, sessions: new SessionRegistry(0),
  emit: () => {}, reminders: new ReminderStore()
});

// InboundEvent（contracts.js §2.1）：id='web:local:cli-1'，visibility private，addressed=true
const event = {
  id: 'web:local:cli-1', surface: 'web', conversationId: CHAT, type: 'message',
  actor: { id: 'owner', name: 'CLI 用户' }, ts: Date.now(),
  payload: { text: TEXT, attachments: [], meta: {} },
  hints: { addressed: true, urgency: 'normal' }, visibility: 'private'
};
const io = {
  capabilities: () => body.capabilities(),
  emit: (intent) => {
    const target = intent?.conversationId ?? CHAT;   // M1/D19：显式 conversationId 不覆盖
    return registry.route(target).emit({ ...intent, conversationId: target });
  }
};
const submit1 = await orch.submit(event, io);
const submit2 = await orch.submit({ ...event }, io);   // 同 id 重放 → 幂等（store 去重，silent）

// 出站演示（无需模型）：一条已到点提醒 → 真实 #fireReminder → #emitOutbound → registry → 身体
orch.reminders.add({ chatKey: CHAT, text: 'CLI body 出站演示', dueAt: Date.now() - 1000, createdBy: 'cli-body' });
orch.startReminderLoop();
const deadline = Date.now() + 12000;
while (intents.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
orch.stopReminderLoop();

console.log(JSON.stringify({
  input: { conversationId: CHAT, text: TEXT },
  submit: [submit1, submit2],
  stored: { chat: CHAT, unread: orch.store.unreadCount(CHAT) },
  intents,
  broadcasts,
  sentArchives,
  fetchCalls,
  note: '未配置模型：触发批按现有闸门保留未读（wake 跳过，消息不丢）；intents 经身体边界捕获（Q11 起 web-only）'
}, null, 2));
const { closeDb } = await import('../src/storage/db.js');
closeDb();   // Windows 下 DB 连接未关时 rmSync 删沙箱报 EPERM（walkie §9 沿袭三夜的已知遗留，2026-11-19 修）
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(0);
