// 核心功能纯逻辑测试（Q15 收编）：mind 提示段 + diary checkDue。
// 数据隔离：先设 XUNXI_DATA_DIR 到临时目录，再动态 import（person/config 在
// import 期解析数据根）。不调模型、不发请求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xunxi-core-feature-tests-'));
process.env.XUNXI_DATA_DIR = DATA_ROOT;

const now = Date.now();

// 先落一份最小配置：日记在 00:00-23:59 活跃、晚安后立即放行、每天一篇。
fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.writeFileSync(path.join(DATA_ROOT, 'config.json'), JSON.stringify({
  api: { model: 'test-model' },
  diary: {
    enabled: true,
    maxPerDay: 1,
    minGapMinutes: 0,
    nothingNewMinutes: 0,
    impulseEnabled: true,
    activeFrom: '00:00',
    activeTo: '23:59',
    maxEntryChars: 500,
    sendEnabled: false,
    sendTo: '',
    bedtimeOnly: true,
    bedtimeWords: '晚安,睡了',
    bedtimeGraceMinutes: 0,
    fallbackAt: '23:30',
    minMessagesForDiary: 1
  },
  ui: { reasoningMaxChars: 0 }
}, null, 2));

const mind = await import('../src/person/mind.js');
const diaryStore = await import('../src/person/diary.js');
const promptMod = await import('../src/prompt.js');
const { ChatStore } = await import('../src/kernel/store.js');
const diary = await import('../src/capabilities/reflection/diary.js');

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

// ── mind 提示段 ──────────────────────────────────────────────────────────
await test('mind：noteMood → snapshot → renderMindSection 带情绪与心事', () => {
  const r = mind.noteMood({ mood: '有点闷', topics: ['等他回消息'], source: 'test' });
  assert.ok(r, 'noteMood 应成功');
  const section = promptMod.renderMindSection(mind.snapshot());
  assert.ok(section.includes('你此刻的心绪'));
  assert.ok(section.includes('有点闷'));
  assert.ok(section.includes('等他回消息'));
  assert.ok(section.includes('mind_note'));
});

await test('mind：settle 放下一件事后提示段不再包含它', () => {
  mind.settle({ keyword: '等他' });
  const section = promptMod.renderMindSection(mind.snapshot());
  assert.ok(!section.includes('等他回消息'));
});

await test('mind：无情绪/无事时 renderMindSection 返回空串（不花 token）', () => {
  const s = mind.snapshot();
  s.mood.text = '';
  s.preoccupations = [];
  assert.equal(promptMod.renderMindSection(s), '');
});

// ── diary checkDue ───────────────────────────────────────────────────────
await test('diary：互道晚安后 checkDue 放行（writeGate 自己从 store 找晚安）', () => {
  const store = new ChatStore();
  const t1 = now - 20 * 60 * 1000;
  const t2 = now - 19 * 60 * 1000;
  store.appendIncoming('main', {
    mid: 't1', ts: t1, senderId: 'owner', senderName: '我', text: '晚安', media: [], atMe: true, atNames: []
  });
  store.appendSelf('main', { text: '晚安', ts: t2, mid: 't2' });
  assert.equal(diary.checkDue({ store, now }), true, '晚安成对 + grace 已过 → 放行');
});

await test('diary：今天已写过一篇 → checkDue 不再放行', () => {
  const store = new ChatStore();
  diaryStore.append({ content: '今天已经写过。', at: now, source: 'test' });
  assert.equal(diary.checkDue({ store, now }), false, 'maxPerDay=1 已满 → 不放行');
});

console.log(`\n[core-feature-tests] ${pass} 通过，${fail} 失败（数据根 ${DATA_ROOT}）`);
process.exit(fail ? 1 : 0);
