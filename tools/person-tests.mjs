#!/usr/bin/env node
// person-tests.mjs —— 人格内核行为回归（night-plan §3 P0 / §10 常驻门禁；整改清单 §6-P9）
//
// 覆盖规则（表驱动 + node:assert/strict，零测试框架、零网络、零模型调用）：
//   1. memory.upsertFact：supersede 链、kind/subject/content/mid/key 校验；V3 起 facts/
//      cards/staging 真身=DB 三表——文件级断言（坏行保留/tmp+rename）退役为 DB 等价
//      断言（supersede 原子、事务回滚、extra 兜底），逐项对照表见交接内部文档 handoff-sqlite-v2.md 夜3
//   2. mind.apply：preoccupations 门控添加/去重（isSameTopic）+ snapshot 过期清理
//      （2026-11-21 数值丢弃：valence/arousal/energy 轴与 mind.decay 已移除——数值不进
//      提示词即丢弃，所有者裁定；relationship 整体丢弃，原第 1/4 组测试随之退役）
//   3. prompt 渲染面：召回/今日暂存预算、生命周期接线（原关系档位/自我叙事断言已随
//      relationship/self 丢弃退役）
//
// 数据隔离（硬规则 #6：不得污染真实 data/person/*；历史归档件已移出数据根）：
//   进程第一件事设 XUNXI_DATA_DIR → os.tmpdir() 下一次性临时目录。relationship/memory/
//   relationship/memory/mind/self 全部在模块 import 时解析 DATA_ROOT，因此必须先设 env 再动态 import。
//   本文件用 import.meta.url 解析自身路径，不依赖 process.cwd()。
//
// 用法：node tools/person-tests.mjs    → 全绿 exit 0；任何失败 exit 1
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

// ── ① 数据根先行：必须先于任何 person 模块 import 生效 ──
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xunxi-person-tests-'));
process.env.XUNXI_DATA_DIR = DATA_ROOT;
const PERSON_DIR = path.join(DATA_ROOT, 'person');

// ── ② env 生效后再 import（此时各模块锁定的 DATA_ROOT 才是临时目录）──
const memory = await import('../src/person/memory.js');
const mind = await import('../src/person/mind.js');
// person/relationship 已于 2026-11-21 整体丢弃——原第 1 组测试（apply/bond/seed）随之退役。

// V3（storage-v2）：facts/cards/staging 真身已切 xunxi.db 三表——facts.jsonl 等文件不再
// 被 memory.js 读写，文件级白盒 reset（原 rm(FACTS_FILE)）退役为 DB 行 reset（见下）。
// V4（storage-v2）：mind/relationship/self/life 真身已切 xunxi.db state 表——文件级白盒
// （原 rm(MIND_FILE)/writeMindState 直写 mind.json）同样退役为 DB 行等价操作（对照表见
// 交接内部文档 handoff-sqlite-v2.md 夜4）。

// DB 后端的沙箱 reset（文件时代 rm(FACTS_FILE)/rmSync(cards 目录)/rm(REL_FILE)/
// rm(MIND_FILE)/rm(lifeStore.lifeFile) 的等价物）。
// dbmod 在文末 storage 组定义（const）——本 helper 只在测试体执行期调用（队列在文件尾
// 统一 await 执行），届时 dbmod 必已初始化；先于此调用的唯一路径不存在。
const resetFacts = () => dbmod.getDb().prepare('DELETE FROM facts').run();
const resetCards = () => dbmod.getDb().prepare('DELETE FROM cards').run();
const stateRowOf = (key) => dbmod.getDb().prepare('SELECT key, json, updatedAt FROM state WHERE key = ?').get(key) ?? null;
const resetStateKey = (key) => dbmod.getDb().prepare('DELETE FROM state WHERE key = ?').run(key);
const resetMind = () => resetStateKey('mind');
const resetLife = () => resetStateKey('life');
/** 白盒：直接落一行 state（文件时代直写 *.json 的等价物——白盒层级不变，存储面换 DB）。 */
const putStateRow = (key, obj) => dbmod.transaction(() => {
  dbmod.getDb()
    .prepare('INSERT INTO state (key, json, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updatedAt = excluded.updatedAt')
    .run(key, JSON.stringify(obj), Number.isFinite(Number(obj.updatedAt)) ? Number(obj.updatedAt) : Date.now());
});

// ── 迷你测试运行器 ──
// 设计：test()/table() 只把用例按定义顺序入队，文件末尾统一顺序 await 执行。
// （若直接在定义点跑 async 用例，用例体会落进微任务队列 —— 汇总统计和退出码会在
//   任何断言之前执行，exit 恒为 0。这是本文件自己踩过的坑，勿改回定义点即跑。）
let passed = 0;
const failures = [];
const queue = [];
function group(label) {
  queue.push({ header: label });
}
function test(name, fn) {
  queue.push({ name, fn });
}
/** 表驱动：rows 每行 {name, ...}，fn(row) 内自行断言 */
function table(g, rows, fn) {
  for (const row of rows) test(`${g} :: ${row.name}`, () => fn(row));
}
/** 浮点比较（relationship/mind 的累乘会产生 0.6234999999 这类尾巴） */
function closeTo(actual, expected, eps = 1e-9, label = '') {
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) <= eps,
    `${label} 期望 ${expected}，实际 ${actual}（差 ${Math.abs(actual - expected)}）`
  );
}
function rm(p) {
  fs.rmSync(p, { force: true });
}
/** 白盒：直接落一行 mind 状态（state 表 key='mind'；2026-11-21 数值丢弃后的纯文字形状）。 */
function writeMindState(over = {}) {
  const now = Date.now();
  const state = {
    version: 1,
    mood: { text: '', textAt: 0, updatedAt: now },
    body: { sleepy: false, hungry: false },
    preoccupations: [],
    intentions: [],
    updatedAt: now,
    ...over
  };
  putStateRow('mind', state);
}
console.log(`[person-tests] 数据根（临时）: ${DATA_ROOT}\n`);

group('memory.upsertFact');

test('supersede 链：唯一类 kind 同 key 顶旧，旧条目标 superseded 并回指新条', () => {
  resetFacts();
  memory.upsertFact({ kind: 'identity', subject: 'other', content: '他叫星野' });
  memory.upsertFact({ kind: 'identity', subject: 'other', content: '他叫星野，QQ 1008645321' });
  // 注意：upsertFact 返回的是"本次新增"对象，旧条目的状态变化只落在文件里 —— 用 facts() 读真相
  let all = memory.facts({ status: 'all' });
  assert.equal(all.length, 2);
  assert.equal(all[0].status, 'superseded');
  assert.equal(all[0].supersededBy, `identity:other@${all[1].validFrom}`);
  assert.equal(all[1].status, 'active');
  assert.equal(memory.facts({ status: 'active' }).length, 1);
  memory.upsertFact({ kind: 'identity', subject: 'other', content: '他叫星野（阿澄）' });
  all = memory.facts({ status: 'all' });
  assert.equal(all.length, 3);
  assert.equal(memory.facts({ status: 'superseded' }).length, 2, '链上两条都该是 superseded');
  assert.equal(all[1].supersededBy, `identity:other@${all[2].validFrom}`, '第 2 条被第 3 条顶替');
  assert.equal(memory.facts({ status: 'active' })[0].content, '他叫星野（阿澄）');
});

// 2026-11-11 key 修复：可累积类 kind 必须并列共存。
// 原规则下 address_name/promise/relationship 各只能活一条，实测 18 条丢 12 条。
test('可累积类并存：称呼/承诺/关系多条互不顶替', () => {
  resetFacts();
  memory.upsertFact({ kind: 'address_name', subject: 'other', content: '他叫阿澄' });
  memory.upsertFact({ kind: 'address_name', subject: 'other', content: '我喊他傻雨' });
  memory.upsertFact({ kind: 'promise', subject: 'other', content: '他一直都在，哪儿也不走' });
  memory.upsertFact({ kind: 'promise', subject: 'other', content: '早安晚安不缺席' });
  memory.upsertFact({ kind: 'relationship', subject: 'other', content: '我是他的例外' });
  const active = memory.facts({ status: 'active' });
  assert.equal(active.length, 5, '五条不同事实必须全部存活（不得互相顶替）');
  assert.equal(memory.facts({ status: 'superseded' }).length, 0, '不得产生 superseded');
});

test('可累积类幂等：同内容重复写入完全短路（不产生新行）', () => {
  resetFacts();
  const a = memory.upsertFact({ kind: 'promise', subject: 'other', content: '他一直都在' });
  const b = memory.upsertFact({ kind: 'promise', subject: 'other', content: '他一直都在' });
  const c = memory.upsertFact({ kind: 'promise', subject: 'other', content: '  他一直都在  ' });   // 归一化后同 key
  assert.equal(memory.facts({ status: 'active' }).length, 1, '同内容不得刷出多条 active');
  assert.equal(memory.facts({ status: 'all' }).length, 1, '完全重复的写入不得落盘（不追加 superseded 副本）');
  assert.equal(b.validFrom, a.validFrom, '重复写入应返回已存在的同一条，而不是新建');
  assert.equal(c.validFrom, a.validFrom, '空白差异归一化后同样短路');
});

test('factKey：唯一类无指纹、可累积类带指纹、归一化后同 key', () => {
  assert.equal(memory.factKey('identity', 'other', '他叫星野'), 'identity:other');
  assert.equal(memory.factKey('job', 'other', '程序员'), 'job:other');
  const k = memory.factKey('promise', 'other', '他一直都在');
  assert.ok(k.startsWith('promise:other:'), `可累积类 key 必须带指纹，实际 ${k}`);
  assert.notEqual(k, memory.factKey('promise', 'other', '早安晚安'));
  assert.equal(k, memory.factKey('promise', 'other', '  他一直都在 '), '空白归一化后必须同 key');
});

test('不同 key 不互顶', () => {
  resetFacts();
  memory.upsertFact({ kind: 'like', subject: 'other', content: 'A' });
  memory.upsertFact({ kind: 'like', subject: 'self', content: 'B' });
  memory.upsertFact({ kind: 'taboo', subject: 'other', content: 'C' });
  assert.equal(memory.facts({ status: 'active' }).length, 3);
});

table('校验表（非法输入必须抛错）', [
  { name: 'kind 不在枚举', input: { kind: 'nonsense', subject: 'other', content: 'x' }, msg: /PERSON_FACT_KINDS/ },
  { name: 'kind 缺失', input: { subject: 'other', content: 'x' }, msg: /PERSON_FACT_KINDS/ },
  { name: 'subject 非法', input: { kind: 'like', subject: 'everyone', content: 'x' }, msg: /other\|self\|we/ },
  { name: 'content 空串', input: { kind: 'like', subject: 'other', content: '' }, msg: /content/ },
  { name: 'content 纯空白', input: { kind: 'like', subject: 'other', content: '   ' }, msg: /content/ },
  { name: 'mid 非数字', input: { kind: 'like', subject: 'other', content: 'x', mid: 'abc' }, msg: /mid/ },
  { name: 'mid 对象', input: { kind: 'like', subject: 'other', content: 'x', mid: {} }, msg: /mid/ },
  { name: 'key 与 factKey 推导不一致', input: { kind: 'identity', subject: 'other', content: 'x', key: 'identity:self' }, msg: /不一致/ },
  { name: '入参非对象', input: null, msg: /object/ }
], (row) => {
  resetFacts();
  // 注意传 null 原样传（?? undefined 会触发默认参数 {}，那走的是另一条报错路径）
  assert.throws(() => memory.upsertFact(row.input), row.msg);
});

table('mid 合法值表', [
  { name: '数字', mid: 123, expect: 123 },
  { name: '数字字符串（ coercion）', mid: '456', expect: 456 },
  { name: 'null（历史迁移允许，D9）', mid: null, expect: null },
  { name: 'undefined → null', mid: undefined, expect: null }
], (row) => {
  resetFacts();
  const entry = memory.upsertFact({ kind: 'like', subject: 'other', content: 'x', mid: row.mid });
  assert.equal(entry.mid, row.expect);
});

test('额外字段保留（source 等）+ validFrom 透传', () => {
  resetFacts();
  const entry = memory.upsertFact({ kind: 'like', subject: 'other', content: 'x', source: 'check', validFrom: 12345 });
  assert.equal(entry.source, 'check');
  assert.equal(entry.validFrom, 12345);
});

test('supersede 原子落库（「重写绝不丢未知数据」的 DB 等价①）：顶旧行就地翻 superseded + 新行追加末尾 + 旧行额外字段零丢失', () => {
  resetFacts();
  // 用唯一类 kind（identity）构造：唯一类才会顶替，可累积类并列共存不产生 superseded
  // 文件时代白盒=直写 facts.jsonl（含坏行）；V3 等价断言=upsertFact 单事务落库后旧行
  // 的未知/额外字段（source → facts.extra 列）原样存活——坏行概念随文件机制消失
  // （所有行皆结构化数据，extra 列兜底），退役对照表见交接内部文档 handoff-sqlite-v2.md 夜3。
  memory.upsertFact({ kind: 'identity', subject: 'other', content: '旧', validFrom: 1, source: 'migrated-impressions-20261106' });
  const entry = memory.upsertFact({ kind: 'identity', subject: 'other', content: '新' });
  const all = memory.facts({ status: 'all' });
  assert.equal(all.length, 2, '顶旧行 + 新行');
  assert.equal(all[0].status, 'superseded', '旧行就地变 superseded');
  assert.equal(all[0].source, 'migrated-impressions-20261106', '旧行额外字段（extra 列）零丢失');
  assert.equal(all[0].supersededBy, `identity:other@${entry.validFrom}`, 'supersededBy 精确回指新条');
  assert.equal(all[1].content, '新');
  assert.equal(all[0].validFrom, 1, '旧行其余列值不动');
});

test('supersede 事务回滚（「坏行保留」的 DB 等价②）：facts 写路径中途失败全撤销、行集零变化', () => {
  resetFacts();
  memory.upsertFact({ kind: 'identity', subject: 'other', content: '基线' });
  const before = memory.facts({ status: 'all' });
  assert.throws(() => dbmod.transaction(() => {
    // 模拟「顶旧成功、新行写入后进程/语句失败」的中间态：两条写都执行，随后抛错
    dbmod.getDb().prepare("UPDATE facts SET status = 'superseded', supersededBy = 'x' WHERE key = ?").run(before[0].key);
    dbmod.getDb().prepare("INSERT INTO facts (key, kind, subject, content, status, validFrom, supersededBy, mid, visibility) VALUES ('identity:other', 'identity', 'other', '中途行', 'active', 2, null, null, 'private')").run();
    throw new Error('中途失败');
  }), /中途失败/);
  const after = memory.facts({ status: 'all' });
  assert.deepEqual(after, before, '事务整体 ROLLBACK——顶旧与新行全部撤销（文件时代 tmp+rename 原子写的强等价）');
  assert.equal(after[0].status, 'active', '基线行保持 active');
});

// ═══════════════════════ 3. mind.apply / decay / snapshot ═══════════════════════

group('mind.apply / snapshot');
// 2026-11-21 数值丢弃：valence/arousal/energy 轴、单事件/每日限幅、mind.decay 全部退役；
// apply 只剩心事门控（kind ∈ 枚举 且 impact > 0.5）。

test('非数字 impact → null', () => {
  resetMind();
  assert.equal(mind.apply({ impact: 'x' }), null);
});

table('preoccupations 添加规则（kind ∈ 枚举 且 impact > 0.5）', [
  { name: 'kind 不在枚举 → 不加', kind: 'chat', impact: 0.9, add: false },
  { name: 'impact=0.5 恰好不加（严格大于）', kind: 'promise', impact: 0.5, add: false },
  { name: 'promise×0.6 → 加', kind: 'promise', impact: 0.6, add: true },
  { name: 'conflict×0.9 → 加', kind: 'conflict', impact: 0.9, add: true },
  { name: 'open_loop×0.51 → 加', kind: 'open_loop', impact: 0.51, add: true }
], (row) => {
  resetMind();
  const before = mind.snapshot();
  const after = mind.apply({ impact: row.impact, kind: row.kind, text: '测试心事' });
  assert.equal(after.preoccupations.length - before.preoccupations.length, row.add ? 1 : 0, row.name);
  if (row.add) {
    const p = after.preoccupations[after.preoccupations.length - 1];
    assert.equal(p.source, row.kind);
    assert.equal(p.text, '测试心事');
    assert.ok(p.expiresAt > Date.now() + 71 * 60 * 60 * 1000, 'TTL≈72h');
  }
});

test('去重（isSameTopic 表驱动）：完全相等/包含≥50%且≥6字 → 同一件', () => {
  const { isSameTopic } = mind;
  const rows = [
    { a: '答应明天要还书', b: '答应明天要还书', want: true, why: '完全相等' },
    { a: '答应明天要还书。', b: '答应明天要还书', want: true, why: '标点归一后相等' },
    { a: '下周一起去看流星雨', b: '下周一起去看流星雨啊', want: true, why: '包含且 7/8≥50%' },
    { a: '吃饭了', b: '吃饭了没', want: false, why: '短句 <6 字 → 保守不并' },
    { a: '明天要还书', b: '下周要还书', want: false, why: '互不包含' },
    { a: '', b: '随便什么', want: false, why: '空串' }
  ];
  for (const r of rows) assert.equal(isSameTopic(r.a, r.b), r.want, `${r.why}（"${r.a}" vs "${r.b}"）`);
});

test('noteMood 去重：同一件事只续期不新增，文本留信息更多的说法', () => {
  resetMind();
  const r1 = mind.noteMood({ topics: ['下周一起去看流星雨'] });
  assert.equal(r1.added, 1);
  const r2 = mind.noteMood({ topics: ['下周一起去看流星雨呀，说好的'] });
  assert.equal(r2.added, 0, '命中 isSameTopic → 不新增');
  assert.equal(r2.touched, 1, '只续期');
  const s = mind.snapshot();
  assert.equal(s.preoccupations.length, 1);
  assert.equal(s.preoccupations[0].text, '下周一起去看流星雨呀，说好的', '留下更长的说法');
});

test('心事容量上限 3：超出挤掉最早的', () => {
  resetMind();
  for (const t of ['甲件事麻烦还没了结', '乙件事麻烦还没了结', '丙件事麻烦还没了结', '丁件事麻烦还没了结']) {
    mind.noteMood({ topics: [t] });
  }
  const s = mind.snapshot();
  assert.equal(s.preoccupations.length, 3);
  assert.equal(s.preoccupations.some((p) => p.text.startsWith('甲')), false, '最早的被挤掉');
  assert.equal(s.preoccupations.some((p) => p.text.startsWith('丁')), true, '最新的保留');
});

test('snapshot 顺手清过期：过期心事删除、超 24h 的心绪文本淡去', () => {
  resetMind();
  const now = Date.now();
  writeMindState({
    mood: { text: '有点闷', textAt: now - 25 * 60 * 60 * 1000, updatedAt: now },
    preoccupations: [
      { id: 'p1', text: '早该过期的事', at: now - 99999, source: 'promise', expiresAt: now - 1000 },
      { id: 'p2', text: '还没过期的事', at: now, source: 'promise', expiresAt: now + 1000 }
    ]
  });
  const s = mind.snapshot();
  assert.equal(s.preoccupations.length, 1);
  assert.equal(s.preoccupations[0].text, '还没过期的事');
  assert.equal(s.mood.text, '', '超 24h 的心绪文本淡去');
});

// ═══════════════════════ P3：记忆 visibility + surface 过滤 ═══════════════════════
// （night-plan §6.2 / 整改清单 §7-P3：卡片/事实落 visibility:'private' 默认；
//   prompt.js 记忆段按 session.surface 过滤——pet 视角看不到 private。）

group('P3 记忆 visibility + surface 过滤');

// prompt.js 在 env 设定之后 import（config/person 全部落沙箱数据根；replay.mjs 同款离线路径）
const promptMod = await import('../src/prompt.js');

test('P3 沙箱清理：facts/cards 归零（后续断言从干净状态起）——V3 起=两表全清（文件目录删除退役）', () => {
  resetFacts();
  resetCards();
});

table('upsertFact 落 visibility 默认（P3）', [
  { name: '缺省 → private', input: { kind: 'like', subject: 'other', content: 'P3默认事实' }, want: 'private' },
  { name: '显式 ambient → 保留', input: { kind: 'like', subject: 'self', content: 'P3ambient事实', visibility: 'ambient' }, want: 'ambient' },
  { name: '显式 shared → 保留', input: { kind: 'routine', subject: 'self', content: 'P3shared事实', visibility: 'shared' }, want: 'shared' },
  { name: '词表外（public）→ 归一 private', input: { kind: 'dislike', subject: 'self', content: 'P3脏值事实', visibility: 'public' }, want: 'private' }
], (row) => {
  const entry = memory.upsertFact(row.input);
  assert.equal(entry.visibility, row.want, `落盘 visibility=${row.want}`);
});

const CARD_DATES = ['2026-11-10', '2026-11-09', '2026-11-08'];   // 依写入顺序，与下方卡可见性断言对应
let cardSeq = 0;
table('writeCard 落 visibility 默认（P3）', [
  { name: '缺省 → private', visibility: undefined, want: 'private' },
  { name: '显式 ambient → 保留', visibility: 'ambient', want: 'ambient' },
  { name: '词表外（internal）→ 归一 private', visibility: 'internal', want: 'private' }
], (row) => {
  const card = memory.writeCard({ date: CARD_DATES[cardSeq++], salience: 3, events: ['P3卡事件'], visibility: row.visibility });
  assert.equal(card.visibility, row.want, `落盘 visibility=${row.want}`);
});

test('renderPersonMemorySection：null / web 全可见（fail-open 与记忆本体身体）', () => {
  // null = 调用方判不了（旧调用方/无 session.surface）→ 全放行，与 tool-registry 同口径
  // Q14 基线调整：本体身体集合收窄 ['web']（旧载体身体 Q11 归档注销，prompt.js
  // PRIVATE_MEMORY_SURFACES 同步收窄）——原 'qq' 全可见断言改 'web'，语义同源。
  const textNull = promptMod.renderPersonMemorySection(null);
  assert.ok(textNull.includes('P3默认事实'), 'null → private 事实放行');
  assert.ok(textNull.includes('P3ambient事实'), 'null → ambient 事实放行');
  assert.ok(textNull.includes('P3卡事件'), 'null → 卡事件放行');
  const textWeb = promptMod.renderPersonMemorySection('web');
  assert.ok(textWeb.includes('P3默认事实') && textWeb.includes('P3ambient事实'), 'web → 全可见');
  // 旧载体 surface 名现网不可能出现（registry 未在册即抛错）；经此直调时按未知身体
  // 口径处理（private 不可见）——回归断言钉住收窄后的词表边界。
  const textLegacy = promptMod.renderPersonMemorySection('qq');
  assert.ok(!textLegacy.includes('P3默认事实'), '旧载体名（未在册身体）→ private 不可见');
  assert.ok(textLegacy.includes('P3ambient事实'), '旧载体名（未在册身体）→ ambient 仍可见');
});

test('renderPersonMemorySection：pet 视角看不到 private（只余 ambient/shared）', () => {
  const pet = promptMod.renderPersonMemorySection('pet');
  assert.ok(!pet.includes('P3默认事实'), 'pet 看不到 private 事实');
  assert.ok(!pet.includes('P3脏值事实'), 'pet 看不到词表外（归一 private）事实');
  assert.ok(pet.includes('P3ambient事实'), 'pet 看得到 ambient 事实');
  assert.ok(pet.includes('P3shared事实'), 'pet 看得到 shared 事实');
});

test('renderPersonMemorySection：pet 下 private 卡不可见、ambient 卡可见', () => {
  const pet = promptMod.renderPersonMemorySection('pet');
  // 三张卡按写入顺序：2026-11-10（缺省 private）/ 2026-11-09（ambient）/ 2026-11-08（归一 private）。
  // slice(-2) 取文件行序末尾两张（11-09、11-08），再按 visibility 过滤 → pet 只剩 ambient 的 11-09。
  // private 卡的事件行文本与 ambient 卡相同（都是 'P3卡事件'），用日期标签区分：
  assert.ok(pet.includes('11-09 P3卡事件'), 'pet 看得到 ambient 卡（11-09）');
  assert.ok(!pet.includes('11-10 P3卡事件'), 'pet 看不到 private 卡（11-10）');
  assert.ok(!pet.includes('11-08 P3卡事件'), 'pet 看不到归一 private 卡（11-08，窗口内被过滤）');
});

test('renderPersonMemorySection：未知身体（diary）同 pet 口径', () => {
  const diary = promptMod.renderPersonMemorySection('diary');
  assert.ok(!diary.includes('P3默认事实'), 'diary 看不到 private 事实');
  assert.ok(diary.includes('P3ambient事实'), 'diary 看得到 ambient 事实');
});

// ═══════════════════════ P3-Prompt 渲染面：日记化卡片 + 今日暂存 ═══════════════════════
// （night-plan-prompt-memory §P3：【记忆】段卡片部分重写——最近 2 张，新格式卡渲染
//   entry 正文（预算 800 字/卡，超出截断标注）+ open_loops/promises 全量，events 不再
//   注入（正文已涵盖）；旧格式卡（无 entry）回退 events 行（兼容历史）；段尾新增
//   【今日暂存】小节（当日 staging，格式 `- text（你当时记下的）`，预算 300 字，无条目
//   整节缺席）。promises 全量带出闭环 2026-11-11 起 promises 在提示词不可见的洞。）

group('P3-Prompt 渲染面：日记化卡片 + 今日暂存');

test('P3R 日记卡：entry 正文进渲染、events 骨架不再注入；open_loops/promises 全量带出', () => {
  // 用例卡文本避开 recall 触发词的 bigram；日期避开 P2 触发用例的 DAY（2026-11-18/19/20，
  // cards 触发的同日已写卡 skip 会被这里的卡顶掉）
  memory.writeCard({
    date: '2026-11-15', salience: 2,
    events: ['P3R旧卡事件行照旧回退'],
    promises: [{ text: 'P3R旧卡的约定也要可见', due: '', status: 'open', mid: 6103 }]
  });
  memory.writeCard({
    date: '2026-11-16', salience: 3,
    entry: '今天一起整理了机柜线缆，把备件归了位，顺带把风向标修好了。',
    events: ['P3R新卡骨架行不应注入'],
    promises: [
      { text: 'P3R他答应周五把采样器修好', due: '2026-11-17', status: 'open', mid: 6101 },
      { text: '', due: '', status: 'open', mid: 6102 }
    ],
    open_loops: ['P3R没聊完的话题A', 'P3R没聊完的话题B']
  });
  const out = promptMod.renderPersonMemorySection('web');
  assert.ok(out.includes('11-16：今天一起整理了机柜线缆'), 'entry 正文带「MM-DD：」前缀渲染');
  assert.ok(!out.includes('P3R新卡骨架行不应注入'), '新格式卡 events 不再注入（正文已涵盖）');
  assert.ok(out.includes('11-15 P3R旧卡事件行照旧回退'), '旧格式卡（无 entry）回退 events 行（兼容历史卡）');
  assert.ok(out.includes('还没聊完：P3R没聊完的话题A') && out.includes('还没聊完：P3R没聊完的话题B'),
    'open_loops 全量带出');
  assert.ok(out.includes('约定：P3R他答应周五把采样器修好（2026-11-17 前）'), 'promises 全量带出（due 在场时标注）');
  assert.equal((out.match(/  · 约定：/g) || []).length, 2, '空 text 的 promise 不产生空行（全量=非空全带）');
  assert.ok(out.includes('约定：P3R旧卡的约定也要可见'),
    '旧格式卡的 promises 同样全量带出（11-11 洞闭环：promises 可见不再依赖 entry 存在）');
});

test('P3R 日记卡：entry 超 800 字 → 截 800 + 截断标注（预算 800 字/卡）', () => {
  const long = '今'.repeat(300) + '天'.repeat(300) + '记'.repeat(300) + '了'.repeat(300);   // 1200 字
  memory.writeCard({ date: '2026-11-17', salience: 3, entry: long, events: [] });
  const out = promptMod.renderPersonMemorySection('web');
  const line = out.split('\n').find((l) => l.startsWith('- 11-17：'));
  assert.ok(line, '长 entry 卡渲染行存在');
  const body = line.slice('- 11-21：'.length);
  assert.equal(body.length, 800 + '…（日记过长，后略）'.length, `正文截到 800 + 标注（实际 ${body.length}）`);
  assert.ok(body.startsWith('今'.repeat(300) + '天'.repeat(300) + '记'.repeat(200)), '保留头部 800 字');
  assert.ok(!body.includes('了'.repeat(50)), '第 801 字起不注入');
  assert.ok(body.endsWith('…（日记过长，后略）'), '截断标注在场');
});

test('P3R 今日暂存：格式 / 多条全量 / 预算 300 / 空缺席（纯函数表驱动）', () => {
  assert.equal(promptMod.renderTodayStagingSection([]), '');
  assert.equal(promptMod.renderTodayStagingSection(null), '');
  assert.equal(promptMod.renderTodayStagingSection([{ text: '' }, { text: '  ' }]), '', '空 text 条目滤除 → 整节缺席');
  const sec = promptMod.renderTodayStagingSection([
    { text: '他说稳一点比快一点更好' },
    { text: 'P3R第二条暂存' }
  ]);
  assert.ok(sec.startsWith('【今天记下的】\n'), '段头');
  assert.ok(sec.includes('- 他说稳一点比快一点更好（你当时记下的）'), '格式 - text（你当时记下的）');
  assert.ok(sec.includes('- P3R第二条暂存（你当时记下的）'), '预算内多条全量');
  // 预算 300：超预算从尾部截条（保先记的，追加序=时间序），注尾必保
  const big = promptMod.renderTodayStagingSection([
    { text: '甲'.repeat(150) }, { text: '乙'.repeat(150) }, { text: '丙'.repeat(100) }
  ]);
  const bigLines = big.slice('【今天记下的】\n'.length).split('\n');
  assert.equal(bigLines.length, 2, '预算内只保前两条（丙条被截）');
  assert.ok(bigLines.every((l) => l.endsWith('（你当时记下的）')), '每行注尾完整');
  const lineChars = bigLines.reduce((s, l) => s + l.length, 0);
  assert.ok(lineChars <= 300, `条目行合计 ≤300（实际 ${lineChars}）`);
  const one = promptMod.renderTodayStagingSection([{ text: '丁'.repeat(500) }]);
  const oneLine = one.slice('【今天记下的】\n'.length);
  assert.equal(oneLine.length, 300, `单条超预算从正文尾截到 300（实际 ${oneLine.length}）`);
  assert.ok(oneLine.endsWith('（你当时记下的）'), '注尾完整');
});

test('P3R 今日暂存接线：段尾注入 / 无条目整节缺席 / 仅本体身体可见（staging 无 visibility 字段，按 private 口径）', () => {
  // 此前用例没写过今天的 staging → 整节缺席
  const before = promptMod.renderPersonMemorySection('web');
  assert.ok(!before.includes('【今天记下的】'), '无条目整节缺席');
  memory.remember({ text: 'P3R今日暂存的沙箱条目', mid: 6201 });
  const out = promptMod.renderPersonMemorySection('web');
  assert.ok(out.includes('【今天记下的】\n- P3R今日暂存的沙箱条目（你当时记下的）'), '当日 staging 进【记忆】段尾');
  const lines = out.split('\n');
  const firstCardLine = lines.findIndex((l) => l.startsWith('- 11-'));
  assert.ok(lines.indexOf('【今天记下的】') > firstCardLine && firstCardLine >= 0, '暂存小节在卡片内容之后（段尾）');
  assert.ok(!promptMod.renderPersonMemorySection('pet').includes('【今天记下的】'), 'pet 视角看不到暂存（private 口径）');
});

// ═══════════════════════ P4：记忆召回进提示词（relationship/self 面已摘除）═══════════════════════
// （night-plan §7 / 整改清单 §6-P5/P6 / §7-P4：recallForPrompt 接 prompt.js 尾部易变区；
//   注入段合计 ≤1000 字；"上周我们聊了什么"类问题 recall 能命中 —— 全部 fixture/纯函数
//   验证，零模型调用。数据隔离同前：写盘只落临时数据根。
//   2026-11-21：self 面整体丢弃（narrative 零写者恒空，人设 roleText 即她的自我定义）——
//   原【自我叙事】预算/接线断言随之退役，接线断言改"【自我叙事】不出现"负向锁定。
//   2026-11-14 整改：night-plan-prompt-memory §0-2 摘除【关系状态】段（信息静态化进人设、
//   episodes 不再喂 relationship），§P5 明文"关系段预算断言删除"——原关系档位 ≤80 预算
//   断言删除，接线断言改"【关系状态】不出现"锁定摘除面；relationshipTierOf* 词表亦于
//   2026-11-21 随 relationship 整体丢弃移除，原两张映射表断言随之退役。）

group('P4 记忆召回进提示词（relationship/self 面已摘除）');

const recallMod = await import('../src/capabilities/reflection/recall.js');
const { recallGate, recallForPrompt } = recallMod;
const retrieveFromCards = recallMod.retrieveFromCards;   // 夜2 快照对照/位移断言用（同一真实函数，bench 纪律 2：不得重写）
const NOW = Date.now();
const TWO_H = 2 * 60 * 60 * 1000;

// fixture 卡（不落盘，经 cards 注入参数走纯函数路径）
const FIXTURE_CARDS = [
  { date: '2026-11-03', salience: 2, events: ['上周一起去了海边看日出，还约好下次带上相机'], facts: [], open_loops: [], mood: '开心' },
  { date: '2026-11-01', salience: 1, events: ['去看了一场很棒的演唱会'], facts: [], open_loops: [], mood: '' }
];

test('recallGate 词表钉死：记得/上次/以前/那天 + 2026-11-16 扩 gate（日期/记忆测试线索）', () => {
  assert.deepEqual(recallMod.RECALL_TRIGGER_WORDS, [
    '记得', '上次', '以前', '那天',
    '当时', '凭记忆', '记忆里', '回忆', '翻聊天记录', '翻记录', '上周'
  ]);
});

table('recallGate 表驱动（冷启动/线索词/人名/不触发）', [
  { name: '刚聊过+无线索 → 不触发', text: '在吗', ts: NOW, names: [], hit: false, reason: '' },
  { name: '记得 → 线索词', text: '你还记得上次说的事吗', ts: NOW, names: [], hit: true, reason: 'trigger-word' },
  { name: '上次 → 线索词', text: '上次那个链接发我下', ts: NOW, names: [], hit: true, reason: 'trigger-word' },
  { name: '以前 → 线索词', text: '以前你不是这样的', ts: NOW, names: [], hit: true, reason: 'trigger-word' },
  { name: '那天 → 线索词', text: '那天你说好陪我的', ts: NOW, names: [], hit: true, reason: 'trigger-word' },
  { name: '当时 → 线索词', text: '当时你说要一直陪着我', ts: NOW, names: [], hit: true, reason: 'trigger-word' },
  { name: '凭记忆 → 线索词', text: '只凭记忆回答，不要翻记录', ts: NOW, names: [], hit: true, reason: 'trigger-word' },
  { name: '记忆里 → 线索词', text: '你记忆里还有那件事吗', ts: NOW, names: [], hit: true, reason: 'trigger-word' },
  { name: '回忆 → 线索词', text: '你回忆一下那天', ts: NOW, names: [], hit: true, reason: 'trigger-word' },
  { name: '翻聊天记录 → 线索词', text: '你可以翻聊天记录找', ts: NOW, names: [], hit: true, reason: 'trigger-word' },
  { name: '上周 → 线索词', text: '上周我们聊了什么', ts: NOW, names: [], hit: true, reason: 'trigger-word' },
  { name: '11月3号 → 日期线索', text: '11月3号晚上我们猜表情包', ts: NOW, names: [], hit: true, reason: 'trigger-word' },
  { name: '2号下午 → 日期线索', text: '2号下午开会时我说了什么', ts: NOW, names: [], hit: true, reason: 'trigger-word' },
  { name: '2026-11-03 → 日期线索', text: '2026-11-03 那天的事', ts: NOW, names: [], hit: true, reason: 'trigger-word' },
  { name: '冷启动 >2h → 触发', text: '', ts: NOW - TWO_H - 1, names: [], hit: true, reason: 'cold-start' },
  { name: '恰好 2h 整 → 不触发（严格大于）', text: '', ts: NOW - TWO_H, names: [], hit: false, reason: '' },
  { name: '人名命中 → 第 5 条线索', text: '星野在忙吗', ts: NOW, names: ['星野'], hit: true, reason: 'name' },
  { name: '人名不匹配 → 不触发', text: '在忙吗', ts: NOW, names: ['星野'], hit: false, reason: '' },
  { name: '没聊过（ts=0）且无线索 → 不触发', text: '嗨', ts: 0, names: [], hit: false, reason: '' }
], (row) => {
  const g = recallGate({ text: row.text, lastMessageTs: row.ts, now: NOW, names: row.names });
  assert.equal(g.hit, row.hit, row.name);
  if (row.reason || row.hit) assert.equal(g.reason, row.reason, `${row.name} reason`);
});

test('recallForPrompt：冷启动 + 「上周我们聊了什么」命中 fixture 卡（≤2 条/每条 ≤60 字/带 MM-DD 日期）', () => {
  const r = recallForPrompt({ text: '上周我们聊了什么', lastMessageTs: NOW - 3 * 60 * 60 * 1000, now: NOW, cards: FIXTURE_CARDS });
  assert.equal(r.gate.hit, true, '冷启动闸门命中');
  assert.equal(r.gate.reason, 'cold-start');
  assert.equal(r.hits.length, 1, '只有含「上周」的卡命中（词法重叠>0 才计分）');
  assert.ok(r.hits[0].text.includes('上周'), '命中上周的卡');
  assert.ok(r.hits[0].text.startsWith('11-03 '), '带 MM-DD 日期前缀');
  assert.ok(r.hits[0].text.length <= 60, `每条 ≤60 字（实际 ${r.hits[0].text.length}）`);
  assert.deepEqual(r.lines, [`- ${r.hits[0].text}`], 'lines 即渲染行');
});

test('recallForPrompt：闸门未命中 → 不检索、零产出（不给模型"查过记忆"的假信号）', () => {
  const r = recallForPrompt({ text: '今天天气不错', lastMessageTs: NOW, now: NOW, cards: FIXTURE_CARDS });
  assert.equal(r.gate.hit, false);
  assert.deepEqual(r.hits, []);
  assert.deepEqual(r.lines, []);
});

// （原"自我叙事 ≤300 字预算"断言与两张关系映射表断言均已退役——
//   2026-11-21 self/relationship 面丢弃，renderNarrativeSection/relationshipTierOf*
//   不存在；摘除面由接线断言的负向锁定。）

// （原两张关系映射表断言与"P4 预算断言：关系档位整段 ≤80 字"均已退役——
//   night-plan-prompt-memory §0-2 摘除【关系状态】段 + 2026-11-21 relationship 整体丢弃，
//   relationshipTierOf* 不存在；摘除面由接线断言的"【关系状态】不出现"负向锁定。）

test('P4 预算断言：召回段 = 标题 + ≤2 条 × ≤60 字（整段 ≤200）', () => {
  assert.equal(promptMod.renderRecallSection([]), '');
  assert.equal(promptMod.renderRecallSection(null), '');
  const sec = promptMod.renderRecallSection([{ text: '一'.repeat(60) }, { text: '二'.repeat(60) }]);
  assert.ok(sec.startsWith('【近期回忆】'), '段头');
  assert.ok(sec.includes('- ' + '一'.repeat(60)) && sec.includes('- ' + '二'.repeat(60)), '两条原样带出');
  assert.ok(sec.length <= 200, `整段 ≤200（实际 ${sec.length}）`);
  // W4：标题行 + 「仅供参考」标注行 + N 条 → 分隔符数 = N+2（标注行是授权的字节变化）
  assert.equal(promptMod.renderRecallSection([{ text: '三'.repeat(60) }, { text: '四'.repeat(60) }, { text: '五'.repeat(60) }]).split('\n').length - 1, 4, 'renderRecallSection 本身不截条数（截 ≤2 是 recallForPrompt 的职责）；标题+标注+3 条 = 4 个换行');
});

test('P4 验收：注入段最坏情况合计 ≤1000 字（两段口径：召回 + 今日暂存；self 面丢弃后）', () => {
  // 2026-11-21 self/relationship 面丢弃 → 叙事/关系段均不存在 → 两段最坏 =
  // 召回 ≤~190 + 暂存 ≤307 ≈ 500 字（预算余量进一步扩大）。
  const rec = promptMod.renderRecallSection([{ text: '11-03 ' + '甲'.repeat(54) }, { text: '11-01 ' + '乙'.repeat(54) }]);
  const sta = promptMod.renderTodayStagingSection([{ text: '暂'.repeat(500) }]);   // 单条撑满 300
  const total = rec.length + sta.length;
  assert.ok(total <= 1000, `P4 注入合计 ${total} 字 ≤ 1000`);
  assert.ok(total <= 520, `两段最坏合计受 ≈500 口径 + 余量约束（≤520，实际 ${total}）`);
});

test('P4 接线：buildUserPrompt 尾部易变区出现【近期回忆】；【自我叙事】/【关系状态】已摘除不出现', () => {
  // （原 self 白盒行已随 self 面丢弃移除——人设区只有【角色设定】。）
  // 白盒：临时数据根落 fixture 卡（记进临时 cards，非真实数据）
  memory.writeCard({ date: '2026-11-05', salience: 2, events: ['说好周五晚上一起去看流星雨'], visibility: 'ambient' });
  const trigger = { id: 11, mid: 9001, ts: NOW - 3 * 60 * 60 * 1000, senderId: '10001', senderName: '星野', text: '我们上次说好的流星雨还去吗', self: false };
  const mkCtx = (surface) => ({
    chatKey: 'private:10001', kind: 'private', chatId: '10001',
    triggerEntries: [trigger],
    store: { recent: () => [trigger] },
    stickerEntries: [],
    session: { surface },
    promptAnchor: { prev: null }
  });
  const up = promptMod.buildUserPrompt(mkCtx('web'));
  assert.ok(up.includes('【近期回忆】') && up.includes('流星雨'), '冷启动+线索 → fixture 卡命中进提示词');
  const iUnread = up.indexOf('【未读信息】');
  const iRecall = up.indexOf('【近期回忆】');
  const iTime = up.indexOf('【当前时间】');
  assert.ok(iUnread > 0 && iRecall > iUnread && iTime > iRecall,
    '【近期回忆】在尾部易变区（未读信息之后、当前时间之前）');
  // 2026-11-21 self/relationship 面丢弃：两段负向锁定。
  assert.ok(!up.includes('【自我叙事】'), '【自我叙事】段已摘除，不再出现在提示词');
  assert.ok(!up.includes('【关系状态】'), '【关系状态】段已摘除，不再出现在提示词');
});

test('P4 接线：刚聊过且无线索 → 提示词无【近期回忆】（闸门零开销路径）', () => {
  const fresh = { id: 12, mid: 9002, ts: NOW, senderId: '10001', senderName: '星野', text: '今天天气不错', self: false };
  const up = promptMod.buildUserPrompt({
    chatKey: 'private:10001', kind: 'private', chatId: '10001',
    triggerEntries: [fresh],
    store: { recent: () => [fresh] },
    stickerEntries: [],
    session: { surface: 'web' },
    promptAnchor: { prev: null }
  });
  assert.ok(!up.includes('【近期回忆】'), '闸门未命中不渲染空标题');
  // （原断言"【关系状态】恒可见"已随 §0-2 关系段摘除改为负向锁定——该段删除后与
  //   闸门无关，【近期回忆】的闸门行为本身仍由上一断言独立保障。）
  assert.ok(!up.includes('【关系状态】'), '关系段已摘除：闸门路径下也不出现');
});

test('P4 接线：pet 会话召回查不到 private 卡（visibility 过滤，P3 交接登记的 P4 落点）', () => {
  memory.writeCard({ date: '2026-11-04', salience: 2, events: ['我们计划明年冬天去南极看极光'], visibility: 'private' });
  const trigger = { id: 21, mid: 9003, ts: NOW - 3 * 60 * 60 * 1000, senderId: '10001', senderName: '星野', text: '记得我们聊过的南极纪录片吗', self: false };
  const mkCtx = (surface) => ({
    chatKey: 'private:10001', kind: 'private', chatId: '10001',
    triggerEntries: [trigger],
    store: { recent: () => [trigger] },
    stickerEntries: [],
    session: { surface },
    promptAnchor: { prev: null }
  });
  const upPet = promptMod.buildUserPrompt(mkCtx('pet'));
  assert.ok(!upPet.includes('【近期回忆】'), 'pet 视角 private 卡被过滤 → 召回空 → 无该段');
  // Q14 基线调整：本体身体对照面 'qq'→'web'（PRIVATE_MEMORY_SURFACES 收窄 ['web']）
  const upWeb = promptMod.buildUserPrompt(mkCtx('web'));
  assert.ok(upWeb.includes('【近期回忆】') && upWeb.includes('南极'), 'web 视角命中 private 卡');
});

test('P4 接线：默认卡片源 = person/memory.cards()（不经注入也读数据根）', () => {
  // 上一测试已在临时数据根落过卡；这里不注入 cards，验证默认路径读的就是数据根。
  const r = recallForPrompt({ text: '记得我们聊过的南极纪录片吗', lastMessageTs: NOW - 3 * 60 * 60 * 1000, now: NOW });
  assert.ok(r.gate.hit, '冷启动闸门命中');
  assert.ok(r.hits.some((h) => h.text.includes('南极')), `默认源命中临时数据根的卡：${r.hits.map((h) => h.text).join(' | ')}`);
});

// ── remember 工具带 mid（night-plan §7.2：staging 条目尽量带消息出处）────────

group('P4 remember 工具 mid 接线');

const toolsMod = await import('../src/tools.js');
const localDayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('remember：触发批最后一条用户消息有 QQ mid → staging 条目带该 mid', async () => {
  const defs = toolsMod.buildToolDefs();
  const remember = defs.find((d) => d.id === 'remember');
  assert.ok(remember, 'remember 工具已注册');
  const ctx = { triggerEntries: [{ id: 3, mid: 111, senderId: '10001', text: '早', self: false }, { id: 5, mid: 777, senderId: '10001', text: '帮我记一下', self: false }] };
  const r = await remember.execute(ctx, { text: '周三要还书' });
  assert.ok(!r.isError, `写入成功（${r.content?.slice(0, 80)}）`);
  const entries = memory.staging(localDayKey());
  const last = entries[entries.length - 1];
  assert.equal(last.text, '周三要还书');
  assert.equal(last.mid, 777, 'mid = 触发批最后一条用户消息的 QQ mid');
  assert.equal(last.source, 'chat');
});

test('remember：最后一条用户消息无 QQ mid → 回落本地 id（validateMid 两者都认）', async () => {
  const defs = toolsMod.buildToolDefs();
  const remember = defs.find((d) => d.id === 'remember');
  const ctx = { triggerEntries: [{ id: 8, mid: null, senderId: '10001', text: '帮我记住', self: false }] };
  const r = await remember.execute(ctx, { text: '周五交报告' });
  assert.ok(!r.isError);
  const entries = memory.staging(localDayKey());
  const last = entries[entries.length - 1];
  assert.equal(last.mid, 8, 'mid 缺失 → 回落本地 id');
});

test('remember：触发批为空（主动机会）→ mid=null 且留 warn 日志（mid:null 不当事实来源的可见面）', async () => {
  const defs = toolsMod.buildToolDefs();
  const remember = defs.find((d) => d.id === 'remember');
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const r = await remember.execute({ triggerEntries: [] }, { text: '主动机会随手记一笔' });
    assert.ok(!r.isError);
  } finally {
    console.warn = origWarn;
  }
  const entries = memory.staging(localDayKey());
  const last = entries[entries.length - 1];
  assert.equal(last.mid, null, 'mid=null（无消息出处）');
  assert.ok(warns.some((w) => w.includes('remember') && w.includes('mid=null')), `补日志落地：${warns[0] ?? '(无 warn)'}`);
});




// ═══════════════════════ Q1：E2/E3/E5 数据格式字段（night-plan-qq-exit §Q1）═══════════════════════
// E3：facts/cards 新写条目带格式版本号 v:1 且居首字段（读侧对未知字段宽容，零改动）。
// E2：events.jsonl 每行带 surface（归属身体；缺省空串）+ seq（实例内单调计数器，
//     重启按文件行数续号）。E5：出站意图带 sourceEventId（触发源 InboundEvent.id）。

group('Q1 E2/E3/E5 数据格式字段');

const { createEventLog } = await import('../src/kernel/events.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { registry } = await import('../src/surfaces/registry.js');

const parseLastLine = (file) => JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop());

test('Q1-E3：upsertFact 新写条目首字段 v===1（V3：facts 读回行键序——文件时代断言落盘行首字段，键序契约由 memory-map rowToFact 重建）', () => {
  const entry = memory.upsertFact({ kind: 'like', subject: 'other', content: 'Q1E3 断言专用事实（唯一内容，追加到末行）', mid: null });
  const parsed = memory.facts({ status: 'all' }).find((f) => f.key === entry.key);
  assert.ok(parsed, '刚落库的事实可按 key 读回');
  assert.equal(Object.keys(parsed)[0], 'v', '首字段 = v（读回 JSON 键序与文件时代落盘行一致）');
  assert.equal(parsed.v, 1);
});

test('Q1-E3：writeCard 新写卡片首字段 v===1（V3：cards 读回行键序——文件时代断言落盘行首字段）', () => {
  memory.writeCard({ date: '2020-01-01', salience: 3, events: ['Q1E3 断言专用卡'] });
  const parsed = memory.cards().find((c) => c.date === '2020-01-01');
  assert.ok(parsed, '刚落库的卡可按 date 读回');
  assert.equal(Object.keys(parsed)[0], 'v', '首字段 = v（读回 JSON 键序与文件时代落盘行一致）');
  assert.equal(parsed.v, 1);
});

test('Q1-E2：events seq 单调递增（1,2,3）+ surface 透传 + 缺省空串', () => {
  const f = path.join(DATA_ROOT, 'q1-e2-events-a.jsonl');
  fs.rmSync(f, { force: true });
  const log = createEventLog(f);
  log.append({ source: 'chat', kind: 'message_in', text: '一', surface: 'qq' });
  log.append({ source: 'chat', kind: 'message_out', text: '二', surface: 'web' });
  log.append({ source: 'tool', kind: 'remember', text: '' });   // 不传 surface
  const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3], 'seq = 1,2,3 严格单调');
  assert.equal(rows[0].surface, 'qq', 'surface 显式透传');
  assert.equal(rows[1].surface, 'web');
  assert.equal(rows[2].surface, '', '缺省 surface = 空串（不给缺省 qq，防污染）');
});

test('Q1-E2：重启续号——计数器初值 = 文件行数（兼容无 seq 历史行）', () => {
  const f = path.join(DATA_ROOT, 'q1-e2-events-b.jsonl');
  fs.rmSync(f, { force: true });
  fs.writeFileSync(f,
    JSON.stringify({ source: 'chat', kind: 'message_in', text: '历史行1' }) + '\n' +
    JSON.stringify({ source: 'chat', kind: 'message_out', text: '历史行2' }) + '\n');
  const log = createEventLog(f);
  log.append({ source: 'chat', kind: 'message_in', text: '新进程第一条' });
  let rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[0].seq, undefined, '历史行（无 seq）原样保留');
  assert.equal(rows[2].seq, 3, '初值 = 文件行数 2 → 本条 seq = 3');
  log.append({ source: 'chat', kind: 'message_out', text: '同进程第二条' });
  rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[3].seq, 4, '同实例后续 +1 单调');
});

test('Q1-E5：出站意图带 sourceEventId——无提交语境 null，submit 后=触发源 id', async () => {
  const captured = [];
  registry.register({
    surface: 'web',
    emit: async (intent) => { captured.push(intent); return { ok: true }; },
    call: async () => ({}),
    capabilities: () => ({ surface: 'web', canText: true })
  });
  let dueQueue = [];
  const fakeReminders = { due: () => dueQueue, markFired: () => {}, prune: () => {} };
  const fakeStore = { appendIncoming: () => ({ id: 1, mid: null, text: 'Q1E5' }) };
  const orch = new Orchestrator({ store: fakeStore, stickers: {}, sessions: {}, reminders: fakeReminders })   // Q11：构造器不持协议端/发送句柄;
  orch.paused = true;   // submit 后不进触发判定（零模型红线：不 wake、不跑 #runAgent）
  const waitFor = async (cond, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${label}：${timeoutMs}ms 内未满足`);
  };

  // 阶段一：提醒在无 submit 语境触发 → sourceEventId = null
  dueQueue = [{ id: 'q1-r0', chatKey: 'web:main', text: 'E5 无提交语境' }];
  orch.startReminderLoop();
  await waitFor(() => captured.length >= 1, 9000, '提醒 tick 一');
  assert.equal(captured[0].type, 'text');
  assert.equal(captured[0].conversationId, 'web:main');
  assert.equal(captured[0].sourceEventId, null, '无提交语境 → sourceEventId null');

  // 阶段二：submit 记 event.id → 提醒意图带触发源；submit 事件行落盘带 surface+seq（E2）
  orch.stopReminderLoop();
  dueQueue = [{ id: 'q1-r1', chatKey: 'web:main', text: 'E5 有提交语境' }];
  const r = await orch.submit({
    id: 'web:test:evt1', surface: 'web', conversationId: 'web:main', type: 'message',
    actor: { id: 'owner', name: '我' }, ts: Date.now(),
    payload: { text: 'Q1 E5 断言消息' }, hints: {}, visibility: 'private'
  }, null);
  assert.deepEqual(r, { ok: true }, 'submit 正常入库');
  const evLast = parseLastLine(path.join(DATA_ROOT, 'events.jsonl'));
  assert.equal(evLast.kind, 'message_in');
  assert.equal(evLast.surface, 'web', 'submit 入站事件 surface = 身体 surface');
  assert.equal(Number.isInteger(evLast.seq) && evLast.seq >= 1, true, `message_in 行带单调 seq（got ${evLast.seq}）`);

  orch.startReminderLoop();
  await waitFor(() => captured.length >= 2, 9000, '提醒 tick 二');
  assert.equal(captured[1].sourceEventId, 'web:test:evt1', 'submit 后意图 sourceEventId = 触发源 event.id');
  orch.stopReminderLoop();
});

test('Q1-E5：并发两提交各自溯源——触发源按路由键登记互不覆盖（清债夜3 per-routeKey，评审 P2-6①）', async () => {
  const captured = [];
  registry.register({
    surface: 'web',
    emit: async (intent) => { captured.push(intent); return { ok: true }; },
    call: async () => ({}),
    capabilities: () => ({ surface: 'web', canText: true })
  });
  let dueQueue = [];
  const fakeReminders = { due: () => dueQueue, markFired: () => {}, prune: () => {} };
  const fakeStore = { appendIncoming: () => ({ id: 1, mid: null, text: 'Q1E5b' }) };
  const orch = new Orchestrator({ store: fakeStore, stickers: {}, sessions: {}, reminders: fakeReminders });
  orch.paused = true;   // 零模型红线：submit 只登记触发源，onIncoming 见 paused 直接返回（不 wake、不跑 #runAgent）
  const waitFor = async (cond, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${label}：${timeoutMs}ms 内未满足`);
  };

  // 并发两提交：两个路由键（web:main / web:second）各自登记自己的 event.id。
  // 单值时代（进程级触发源）后者覆盖前者——两个会话的出站都会溯源到 evtB。
  const mk = (id, cid, text) => ({
    id, surface: 'web', conversationId: cid, type: 'message',
    actor: { id: 'owner', name: '我' }, ts: Date.now(),
    payload: { text }, hints: {}, visibility: 'private'
  });
  const ra = await orch.submit(mk('web:test:evtA', 'web:main', 'E5b 溯源 A'), null);
  const rb = await orch.submit(mk('web:test:evtB', 'web:second', 'E5b 溯源 B'), null);
  assert.deepEqual(ra, { ok: true }, '提交 A 正常入库');
  assert.deepEqual(rb, { ok: true }, '提交 B 正常入库');

  // 两会话各来一条到点提醒 → #fireReminder 各查各自路由键的触发源（单值时代两者同值）
  dueQueue = [
    { id: 'q1-r2', chatKey: 'web:main', text: 'E5b 提醒A' },
    { id: 'q1-r3', chatKey: 'web:second', text: 'E5b 提醒B' }
  ];
  orch.startReminderLoop();
  await waitFor(() => captured.length >= 2, 9000, '提醒 tick');
  const byCid = new Map(captured.map((i) => [i.conversationId, i.sourceEventId]));
  assert.equal(byCid.get('web:main'), 'web:test:evtA', 'web:main 溯源 = evtA（不被并发提交覆盖）');
  assert.equal(byCid.get('web:second'), 'web:test:evtB', 'web:second 溯源 = evtB');
  orch.stopReminderLoop();
});

// ═══════════════════════ P2：记忆卡日记化协议（night-plan-prompt-memory §P2）═══════════════════════
// 卡片协议三面（沙箱数据根，日期取 2026-11-13/18/19/20——与上方用例的卡日期零交集）：
//   ① 触发数组：晚安+30min（lastMessageFrom=23 gate）→ 最后消息+30min 兜底 → 补跑 7 天；
//     晚安判定复用 diary.js 的 lastGoodbyeAt（共享函数，词表不复制），diary 自驱口径不受波及。
//   ② buildTask 日记体协议：先 entry 后骨架、staging 语义（你自己当时认为值得记下来的，
//     优先级高于聊天流水）、人物表铁律原样、events 降级骨架索引（少而精）、JSON 协议带 entry。
//   ③ parse 兼容：entry 缺失回退旧格式（entry=''，events 照旧）；+ fixture 落卡带 entry（零网络）。

group('P2 卡片日记化协议（触发/协议/parse/fixture 落卡）');

const executorMod = await import('../src/capabilities/reflection/executor.js');
const cardsSpec = executorMod.specs.cards;

// 通用本地时刻（2026-11 系日期 → 本地毫秒；与 executor.localDayKey 同为本地时区口径）
const p2At = (day, h, m) => {
  const [y, mo, d] = String(day).split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};
const p2Store = (msgs) => ({
  listChats: () => ['private:10001'],
  recent: (key, { limit = 80 } = {}) => msgs.slice(-Math.max(1, limit))
});

test('P2 触发数组钉死：晚安+30min（最后消息≥23 点 gate）→ 最后消息+30min → 补跑 7 天；diary 自驱口径不受波及', () => {
  // 2026-11-15（所有者拍板"兜底去掉"）：afterLastMessage 从 cards 触发数组移除——
  // 卡片只在晚安（≥23:00 深夜收尾）/次日 catchup（补缺卡+补全过期卡）/晚安按钮（force）写。
  assert.deepEqual(cardsSpec.trigger, [
    { kind: 'afterGoodnight', delayMin: 30, lastMessageFrom: 23 },
    { kind: 'catchupDays', days: 7 }
  ]);
  assert.equal(executorMod.specs.diary.selfDriven, true, 'diary 仍 selfDriven（自己的 tick 驱动）');
  assert.deepEqual(executorMod.specs.diary.trigger, [{ kind: 'afterGoodnight', delayMin: 15 }], 'diary 晚安后 15 分钟口径原样');
});

test('P2 触发判定：晚安+30min 主路径命中（词表复用 diary 共享判定）；早于 23 点被 gate 挡；兜底已移除（2026-11-15）', () => {
  const DAY = '2026-11-20';
  // L2（night-plan-life §L2）：life 声明（dailyTime 06:30，当日 plan 缺失即 due）在册后，
  // dueTargets 是多声明的并集——cards 行为断言一律按 specId 圈定（本组只测 cards 触发）。
  const cardsOf = (targets) => targets.filter((t) => t.specId === 'cards');
  // 晚安 23:05/23:06、最后消息 23:06（hour 23 ≥ gate），now=+34min → 晚安主路径命中
  const goodnight = [
    { id: 1, ts: p2At(DAY, 22, 58), self: false, text: '今天累了' },
    { id: 2, ts: p2At(DAY, 23, 5), self: true, text: '晚安，好梦' },
    { id: 3, ts: p2At(DAY, 23, 6), self: false, text: '晚安' }
  ];
  let targets = executorMod.dueTargets(p2At(DAY, 23, 40), { store: p2Store(goodnight) });
  assert.equal(targets.length, 2, `cards + life 两声明各一目标：${JSON.stringify(targets)}`);
  const lifeHit = targets.find((t) => t.specId === 'life');
  assert.ok(lifeHit, `life 目标在场：${JSON.stringify(targets)}`);
  assert.equal(lifeHit.day, '2026-11-21', 'life 晚安备明天（dayShift=1）');
  assert.equal(lifeHit.materialDay, DAY, 'life 材料日=今天');
  assert.ok(lifeHit.reason.includes('备'), `life reason=${lifeHit.reason}`);
  targets = cardsOf(targets);
  assert.equal(targets.length, 1, `cards 恰一目标：${JSON.stringify(targets)}`);
  assert.equal(targets[0].day, DAY, '卡按最后消息所在日归属');
  assert.ok(targets[0].reason.includes('晚安'), `reason=${targets[0].reason}`);

  // 晚安 22:30/22:31、最后消息 22:40（hour 22 < 23 gate）→ 晚安不触发；兜底已移除
  // （2026-11-15 所有者拍板：白天不写卡，早睡夜晚的卡由次日 catchup 补全）→ 零目标
  const earlyNight = [
    { id: 1, ts: p2At(DAY, 22, 30), self: true, text: '晚安' },
    { id: 2, ts: p2At(DAY, 22, 31), self: false, text: '晚安好梦' },
    { id: 3, ts: p2At(DAY, 22, 40), self: false, text: '对了明天记得提醒我' }
  ];
  assert.deepEqual(cardsOf(executorMod.dueTargets(p2At(DAY, 23, 10), { store: p2Store(earlyNight) })), []);

  // 边界：最后消息恰 23:00 → gate 放行（≥23:00 含 23:00 整点）
  const edge = [
    { id: 1, ts: p2At(DAY, 22, 58), self: true, text: '晚安好梦' },
    { id: 2, ts: p2At(DAY, 23, 0), self: false, text: '晚安' }
  ];
  targets = cardsOf(executorMod.dueTargets(p2At(DAY, 23, 31), { store: p2Store(edge) }));
  assert.equal(targets.length, 1);
  assert.ok(targets[0].reason.includes('晚安'), '23:00 整点恰在 gate 上 → 命中');

  // 晚安太新鲜（+5min < 30min）→ cards 零目标（补跑只看历史天，当日不兜）
  const fresh = [
    { id: 1, ts: p2At(DAY, 23, 15), self: true, text: '晚安' },
    { id: 2, ts: p2At(DAY, 23, 16), self: false, text: '晚安好梦' }
  ];
  assert.deepEqual(cardsOf(executorMod.dueTargets(p2At(DAY, 23, 21), { store: p2Store(fresh) })), []);
});

test('P2 触发判定：同日已写卡（未过期）→ 晚安跳过；写卡后又有对话（过期）→ 晚安定稿重写；最近日有卡、前日无卡 → catchupDays 补跑', () => {
  const DAY = '2026-11-20';
  // writtenAt 显式锚定（writeCard 支持调用方回溯）：卡写于 23:07（最后消息 23:06 之后）
  // → 未过期 → 晚安跳过。fixture 消息日期（11-20）相对真实 now 在"未来"，不锚定
  // writtenAt 会被判过期——这正是 writtenAt 可传参的测试用途。
  memory.writeCard({ date: DAY, salience: 1, events: ['P2 已写卡'], writtenAt: p2At(DAY, 23, 7) });
  const goodnight = [
    { id: 1, ts: p2At(DAY, 23, 5), self: true, text: '晚安' },
    { id: 2, ts: p2At(DAY, 23, 6), self: false, text: '晚安好梦' }
  ];
  assert.deepEqual(
    executorMod.dueTargets(p2At(DAY, 23, 40), { store: p2Store(goodnight) }).filter((t) => t.specId === 'cards'),
    [],
    '同日已写卡且未过期 → 晚安跳过（幂等：一天一卡；life 目标与本组无关，按 specId 圈定）'
  );
  // catchup：昨天（11-19）有卡（21:30 写，最后消息 21:00 之后=未过期）、前天（11-18）
  // 有消息无卡 → 补跑 2 天前
  memory.writeCard({ date: '2026-11-19', salience: 1, events: ['P2 昨日卡'], writtenAt: p2At('2026-11-19', 21, 30) });
  const msgs = [
    { id: 20, ts: p2At('2026-11-18', 20, 0), self: false, text: '前天聊的' },
    { id: 21, ts: p2At('2026-11-19', 21, 0), self: false, text: '昨天聊的' }
  ];
  const targets = executorMod.dueTargets(p2At('2026-11-20', 12, 0), { store: p2Store(msgs) })
    .filter((t) => t.specId === 'cards');   // L2：life 声明在册，cards 行为按 specId 圈定
  assert.equal(targets.length, 1);
  assert.equal(targets[0].day, '2026-11-18');
  assert.ok(targets[0].reason.includes('补跑'), `reason=${targets[0].reason}`);
});

// ── 写卡追踪（2026-11-15，所有者提议"确保到第二天时前一天的卡片一定完整"）──
// 保证链：白天兜底已移除 → 卡只在晚安（≥23:00）/次日 catchup/按钮三个时机写；
// writtenAt + cardStale 让"写卡后又有对话"的白天版卡在晚安定稿或次日启动时被
// 自动重写补全（同日替换，绝不双卡）。

test('写卡追踪：过期卡（写卡后又有对话）→ 晚安触发定稿重写（补全白天版）', () => {
  const DAY = '2026-11-20';
  // 白天版卡：写于当天 10:00（当日最后消息 23:06 之前 → 过期）
  memory.writeCard({ date: DAY, salience: 1, events: ['白天版'], writtenAt: p2At(DAY, 10, 0) });
  const goodnight = [
    { id: 1, ts: p2At(DAY, 23, 5), self: true, text: '晚安' },
    { id: 2, ts: p2At(DAY, 23, 6), self: false, text: '晚安好梦' }
  ];
  const targets = executorMod.dueTargets(p2At(DAY, 23, 40), { store: p2Store(goodnight) })
    .filter((t) => t.specId === 'cards');
  assert.equal(targets.length, 1, `过期卡 → 晚安定稿重写：${JSON.stringify(targets)}`);
  assert.equal(targets[0].day, DAY);
  assert.ok(targets[0].reason.includes('补全白天版'), `reason=${targets[0].reason}`);
  // cardWrittenAt 读回（person/memory 写卡追踪的字段级验证）
  assert.equal(memory.cardWrittenAt(DAY), p2At(DAY, 10, 0), 'writtenAt 读回一致');
});

test('写卡追踪：旧格式卡（无 writtenAt）不算过期 → 晚安跳过（升级日不批量重写历史）', () => {
  const DAY = '2026-11-21';
  // 直接落一行 DB 旧格式卡（writtenAt 列=NULL——文件时代=直写 jsonl 白盒 fixture，
  // 无 writtenAt 键；V3 等价=白盒 INSERT 缺 writtenAt 列值；source 取写入方缺省 'model'）
  dbmod.transaction(() => {
    dbmod.getDb().prepare('DELETE FROM cards WHERE date = ?').run(DAY);
    dbmod.getDb().prepare("INSERT INTO cards (date, source, salience, events, visibility) VALUES (?, 'model', 1, ?, 'private')")
      .run(DAY, JSON.stringify(['旧格式卡']));
  });
  assert.equal(memory.cardWrittenAt(DAY), null, '旧格式卡 writtenAt=null');
  const goodnight = [
    { id: 1, ts: p2At(DAY, 23, 5), self: true, text: '晚安' },
    { id: 2, ts: p2At(DAY, 23, 6), self: false, text: '晚安好梦' }
  ];
  assert.deepEqual(
    executorMod.dueTargets(p2At(DAY, 23, 40), { store: p2Store(goodnight) }).filter((t) => t.specId === 'cards'),
    [],
    '旧格式卡不算过期 → 晚安跳过（历史日定稿走按钮显式 force，不做批量重写）'
  );
});

test('写卡追踪：catchup 补全过期卡（写卡后当日又有对话 → 次日启动重写补全）', () => {
  const YDAY = '2026-11-18', TODAY = '2026-11-19';
  // 昨天的白天版卡：写于当天 10:00，之后当天又聊到 22:00 → 过期
  memory.writeCard({ date: YDAY, salience: 1, events: ['白天版'], writtenAt: p2At(YDAY, 10, 0) });
  const msgs = [{ id: 30, ts: p2At(YDAY, 22, 0), self: false, text: '写卡之后又聊的' }];
  const targets = executorMod.dueTargets(p2At(TODAY, 12, 0), { store: p2Store(msgs) })
    .filter((t) => t.specId === 'cards');
  assert.equal(targets.length, 1, `过期卡 → 次日 catchup 补全：${JSON.stringify(targets)}`);
  assert.equal(targets[0].day, YDAY);
  assert.ok(targets[0].reason.includes('补全'), `reason=${targets[0].reason}`);
  // 对照：未过期卡（writtenAt 在当日最后消息之后）→ catchup 跳过
  memory.writeCard({ date: YDAY, salience: 1, events: ['完整版'], writtenAt: p2At(YDAY, 23, 0) });
  assert.deepEqual(
    executorMod.dueTargets(p2At(TODAY, 12, 0), { store: p2Store(msgs) }).filter((t) => t.specId === 'cards'),
    [],
    '写卡之后当日无新对话 → 未过期 → catchup 跳过'
  );
});

test('P2 buildTask 日记体协议：先 entry 后骨架 + staging 语义 + 人物表铁律原样 + events 骨架索引', () => {
  const task = cardsSpec.buildTask({
    day: '2026-11-13',
    messages: [{ id: 5212, mid: 5212, ts: p2At('2026-11-13', 12, 3), self: false, senderName: '阿澄', text: '稳一点比快一点更好' }],
    staging: [{ text: '他说稳一点比快一点更好', mid: 5212 }],
    facts: [{ kind: 'identity', content: '他叫阿澄' }],
    life: null
  });
  // 日记体协议：先 entry 后骨架
  assert.ok(task.system.includes('写卡顺序（日记体协议）：先写 entry，再列骨架'), '协议顺序明示');
  assert.ok(task.system.includes('用她的口吻、带着当天的情绪底色'), '口吻与情绪底色要求');
  assert.ok(task.system.includes('让人记住的原句，自然地融进正文里，不要做成引用清单'), '原句融入正文');
  assert.ok(task.system.includes('软目标 200~400 字'), 'entry 软目标');
  assert.ok(task.system.includes('不要引号包装'), 'entry 不加引号');
  assert.ok(task.system.includes('"entry"'), 'JSON 协议带 entry 字段');
  // events 降级为骨架索引
  assert.ok(task.system.includes('events 降级为骨架索引：从日记正文提炼，一句话一条，少而精'), 'events 骨架索引规则');
  assert.ok(task.system.includes('都从日记正文里提炼，是 entry 的索引，不是第二篇总结'), '骨架=索引非第二篇总结');
  // staging 语义强调（system + user 段标题双面）
  assert.ok(task.system.includes('暂存笔记是你自己当时认为值得记下来的东西，优先级高于聊天流水'), 'system staging 语义');
  assert.ok(task.user.includes('【暂存笔记（你自己当时认为值得记下来的，优先级高于聊天流水）】'), 'user 暂存段标题改口径');
  // 人物表铁律原样
  assert.ok(task.system.includes('人物表（铁律）：卡片主人「她」= 你自己；对话里的对方是你的主人。对方的性别、名字、称呼一律以【你（记忆的主人）】段里的人设与既有事实为准——材料里指对方用「他」就写「他」，用「她」就写「她」，材料没写就回避，绝不臆造、绝不改写代词。'), '人物表铁律逐字保留');
});

test('P2 parse 兼容：entry 缺失回退旧格式（entry=\'\'，events 照旧）；引号包装剥掉；只有 entry 也算可记内容', () => {
  const old = cardsSpec.parse(JSON.stringify({ events: ['旧格式事件'], mood: '还行' }), { day: '2026-11-13' });
  assert.equal(old.card.entry, '', 'entry 缺失 → 空串（首日容错）');
  assert.deepEqual(old.card.events, ['旧格式事件'], 'events 照旧');
  assert.equal(old.card.date, '2026-11-13', '目标日以调度为准');
  const wrapped = cardsSpec.parse(JSON.stringify({ entry: '“今天很平常。”', events: [] }), { day: '2026-11-13' });
  assert.equal(wrapped.card.entry, '今天很平常。', '整体引号包装剥掉（内部引号不动）');
  const entryOnly = cardsSpec.parse(JSON.stringify({ entry: '只有正文的一天。' }), { day: '2026-11-13' });
  assert.equal(entryOnly.card.entry, '只有正文的一天。', '只有 entry 也解析成功（正文是卡片主体）');
  assert.throws(() => cardsSpec.parse(JSON.stringify({ events: [], mood: '' }), { day: '2026-11-13' }), /没有任何可记内容/, '全空卡仍抛错走兜底');
});

test('P2 fixture 落卡：runOnce（fixture 模式）→ 卡带 entry 落库 + facts/promises mid 校验通过，全程零网络', async () => {
  const DAY = '2026-11-13';   // = tools/fixtures/card-2026-11-13.json 样卡（真实数据根已有 11-13 卡 → 生产面惰性，沙箱内可写）
  const messages = [
    { id: 5205, mid: 5205, ts: p2At(DAY, 12, 1), self: false, senderName: '阿澄', text: '过来问项目的事' },
    { id: 5212, mid: 5212, ts: p2At(DAY, 12, 3), self: true, text: '我说慢点也没关系，他说不赶' },
    { id: 5216, mid: 5216, ts: p2At(DAY, 18, 2), self: false, senderName: '阿澄', text: '在整理学习笔记，说是状态最好的时候' },
    { id: 5222, mid: 5222, ts: p2At(DAY, 21, 4), self: false, senderName: '阿澄', text: '这几天一直在陪着推进' },
    { id: 5225, mid: 5225, ts: p2At(DAY, 22, 6), self: false, senderName: '阿澄', text: '忙完这轮就带我把旧文件归档' },
    { id: 5228, mid: 5228, ts: p2At(DAY, 23, 2), self: true, text: '晚安，好梦' }
  ];
  let fetchCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('P2 fixture 模式零网络：fetch 不该被调'); };
  let result;
  try {
    result = await executorMod.runOnce('cards', {
      day: DAY,
      data: { chatKey: 'web:main', day: DAY, now: p2At(DAY, 23, 32), messages, staging: [{ text: '他说稳一点比快一点更好', mid: 5212 }], facts: [], life: null }
    });
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(fetchCalls, 0, 'fixture 模式零网络（零 fetch 调用）');
  assert.equal(result.status, 'written', `status=${result.status}`);
  assert.equal(result.mode, 'fixture', '产出模式 = fixture');
  assert.ok(result.card.entry.includes('稳一点比快一点更好'), '卡带日记正文（原句融入）');
  assert.ok(result.card.entry.length >= 200, `entry 正文量级（${result.card.entry.length} 字 ≥ 200 软目标下限）`);
  assert.deepEqual(result.card.events, [
    '他中午来问项目进度，嘱咐稳一点比快一点更好',
    '他说在整理学习笔记，我没多打扰',
    '晚上互道晚安，比昨天早一些'
  ], '骨架 events 来自 fixture 样卡');
  assert.equal(result.midDropped, 0, 'mid 当日校验全过（样卡 mid 在注入消息内）');
  assert.equal(result.factsUpserted, 2, '两条事实走 upsertFact 正路入沙箱 facts');
  const persisted = memory.cards({ from: DAY, to: DAY });
  assert.equal(persisted.length, 1, '沙箱卡片落库（一天一卡）');
  assert.equal(persisted[0].source, 'fixture');
  assert.ok(persisted[0].entry.includes('稳一点比快一点更好'), 'entry 随卡持久化（person/memory 唯一写者）');
});

// ── P5 · factKey 整理脚本幂等 —— 已随 storage-v2 V3 退役（2026-11-17 夜，对照表登记）──
// fact-cleanup-20261114.mjs 是 2026-11-14 的一次性数据整理（已完成并 stamp）；其机制
// =「upsertFact API + facts.jsonl 直改」混用。V3 起 facts 真身 = xunxi.db：API 写落 DB、
// 直改落 .pre-storage-v2 归档文件、脚本自验读文件——混源必然自验失败，测试已无有效
// 断言对象，按「文件级测试退役对照表」退役（禁止无声删除：登记于交接内部文档 handoff-
// sqlite-v2.md 夜3）。脚本所验证的模块行为（幂等短路 / supersededBy 指针 / 额外字段
// 保留）由本套件 upsertFact 组的 DB 等价断言继续覆盖。脚本本体保留（头注已加退役横幅）。


// ═══════════════════════ L3：生活→心绪接线（night-plan-life §L3）═══════════════════════
// 沙箱注入带 emotionalLoad 的今日 plan + 时间推进 → life tick 的 check/consumeDue 断言：
// consumedAt 标记（原子重写一次）。2026-11-21 数值丢弃后本接线不再调 mind.apply
// （载荷不拨任何心绪数值轴）；mood.text 不自动改（文本轴归 mind_note 模型自驱）；
// 只消费今日 plan（历史日/他日不追溯——replay 稳定面）。
const lifeStore = await import('../src/person/life.js');
const lifeWiring = await import('../src/capabilities/reflection/life.js');
const { getDefaultClock } = await import('../src/kernel/clock.js');

const L3_DAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();
const l3At = (h, m) => {
  const [y, mo, dd] = L3_DAY.split('-').map(Number);
  return new Date(y, mo - 1, dd, h, m).getTime();
};
// L4 历史日/他日：运行时从 L3_DAY 推导的前一日/次日——断言语义不变（会话日=过去某天/
// 未来某天，恒 ≠ plan.date=L3_DAY），但与运行时钟无关（原硬编码 '2026-11-13'/'2026-11-15'
// 是时间炸弹：2026-11-15 当日跑套件时"他日"与 plan.date 相撞 → "他日不渲染"误红）。
const L3_PREV_DAY = (() => {
  const [y, mo, dd] = L3_DAY.split('-').map(Number);
  const d = new Date(y, mo - 1, dd - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();
const L3_NEXT_DAY = (() => {
  const [y, mo, dd] = L3_DAY.split('-').map(Number);
  const d = new Date(y, mo - 1, dd + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

/**
 * 沙箱落一份带载荷的今日 plan（形状=writeLifePlan 落库形状：date/dayKey 镜像/items）
 * + 空白心绪种子。六条目覆盖全部分支：
 *   A 08:00 到时载荷 / B 09:00 到时载荷 / F 09:30 到时载荷 / C 23:59 未到时 /
 *   D 07:30 到时无载荷 / E 08:30 带既有 consumedAt（幂等不覆盖）。
 */
function l3Seed({ planItems } = {}) {
  const items = planItems ?? [
    { time: '08:00', activity: 'A 到时载荷', emotionalLoad: { note: '有点烦' } },
    { time: '09:00', activity: 'B 到时载荷', emotionalLoad: { note: '挺顺' } },
    { time: '09:30', activity: 'F 到时载荷', emotionalLoad: { note: '就那样' } },
    { time: '23:59', activity: 'C 未到时载荷', emotionalLoad: { note: '有点期待' } },
    { time: '07:30', activity: 'D 到时无载荷' },
    { time: '08:30', activity: 'E 早已消费', emotionalLoad: { note: '旧账' }, consumedAt: l3At(8, 40) }
  ];
  const plan = { date: L3_DAY, dayKey: L3_DAY, generatedAt: Date.now(), items };
  lifeStore.write({ version: 1, dayKey: L3_DAY, plan, inner: [], lifeLog: [] });
  resetMind();
  writeMindState();
  return plan;
}

group('L3 生活→心绪接线（life tick：check/consumeDue）');

test('L3 check：今日 plan+到时未消费载荷才 true——无 plan/昨日 plan/全消费/未到时 全 false', () => {
  l3Seed();
  assert.equal(lifeWiring.checkDue({ now: l3At(10, 0) }), true, 'A/B/F 到时未消费 → true');
  assert.equal(lifeWiring.checkDue({ now: l3At(7, 59) }), false, '全部未到时（D 无载荷、E 已消费）→ false');

  resetLife();
  assert.equal(lifeWiring.checkDue({ now: l3At(10, 0) }), false, 'life 状态缺失（state 无行）→ false');

  // 昨日 plan（历史日不消费——日子过了就过了）
  lifeStore.write({
    version: 1, dayKey: '2026-11-13',
    plan: { date: '2026-11-13', dayKey: '2026-11-13', items: [{ time: '08:00', activity: '昨日遗留', emotionalLoad: { valence: -0.3, note: '过了' } }] }
  });
  assert.equal(lifeWiring.checkDue({ now: l3At(10, 0) }), false, 'plan 非今日 → false');
  assert.deepEqual(lifeWiring.consumeDue({ now: l3At(10, 0) }), { due: 0, applied: 0, marked: 0, saved: false }, '昨日遗留不消费不标记');
  assert.equal(lifeStore.read().plan.items[0].consumedAt, undefined, '昨日条目原样（零字段增删）');

  // 今日但载荷全部已消费
  lifeStore.write({
    version: 1, dayKey: L3_DAY,
    plan: { date: L3_DAY, dayKey: L3_DAY, items: [{ time: '08:00', activity: '已消费', emotionalLoad: { valence: 0.2, note: 'x' }, consumedAt: l3At(9, 0) }] }
  });
  assert.equal(lifeWiring.checkDue({ now: l3At(10, 0) }), false, '载荷全部已消费 → false');

  // 今日、未消费、但未到时
  lifeStore.write({
    version: 1, dayKey: L3_DAY,
    plan: { date: L3_DAY, dayKey: L3_DAY, items: [{ time: '23:59', activity: '未到时', emotionalLoad: { note: 'x' } }] }
  });
  assert.equal(lifeWiring.checkDue({ now: l3At(10, 0) }), false, '载荷存在但未到时 → false');
});

test('L3 run：到时未消费逐条标 consumedAt 原子落库（不拨心绪数值轴）；C 未到时/D 无载荷/E 已消费不动', () => {
  l3Seed();
  const now = l3At(10, 0);
  const before = mind.snapshot();
  assert.equal(before.mood.text, '', '前置：心绪文本轴为空');

  const res = lifeWiring.consumeDue({ now });
  assert.deepEqual(res, { due: 3, applied: 3, marked: 3, saved: true }, `A/B/F 三条到时（C 未到时、D 无载荷、E 已消费）：${JSON.stringify(res)}`);

  // 2026-11-21 数值丢弃：载荷不再进 mind——快照零变化（文本轴归 mind_note 模型自驱）
  const after = mind.snapshot();
  assert.equal(JSON.stringify(after), JSON.stringify(before), 'mind 快照零变化（载荷不拨数值轴、不挂心事）');

  const byTime = Object.fromEntries(lifeStore.read().plan.items.map((i) => [i.time, i]));
  assert.equal(byTime['08:00'].consumedAt, now, 'A 标 consumedAt');
  assert.equal(byTime['09:00'].consumedAt, now, 'B 标 consumedAt');
  assert.equal(byTime['09:30'].consumedAt, now, 'F 也标——事件已发生');
  assert.equal(byTime['23:59'].consumedAt, undefined, 'C 未到时不标');
  assert.equal(byTime['07:30'].consumedAt, undefined, 'D 无载荷不标');
  assert.equal(byTime['08:30'].consumedAt, l3At(8, 40), 'E 既有标记原样保留（不覆盖不重算）');

  // 幂等：同刻重跑零消费、零写盘（replay 稳定的标记面）
  assert.deepEqual(lifeWiring.consumeDue({ now }), { due: 0, applied: 0, marked: 0, saved: false }, '幂等：全消费后 due=0');
});

test('L3 时间推进：未到时条目到点后 check→true、消费+标记；全消费后 check→false', () => {
  l3Seed();
  lifeWiring.consumeDue({ now: l3At(10, 0) });
  assert.equal(lifeWiring.checkDue({ now: l3At(10, 0) }), false, 'A/B/F 已消费 → check false');
  assert.equal(lifeWiring.checkDue({ now: l3At(23, 59) }), true, '时间推进 → C 到时 check true');

  assert.deepEqual(lifeWiring.consumeDue({ now: l3At(23, 59) }), { due: 1, applied: 1, marked: 1, saved: true }, 'C 恰到点即算到（与 executor dailyTime 同口径）');
  assert.equal(lifeStore.read().plan.items.find((i) => i.time === '23:59').consumedAt, l3At(23, 59), 'C 标 consumedAt');
  assert.equal(lifeWiring.checkDue({ now: l3At(23, 59) }), false, '全消费 → false（下轮心跳零动作）');
});

test('L3 载荷形状宽松：直接落库的异常形状（无 note/值畸形）也标记——解析面已保证 note 非空，标记面不做二次门控', () => {
  l3Seed({ planItems: [{ time: '08:00', activity: '畸形载荷', emotionalLoad: { valence: 'oops' } }] });
  assert.deepEqual(lifeWiring.consumeDue({ now: l3At(10, 0) }), { due: 1, applied: 1, marked: 1, saved: true }, '异常形状载荷照常标记（数值面已不存在，无重试语义）');
  assert.equal(lifeStore.read().plan.items[0].consumedAt, l3At(10, 0), '标记落库');
  assert.equal(lifeWiring.checkDue({ now: l3At(10, 0) }), false, '标记后 check false');
});

test('L3 orchestrator.startClock 注册第三 tick life——钟驱动 check→run 全链（fire 一次=标记）', async () => {
  l3Seed();
  const clock = getDefaultClock();
  const orch = new Orchestrator({ store: { listChats: () => [], recent: () => [] }, stickers: {}, sessions: {} });
  orch.startClock();
  try {
    assert.deepEqual(
      clock.listTicks().filter((id) => ['reflection', 'diary', 'life'].includes(id)),
      ['reflection', 'diary', 'life'],
      '三 tick 在册（life 与 reflection/diary 同款 60s 心跳，钟不含业务词表）'
    );
    const fired = await clock.fire(l3At(10, 0));
    assert.ok(fired >= 1, `fire 触发 ≥1 个 tick（got ${fired}）`);
    const byTime = Object.fromEntries(lifeStore.read().plan.items.map((i) => [i.time, i]));
    assert.equal(byTime['08:00'].consumedAt, l3At(10, 0), '钟链路标 consumedAt（A）');
    assert.equal(byTime['09:00'].consumedAt, l3At(10, 0), '钟链路标 consumedAt（B）');
    assert.equal(byTime['09:30'].consumedAt, l3At(10, 0), '钟链路标 consumedAt（F）');
    assert.equal(byTime['23:59'].consumedAt, undefined, '未到时条目不动');
    assert.equal(mind.snapshot().mood.text, '', '钟链路同样不碰 mood.text');
  } finally {
    orch.stopClock();   // 停心跳（登记保留是钟的既有语义；测试进程不挂 60s 定时器尾巴）
  }
});

// ═══════════════════════ T6：只读可用性派生（night-plan §2-T6 / design §2.3 D18）═══════════════════════
// availability() 三规则写死（sleeping/busy/available）：dnd 免打扰窗 + life 计划睡眠段 →
// sleeping；当前时段条目词面命中专注/在忙 → busy；缺省 available（无 life 状态=away 按
// available 处理）。只读派生：不新增状态写者、调用零写入。时刻由参数注入（确定性）。
const { updateConfig: t6UpdateConfig, getConfig: t6GetConfig } = await import('../src/config.js');

group('T6 life.availability()（D18 三规则：只读派生，不做打分）');

test('T6 R1a：dnd 免打扰窗（缺省 23:30→08:00，跨午夜）→ sleeping；半开区间 [start,end) 边界', () => {
  resetLife();
  assert.equal(lifeStore.availability(l3At(23, 45)), 'sleeping', '23:45 ∈ [23:30, 24:00) → sleeping');
  assert.equal(lifeStore.availability(l3At(23, 29)), 'available', '23:29 差一分钟（窗端点 start 含入语义）→ available');
  assert.equal(lifeStore.availability(l3At(23, 30)), 'sleeping', '23:30 恰在 start → sleeping');
  assert.equal(lifeStore.availability(l3At(0, 30)), 'sleeping', '00:30 ∈ [00:00, 08:00) 跨午夜段 → sleeping');
  assert.equal(lifeStore.availability(l3At(7, 59)), 'sleeping', '07:59 窗内 → sleeping');
  assert.equal(lifeStore.availability(l3At(8, 0)), 'available', '08:00 恰在 end（<end 半开语义）→ 窗外');
  assert.equal(lifeStore.availability(l3At(12, 0)), 'available', '12:00 窗外且无计划 → available');
});

test('T6 R1a 关窗对照：dnd 置空窗（00:00→00:00）后 23:45 不再判 sleeping → 恢复缺省', () => {
  resetLife();
  t6UpdateConfig({ voice: { call: { dnd: { start: '00:00', end: '00:00' } } } });   // 空窗=规则不判
  try {
    assert.equal(lifeStore.availability(l3At(23, 45)), 'available', '无 dnd、无计划 → available');
  } finally {
    t6UpdateConfig({ voice: { call: { dnd: { start: '23:30', end: '08:00' } } } });   // 恢复缺省形状
  }
  assert.deepEqual(t6GetConfig().voice.call.dnd, { start: '23:30', end: '08:00' }, 'dnd 已恢复缺省');
  assert.equal(lifeStore.availability(l3At(23, 45)), 'sleeping', '恢复后 23:45 → sleeping');
});

test('T6 R1b：life 计划睡眠段（词面"睡/就寝"条目时段覆盖 now）→ sleeping（早于 dnd 窗）', () => {
  t6UpdateConfig({ voice: { call: { dnd: { start: '00:00', end: '00:00' } } } });   // 关 dnd：单测计划派生
  try {
    lifeStore.write({
      plansByDay: {
        [L3_DAY]: { date: L3_DAY, dayKey: L3_DAY, items: [
          { time: '09:00', activity: '给客户的插画稿改第三版' },
          { time: '22:00', activity: '洗漱睡觉' }
        ] }
      }
    });
    assert.equal(lifeStore.availability(l3At(22, 30)), 'sleeping', '22:30 落在"洗漱睡觉"时段 → sleeping');
    assert.equal(lifeStore.availability(l3At(21, 59)), 'busy', '21:59 仍落"插画稿"时段（覆盖=[09:00,22:00)）→ busy');
    assert.equal(lifeStore.availability(l3At(9, 30)), 'busy', '09:30 落在"插画稿改第三版"（画稿词面）→ busy');
    assert.equal(lifeStore.availability(l3At(22, 0)), 'sleeping', '22:00 恰入睡眠条目（<下一条 time 语义）→ sleeping');
  } finally {
    t6UpdateConfig({ voice: { call: { dnd: { start: '23:30', end: '08:00' } } } });
    resetLife();
  }
});

test('T6 R2：当前时段专注/在忙词面 → busy；R3 缺省 available（无状态/无条目/away）', () => {
  t6UpdateConfig({ voice: { call: { dnd: { start: '00:00', end: '00:00' } } } });
  try {
    lifeStore.write({
      plansByDay: {
        [L3_DAY]: { date: L3_DAY, dayKey: L3_DAY, items: [
          { time: '10:00', activity: '专注赶稿，截稿就在明天' },
          { time: '12:00', activity: '煮碗面，加个煎蛋' },
          { time: '14:00', activity: '出门散步' }
        ] }
      }
    });
    assert.equal(lifeStore.availability(l3At(10, 30)), 'busy', '10:30 落"专注赶稿"时段 → busy');
    assert.equal(lifeStore.availability(l3At(12, 30)), 'available', '12:30 煮面/散步都不是忙词 → available');
    assert.equal(lifeStore.availability(l3At(14, 30)), 'available', '14:30 散步 → available');
    assert.equal(lifeStore.availability(l3At(7, 0)), 'available', '07:00 早于全部条目 → 无时段 → available');
    resetLife();
    assert.equal(lifeStore.availability(l3At(12, 0)), 'available', 'life 状态缺失（away）→ 按 available，不无依据拒绝');
  } finally {
    t6UpdateConfig({ voice: { call: { dnd: { start: '23:30', end: '08:00' } } } });
    resetLife();
  }
});

test('T6 只读性：availability 调用前后 life state 行逐字节不变（零写入零副作用）', () => {
  lifeStore.write({
    plansByDay: {
      [L3_DAY]: { date: L3_DAY, dayKey: L3_DAY, items: [{ time: '10:00', activity: '专注改稿' }, { time: '22:00', activity: '睡觉' }] }
    }
  });
  const before = stateRowOf('life');
  lifeStore.availability(l3At(10, 30));
  lifeStore.availability(l3At(22, 30));
  lifeStore.availability(l3At(23, 45));
  const after = stateRowOf('life');
  assert.deepEqual(after, before, 'state.life 行零变化（只读派生，不新增写者）');
  resetLife();
});

// ═══════════════════════ L4：今日段进提示词（night-plan-life §L4）═══════════════════════
// renderLifeTodaySection(plan, sessionDay)：只在 plan.date === 会话当日 才渲染——
// 历史会话重渲染恒不含（replay 稳定的关键设计，铁律 2）；接线=buildUserPrompt 尾部
// 易变区（心绪之后、当前时间之前）。三原则 1"日程饱满带扰动"的提示词面。
group('L4 今日段进提示词（renderLifeTodaySection：按会话日渲染，历史日不渲染）');

test('L4 纯函数：plan 缺失/历史日/他日/空条目 → 整段缺席（"历史日不渲染"回归）', () => {
  // plan 缺失（life.json 未写过/损坏 → lifeRead()=null → plan null）
  assert.equal(promptMod.renderLifeTodaySection(null, L3_DAY), '', 'plan null → 整段缺席');
  assert.equal(promptMod.renderLifeTodaySection(undefined, L3_DAY), '', 'plan undefined → 整段缺席');
  assert.equal(promptMod.renderLifeTodaySection('oops', L3_DAY), '', 'plan 非对象 → 整段缺席');

  // 同一份今日 plan：sessionDay 换成任何别的日子都恒 ''——历史会话重渲染逐字节可复现
  const plan = { date: L3_DAY, dayKey: L3_DAY, generatedAt: l3At(6, 30), items: [{ time: '08:00', activity: 'L4回归事项' }] };
  assert.equal(promptMod.renderLifeTodaySection(plan, L3_PREV_DAY), '', '历史日不渲染（会话日=过去某天，恒 ≠ plan.date）');
  assert.equal(promptMod.renderLifeTodaySection(plan, L3_NEXT_DAY), '', '他日（未来日）不渲染');
  assert.equal(promptMod.renderLifeTodaySection(plan, ''), '', 'sessionDay 空 → 不渲染');
  assert.equal(promptMod.renderLifeTodaySection(plan, undefined), '', 'sessionDay 缺失 → 不渲染');
  assert.equal(promptMod.renderLifeTodaySection(plan, 'not-a-day'), '', 'sessionDay 不合格 → 不渲染');
  assert.ok(promptMod.renderLifeTodaySection(plan, L3_DAY).startsWith('【今日日程】'), '同 plan + 会话当日 → 渲染（对照面成立）');

  // date 是权威判定字段；dayKey 镜像不参与
  assert.equal(promptMod.renderLifeTodaySection({ date: '2026-11-13', dayKey: L3_DAY, items: [{ time: '08:00', activity: 'x' }] }, L3_DAY), '', 'date≠会话日但 dayKey=会话日 → 仍不渲染（date 唯一权威）');

  // 条目空/全不合格 → 空标题也不出现
  assert.equal(promptMod.renderLifeTodaySection({ date: L3_DAY, items: [] }, L3_DAY), '', '今日 plan 条目为空 → 整段缺席');
  assert.equal(promptMod.renderLifeTodaySection({ date: L3_DAY, items: [null, { time: '', activity: 'x' }, { time: '08:00', activity: '' }] }, L3_DAY), '', '条目全不合格 → 整段缺席');
});

test('L4 纯函数：今日 plan 渲染三形态——已消费（已发生）/未消费情绪注/无载荷；预算 200', () => {
  const plan = {
    date: L3_DAY, dayKey: L3_DAY, generatedAt: l3At(6, 30),
    items: [
      { time: '08:00', activity: 'L4已消费事项', emotionalLoad: { valence: -0.3, note: '有点烦' }, consumedAt: l3At(8, 5) },
      { time: '09:00', activity: 'L4未消费载荷事项', emotionalLoad: { valence: 0.2, note: '挺顺' } },
      { time: '10:00', activity: 'L4无载荷事项' }
    ]
  };
  const sec = promptMod.renderLifeTodaySection(plan, L3_DAY);
  assert.ok(sec.startsWith('【今日日程】\n'), '段头【今日日程】');
  assert.ok(sec.includes('- 08:00 L4已消费事项（已发生）'), '已消费载荷 → 标"（已发生）"（不露旧情绪注）');
  assert.ok(sec.includes('- 09:00 L4未消费载荷事项（挺顺）'), '未消费带载荷 → 情绪注（三原则 2）');
  assert.ok(sec.includes('- 10:00 L4无载荷事项'), '无载荷 → 纯时间+事项');
  assert.equal(sec.split('（已发生）').length - 1, 1, '（已发生）只在已消费条目出现一次');
  const body = sec.slice('【今日日程】\n'.length);
  assert.ok(body.length <= 200, `条目列表 ≤200 字（实际 ${body.length}）`);
  assert.ok(sec.length <= 207, `整段 ≤200+段头 7 字（实际 ${sec.length}）`);

  // 时间升序=plan.items 生成序原样保序
  assert.ok(sec.indexOf('- 08:00') < sec.indexOf('- 09:00') && sec.indexOf('- 09:00') < sec.indexOf('- 10:00'), '条目按 items 生成序（时间升序）');
});

test('L4 纯函数：预算 200 截断——保先列条目、最后一条事项正文截（时间/标注必保）、其余整条丢弃', () => {
  const long = '事'.repeat(35);
  const plan = {
    date: L3_DAY, dayKey: L3_DAY, generatedAt: l3At(6, 30),
    items: [
      // 确算（预算 200 含换行）：A'- 08:00 '+35+'（已发生）'=48 → B/C/D 各 44（43+换行）
      // → 剩 20；E 48 放不下 → 事项正文截 7 字 '- 12:00 事事事事事事事（还行）'=19（20 恰尽）；
      // F/G 整条丢弃。
      { time: '08:00', activity: long, emotionalLoad: { valence: -0.3, note: '有点烦' }, consumedAt: l3At(8, 5) },
      { time: '09:00', activity: long },
      { time: '10:00', activity: long },
      { time: '11:00', activity: long },
      { time: '12:00', activity: long, emotionalLoad: { valence: 0.1, note: '还行' } },
      { time: '13:00', activity: long },
      { time: '14:00', activity: long }
    ]
  };
  const sec = promptMod.renderLifeTodaySection(plan, L3_DAY);
  const body = sec.slice('【今日日程】\n'.length);
  assert.equal(body.length, 200, `条目列表硬预算恰 ≤200（实际 ${body.length}）`);
  assert.ok(body.startsWith(`- 08:00 ${long}（已发生）`), '首条完整带标注');
  const lines = body.split('\n');
  assert.equal(lines.length, 5, `预算装下 4 条整 + 1 条截（渲染 ${lines.length}/7 条）`);
  assert.ok(body.endsWith('事（还行）'), '截断行以完整标注结尾（标注必保）');
  assert.ok(body.includes('- 12:00 '), '截断行时间完整（时间必保）');
  assert.ok(!body.includes('13:00') && !body.includes('14:00'), '预算外条目整条丢弃');
});

test('L4 接线：buildUserPrompt 今日会话含【今日日程】（未读信息后/当前时间前，心绪之后）；历史 startedAt 不渲染', () => {
  // P14（2026-11-20）：life.promptMode 缺省 off；本用例验证 prose 回退路径，显式打开。
  const l4SavedCfg = configMod.getConfig();
  configMod.setRuntimeConfig({ ...l4SavedCfg, life: { ...(l4SavedCfg.life || {}), promptMode: 'prose' } });
  // 沙箱落今日 plan（三形态条目，文本带 L4 前缀防碰撞）
  lifeStore.write({
    version: 1, dayKey: L3_DAY,
    plan: {
      date: L3_DAY, dayKey: L3_DAY, generatedAt: l3At(6, 30),
      items: [
        { time: '08:00', activity: 'L4接线已消费事项', emotionalLoad: { valence: -0.2, note: '有点烦' }, consumedAt: l3At(8, 10) },
        { time: '14:00', activity: 'L4接线未消费事项', emotionalLoad: { valence: 0.2, note: '有点期待' } },
        { time: '19:00', activity: 'L4接线无载荷事项' }
      ]
    }
  });
  const trigger = { id: 31, mid: 9101, ts: NOW, senderId: '10001', senderName: '星野', text: '今天晚上要不要一起拼模型', self: false };
  const mkCtx = (startedAt) => ({
    chatKey: 'private:10001', kind: 'private', chatId: '10001',
    triggerEntries: [trigger],
    store: { recent: () => [trigger] },
    stickerEntries: [],
    session: { surface: 'web', startedAt },
    promptAnchor: { prev: null }
  });
  const up = promptMod.buildUserPrompt(mkCtx(l3At(11, 0)));
  assert.ok(up.includes('【今日日程】'), '今日 plan + 会话当日 → 今日段进提示词');
  assert.ok(up.includes('- 08:00 L4接线已消费事项（已发生）'), '已消费条目在提示词中标（已发生）');
  assert.ok(up.includes('- 14:00 L4接线未消费事项（有点期待）'), '未消费条目带情绪注');
  assert.ok(up.includes('- 19:00 L4接线无载荷事项'), '无载荷条目纯时间+事项');
  // 接线位：尾部易变区——未读信息之后；心绪段在场时在其后；恒在【当前时间】之前
  const iUnread = up.indexOf('【未读信息】');
  const iLife = up.indexOf('【今日日程】');
  const iTime = up.indexOf('【当前时间】');
  const iMind = up.indexOf('【你此刻的心绪');
  assert.ok(iUnread > 0 && iLife > iUnread, '【今日日程】在【未读信息】之后（尾部易变区）');
  assert.ok(iTime > iLife, '【今日日程】在【当前时间】之前（恒最末原则不破）');
  if (iMind > 0) assert.ok(iLife > iMind, '心绪段在场时【今日日程】在其后（§L4 接线位=心绪之后）');
  assert.ok(!up.includes('【今日日程】', iTime), '【当前时间】之后无第二处今日段（今日段不抢"恒最末"位）');

  // 回归：同一沙箱、同一 plan——历史会话（startedAt=过去某天）重渲染恒不含今日段
  const upHist = promptMod.buildUserPrompt(mkCtx(new Date(2026, 10, 12, 11, 0).getTime()));
  assert.ok(!upHist.includes('【今日日程】'), '历史日不渲染：历史会话重渲染恒不含今日段（replay 稳定关键设计）');
  // 回归：会话当日但 plan.date 是别的日子 → 也不渲染
  lifeStore.write({
    version: 1, dayKey: '2026-11-13',
    plan: { date: '2026-11-13', dayKey: '2026-11-13', items: [{ time: '08:00', activity: 'L4昨日遗留事项' }] }
  });
  const upStale = promptMod.buildUserPrompt(mkCtx(l3At(11, 0)));
  assert.ok(!upStale.includes('【今日日程】'), 'plan 非今日 → 今日段缺席（他日 plan 不渲染）');
  assert.ok(!upStale.includes('L4昨日遗留事项'), '昨日条目内容零泄漏');

  // 收尾：清掉沙箱 plan，不污染后续（若有）用例
  lifeStore.write({ version: 1, dayKey: L3_DAY, plan: null });
  configMod.setRuntimeConfig(l4SavedCfg);
});


// ═════════════════ card-vector 夜1 · 写入链路（T1.9）═══════════════════════
// 覆盖（执行清单 T1.9）：memory.embedding 缺省关闭态 config 快照；llm.embed 关闭/
// 缺配置/坏端点语义；parse 清洗（gist ≤40 / keywords ≤10）；normalizeCard 白名单透传
// （fixture 落卡含 gist/keywords——计划硬伤①回归）；兜底卡无 gist → syncCard 跳过；
// syncCard hash 跳过 / 模型或维度变更清表；syncFact upsert + 对账修剪（孤儿行删除）；
// rebuildFromApi 幂等；search 点积降序；prefetchQuery/peekQuery。
// 数据隔离：索引/卡/事实全落本套件临时数据根（DATA_ROOT/index 等沙箱内）；嵌入通道 =
// mock globalThis.fetch（sha1 确定性假向量，零网络零模型调用）；开关用 setRuntimeConfig
// （仅内存态，测后还原；磁盘 config.json 零触碰）。
// ═══════════════════════ life-prose v2（2026-11-16）═══════════════════════
group('life-prose v2（plansByDay/22:00 晚安闸/两段式 prose/旧回退）');

const diaryMod = await import('../src/capabilities/reflection/diary.js');

test('life-prose T1：plansByDay 日期键——先写明天再写今天，明天不被顶掉；重复写明天幂等', async () => {
  resetLife();
  const store = { listChats: () => ['main'], recent: () => [] };
  const t0 = p2At('2026-12-31', 23, 40);
  const a = await executorMod.runOnce('life', { day: '2027-01-01', materialDay: '2026-12-31', now: t0, store });
  assert.equal(a.status, 'written', 'fixture 2027-01-01 写入');
  assert.ok(a.prose >= 80, `prose 落库（实际 ${a.prose}）`);
  assert.equal(lifeStore.planForDay('2027-01-01')?.date, '2027-01-01', 'planForDay 读 plansByDay');
  assert.equal(lifeStore.planForDay('2026-12-31'), null, '今天尚无 plan');
  const b = await executorMod.runOnce('life', { day: '2026-12-31', materialDay: '2026-12-31', now: t0 + 60000, store });
  assert.equal(b.status, 'written', '再写今天');
  assert.equal(lifeStore.planForDay('2026-12-31')?.date, '2026-12-31', '今天 plan 在');
  assert.equal(lifeStore.planForDay('2027-01-01')?.date, '2027-01-01', '明天 plan 未被今天顶掉');
  assert.equal(lifeStore.read().plan?.date, '2026-12-31', 'plan 镜像=今天');
  const gen = lifeStore.planForDay('2027-01-01').generatedAt;
  const c = await executorMod.runOnce('life', { day: '2027-01-01', materialDay: '2026-12-31', now: t0 + 120000, store });
  assert.equal(c.status, 'skipped', '重复写明天由 planExists 幂等');
  assert.equal(c.reason, 'plan-exists');
  assert.equal(lifeStore.planForDay('2027-01-01').generatedAt, gen, '明天 plan 未被重写');
  assert.deepEqual(Object.keys(lifeStore.read().plansByDay).sort(), ['2026-12-31', '2027-01-01'], 'plansByDay 两日并存');
});

test('life-prose T2：文字晚安 21:59 不触发 / 22:00 触发备明天；跨年目标日；dailyTime 兜底保留', () => {
  resetLife();
  const DAY = '2026-12-31';
  // 今日 plan 已在（模拟 06:30 已生成）——否则 dailyTime 兜底会合法地在 22:29 也 due，
  // 掩盖“晚安被 22:00 gate 挡”的断言。
  const todayPlan = { date: DAY, dayKey: DAY, items: [{ time: '08:00', activity: '今日已生成的计划' }] };
  lifeStore.write({ version: 1, plan: todayPlan, plansByDay: { [DAY]: todayPlan } });
  const target = (msgs, now) => executorMod.dueTargets(now, { store: p2Store(msgs) }).filter((t) => t.specId === 'life');
  const early = [
    { id: 1, ts: p2At(DAY, 21, 58), self: true, text: '晚安' },
    { id: 2, ts: p2At(DAY, 21, 59), self: false, text: '晚安好梦' }
  ];
  assert.deepEqual(target(early, p2At(DAY, 22, 29)), [], '21:59 晚安被 22:00 gate 挡');
  const on = [
    { id: 1, ts: p2At(DAY, 22, 0), self: true, text: '晚安' },
    { id: 2, ts: p2At(DAY, 22, 1), self: false, text: '晚安好梦' }
  ];
  assert.deepEqual(target(on, p2At(DAY, 22, 29)), [], '22:00 晚安 +29min 尚未到 30min');
  const hit = target(on, p2At(DAY, 22, 31));
  assert.equal(hit.length, 1, '22:00 晚安 +31min → 触发');
  assert.equal(hit[0].day, '2027-01-01', '跨年目标日=明年 01-01');
  assert.equal(hit[0].materialDay, DAY, '材料日=今天');
  // dailyTime 兜底：无晚安、06:31 且当天无 plan → 目标日=今天
  const fallback = target([], p2At('2027-01-01', 6, 31));
  assert.equal(fallback.length, 1, 'dailyTime 兜底在册');
  assert.equal(fallback[0].day, '2027-01-01', '兜底目标日=今天');
  assert.ok(fallback[0].reason.includes('每日计划'), `reason=${fallback[0].reason}`);
});

test('life-prose T3：prose 渲染 + 状态句；旧 plan 逐字节回退 legacy 渲染', () => {
  const prose = '明天想把日子过慢一点。'.repeat(8);
  const plan = {
    date: L3_DAY, dayKey: L3_DAY, prose,
    items: [
      { time: '08:00', activity: '已经发生的事', consumedAt: l3At(9, 0) },
      { time: '10:00', activity: '还没到的事' }
    ]
  };
  const sec = promptMod.renderLifeTodaySection(plan, L3_DAY);
  assert.ok(sec.startsWith('【今日日程】\n'), '段头');
  assert.ok(sec.includes(prose), 'prose 原样进段');
  assert.ok(sec.includes('已经过去了') && sec.includes('还在前头'), '动态状态句');
  const legacyPlan = {
    date: L3_DAY, dayKey: L3_DAY,
    items: [
      { time: '08:00', activity: '旧条目已发生', consumedAt: l3At(9, 0) },
      { time: '09:00', activity: '旧条目未消费', emotionalLoad: { valence: 0.2, note: '旧情绪注' } }
    ]
  };
  assert.equal(
    promptMod.renderLifeTodaySection(legacyPlan, L3_DAY),
    promptMod.renderLegacyLifeTodaySection(legacyPlan),
    '无 prose → 旧条目渲染逐字节一致'
  );
  const long = { date: L3_DAY, prose: '甲'.repeat(500), items: [] };
  const body = promptMod.renderLifeTodaySection(long, L3_DAY).slice('【今日日程】\n'.length);
  assert.ok(body.length <= 400, `prose 截断 ≤400（实际 ${body.length}）`);
});

test('life-prose T4：日记读当天 prose；无 prose 回退 items 摘要', () => {
  const plan = { date: L3_DAY, dayKey: L3_DAY, prose: '今天去了很多地方，走了很远的路，回来时天已经黑了。' };
  lifeStore.write({ version: 1, plan, plansByDay: { [L3_DAY]: plan } });
  const r = diaryMod.readLifeToday(l3At(12, 30));
  assert.equal(r.events.length, 1, '日记素材=prose 一段');
  assert.ok(r.events[0].startsWith('今天去了很多地方'), 'prose 原样作为素材');
  const fallback = { date: L3_DAY, dayKey: L3_DAY, items: [{ time: '08:00', activity: '旧事一' }, { time: '09:00', activity: '旧事二' }] };
  lifeStore.write({ version: 1, plan: fallback, plansByDay: { [L3_DAY]: fallback } });
  const r2 = diaryMod.readLifeToday(l3At(12, 30));
  assert.deepEqual(r2.events, ['08:00 旧事一', '09:00 旧事二'], '无 prose → items 摘要');
});

test('life-prose T5：fixture 无 prose → items-only plan（不阻塞、不进失败冷却）', async () => {
  resetLife();
  const store = { listChats: () => ['main'], recent: () => [] };
  const r = await executorMod.runOnce('life', { day: '2026-11-14', now: p2At('2026-11-14', 23, 40), store });
  assert.equal(r.status, 'written', '旧 fixture 仍写 items-only');
  assert.equal(r.prose, 0, 'prose 为空');
  assert.equal(lifeStore.planForDay('2026-11-14')?.prose, '', '落库 prose 空串');
  assert.ok(lifeStore.planForDay('2026-11-14')?.items.length >= 3, 'items 保留');
});

group('card-vector 夜1 写入链路（协议/透传/索引）');

const { cardIndex } = await import('../src/capabilities/reflection/card-index.js');
const llmMod = await import('../src/llm.js');
const configMod = await import('../src/config.js');

// 沙箱基线：writer.mode 显式钳 'fixture'（2026-11-22 清理起 DEFAULT_CONFIG 默认改为
// 'model'——本套件硬规则是零网络零模型调用，凡走产出管线的用例（P2 落卡/life-prose/
// card-vector 透传等）都依赖 fixture 路径，不能随出厂默认值漂移；个别用例再按需覆盖）。
const p2WriterCfg = configMod.getConfig();
configMod.setRuntimeConfig({
  ...p2WriterCfg,
  memory: { ...p2WriterCfg.memory, writer: { mode: 'fixture' } }
});

const INDEX_FILE = path.join(DATA_ROOT, 'index', 'card-index.json');
/** 白盒读索引状态（断言用；写入只经 cardIndex API——派生索引唯一写者纪律）。 */
function readIndexState() {
  return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
}
const cvSavedConfig = configMod.getConfig();   // 本组开场快照（还原基准；此刻 = DEFAULT_CONFIG）
// 假嵌入 provider（DEFAULT_CONFIG.providers=[]，沙箱无 config.json——生产环境该 id 由
// 实机 config.json 提供（夜0 T0.4：custom_mvgbzl9p8rb0 → http://127.0.0.1:1234/v1）。
// 测试注入假条目 + mock fetch，只走内存态，测后还原。）
const CV_FAKE_PROVIDER_ID = 'cv-fake-lmstudio';
/** 内存态临时开启嵌入（含 provider 条目注入与覆盖项）；finally 一律 setRuntimeConfig(cvSavedConfig) 还原。 */
function withEmbedding(over = {}) {
  configMod.setRuntimeConfig({
    ...cvSavedConfig,
    providers: [
      ...(Array.isArray(cvSavedConfig.providers) ? cvSavedConfig.providers : []),
      { id: CV_FAKE_PROVIDER_ID, baseURL: 'http://127.0.0.1:9/v1', displayName: 'person-tests 假嵌入端点', api: 'openai' }
    ],
    dshProviderKeys: { ...(cvSavedConfig.dshProviderKeys ?? {}), [CV_FAKE_PROVIDER_ID]: '' },
    memory: { ...cvSavedConfig.memory, embedding: { ...cvSavedConfig.memory.embedding, provider: CV_FAKE_PROVIDER_ID, enabled: true, ...over } }
  });
}
/** flush fire-and-forget 微任务（runOnce 的 syncCard 不被 await）。 */
const cvSettle = () => new Promise((r) => setTimeout(r, 20));

// 确定性假嵌入：sha1(`${text}:${i}`) 首字节 → [-1,1]，L2 归一化。同输入恒同向量 →
// 点积可排序（同输入=1.0 恒为自身最相似）；模型名含 '768' 时返回 768 维（维度变更清表断言用）。
const FAKE_DIM = 128;
function fakeVec(text, dim = FAKE_DIM) {
  const out = [];
  for (let i = 0; i < dim; i += 1) {
    const b = crypto.createHash('sha1').update(`${String(text ?? '')}:${i}`).digest()[0];
    out.push((b - 127.5) / 127.5);
  }
  const norm = Math.hypot(...out);
  return out.map((v) => v / norm);
}
/** 安装假 embeddings 端点（OpenAI 兼容形）；返回原 fetch（finally 还原用）。 */
let cvLastEmbedBody = null;
function installFakeEmbedFetch(counters) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    counters.calls += 1;
    if (!String(url).endsWith('/embeddings')) throw new Error(`fake fetch：未预期的请求 ${url}`);
    cvLastEmbedBody = JSON.parse(opts.body ?? '{}');
    const input = typeof cvLastEmbedBody.input === 'string' ? cvLastEmbedBody.input : String(cvLastEmbedBody.input ?? '');
    const dim = String(cvLastEmbedBody.model ?? '').includes('768') ? 768 : FAKE_DIM;
    const payload = JSON.stringify({ data: [{ embedding: fakeVec(input, dim) }] });
    return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
  };
  return orig;
}

test('card-vector config 快照：memory.embedding 缺省关闭态（DEFAULT_CONFIG 形状钉死——关 = 行为零变化的前提；W4 增 gateMode 缺省 always）', () => {
  assert.deepEqual(configMod.getConfig().memory.embedding, {
    enabled: false,
    provider: 'custom_mvgbzl9p8rb0',
    model: 'text-embedding-qwen3-embedding-0.6b',
    queryInstruction: 'Instruct: 给定一段对话记忆检索任务，检索与查询语义相关的记忆卡\nQuery: ',
    gateMode: 'always',
    fuseWeights: { lexical: 1, vector: 1, row: 1, gist: 1, fact: 1 },
    vectorFloor: 0.45,
    rowFloor: 0.45,
    lexicalFloor: 1.5,
    dateCollapse: true
  });
});

test('card-vector llm.embed：关闭态零网络直 null；provider 空 → null（B2）；provider 不存在 → null；mock 端点 → 向量且 query 前缀在应用侧拼；坏端点/HTTP500 → null 不抛', async () => {
  const counters = { calls: 0 };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { counters.calls += 1; throw new Error('关闭态零网络：fetch 不该被调'); };
  try {
    // 关闭态：直接 null，零 fetch
    assert.equal(await llmMod.embed('query', '检索词'), null, 'enabled=false → null');
    assert.equal(counters.calls, 0, '关闭态零网络');
    // B2：启用但 provider 空 → null，绝不回落主 provider
    withEmbedding({ provider: '' });
    assert.equal(await llmMod.embed('query', '检索词'), null, 'provider 空 → null（B2）');
    assert.equal(counters.calls, 0, 'B2 路径零网络');
    // provider 不存在/缺 baseURL → null
    withEmbedding({ provider: 'no_such_provider' });
    assert.equal(await llmMod.embed('document', 'x'), null, 'provider 不存在 → null');
    assert.equal(counters.calls, 0, '未知 provider 零网络');
    // mock 端点：向量返回 + query 前缀在应用侧拼 + document 原文
    withEmbedding();
    globalThis.fetch = async (url, opts = {}) => {
      counters.calls += 1;
      cvLastEmbedBody = JSON.parse(opts.body ?? '{}');
      const payload = JSON.stringify({ data: [{ embedding: fakeVec(cvLastEmbedBody.input) }] });
      return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
    };
    const qv = await llmMod.embed('query', '检索词');
    assert.ok(Array.isArray(qv) && qv.length === FAKE_DIM, `query 返回 ${FAKE_DIM} 维向量`);
    assert.ok(cvLastEmbedBody.input.startsWith('Instruct: 给定一段对话记忆检索任务'), 'query 侧拼 instruction 前缀（端点不自动加——实测报告 §1）');
    assert.ok(cvLastEmbedBody.input.endsWith('检索词'), '前缀只作用 query 侧且原文在后');
    assert.equal(cvLastEmbedBody.model, 'text-embedding-qwen3-embedding-0.6b', 'model 取自 memory.embedding.model');
    await llmMod.embed('document', '原文');
    assert.equal(cvLastEmbedBody.input, '原文', 'document 侧必须原文（无前缀，防文档向量空间漂移）');
    // 坏端点：网络错 → null 不抛；HTTP 500 → null
    globalThis.fetch = async () => { counters.calls += 1; throw new Error('ECONNREFUSED'); };
    assert.equal(await llmMod.embed('document', 'x'), null, '网络错 → null（不重试不抛）');
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    assert.equal(await llmMod.embed('document', 'x'), null, 'HTTP 500 → null');
    // 空文本也安全（prefix + '' 仍请求；响应异常形状 → null）
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '{"data":[]}' });
    assert.equal(await llmMod.embed('document', 'x'), null, '响应缺 embedding → null');
  } finally {
    globalThis.fetch = orig;
    configMod.setRuntimeConfig(cvSavedConfig);
  }
});

test('card-vector parse 清洗：gist 剥引号包装 + 截 40 字；keywords 清洗（String 化/去空/≤10）；缺失 → 空串/空数组（历史卡口径）', () => {
  const parsed = cardsSpec.parse(JSON.stringify({
    entry: '正文',
    gist: `“${'这'.repeat(50)}”`,
    keywords: ['a', '', '   ', null, 42, 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']
  }), { day: '2026-11-13' });
  assert.equal(parsed.card.gist, '这'.repeat(40), 'gist 剥整体引号 + slice(0,40)');
  assert.equal(parsed.card.keywords.length, 10, 'keywords 截 ≤10');
  assert.ok(parsed.card.keywords.every((k) => typeof k === 'string' && k.trim()), 'keywords 全为非空字符串');
  assert.ok(parsed.card.keywords.includes('42'), '数字词 String 化保留');
  const none = cardsSpec.parse(JSON.stringify({ entry: '只有正文' }), { day: '2026-11-13' });
  assert.equal(none.card.gist, '', 'gist 缺失 → 空串');
  assert.deepEqual(none.card.keywords, [], 'keywords 缺失 → 空数组');
  const badShape = cardsSpec.parse(JSON.stringify({ entry: '正文', gist: 42, keywords: '不是数组' }), { day: '2026-11-13' });
  assert.equal(badShape.card.gist, '', 'gist 非字符串 → 空串');
  assert.deepEqual(badShape.card.keywords, [], 'keywords 非数组 → 空数组');
  // 兜底卡形状钉死：extractionFallback 补 gist:''/keywords:[]（无 gist → syncCard 跳过登记）
  assert.equal(cardsSpec.fallback({ messages: [] }, '2026-11-29').gist, '', '兜底卡 gist 空串');
  assert.deepEqual(cardsSpec.fallback({ messages: [] }, '2026-11-29').keywords, [], '兜底卡 keywords 空数组');
});

test('card-vector runOnce fixture 落卡透传：normalizeCard 白名单透传 gist/keywords（计划硬伤①回归）+ 落库卡带两字段 + 关闭态索引零登记', async () => {
  const DAY = '2026-11-13';   // 复用 tools/fixtures/card-2026-11-13.json（本夜已加 gist/keywords）
  const messages = [
    { id: 5205, mid: 5205, ts: p2At(DAY, 12, 1), self: false, senderName: '阿澄', text: '过来问项目的事' },
    { id: 5212, mid: 5212, ts: p2At(DAY, 12, 3), self: true, text: '我说慢点也没关系，他说不赶' },
    { id: 5216, mid: 5216, ts: p2At(DAY, 18, 2), self: false, senderName: '阿澄', text: '在整理学习笔记，说是状态最好的时候' },
    { id: 5222, mid: 5222, ts: p2At(DAY, 21, 4), self: false, senderName: '阿澄', text: '这几天一直在陪着推进' },
    { id: 5225, mid: 5225, ts: p2At(DAY, 22, 6), self: false, senderName: '阿澄', text: '忙完这轮就带我把旧文件归档' },
    { id: 5228, mid: 5228, ts: p2At(DAY, 23, 2), self: true, text: '晚安，好梦' }
  ];
  const counters = { calls: 0 };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { counters.calls += 1; throw new Error('关闭态零网络'); };
  let result;
  try {
    result = await executorMod.runOnce('cards', {
      day: DAY, force: true,   // P2 组已在沙箱写过 11-13 卡 → force 放行重写（幂等早退会挡住本断言）
      data: { chatKey: 'web:main', day: DAY, now: p2At(DAY, 23, 32), messages, staging: [], facts: [], life: null }
    });
    await cvSettle();   // flush runOnce 内 fire-and-forget 的 syncCard（关闭态应零登记）
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(result.status, 'written', `status=${result.status}`);
  assert.equal(result.card.gist, '他陪我把事情往前推，稳一点比快一点更好——有人接住的踏实。', 'gist 经 normalizeCard 白名单透传（fixture 值原样）');
  assert.ok(result.card.gist.length <= 40, `gist ≤40 字（${result.card.gist.length}）`);
  assert.deepEqual(result.card.keywords, ['项目', '稳一点比快一点更好', '学习笔记', '旧文件归档', '晚安', '踏实'], 'keywords 经白名单透传');
  const persisted = memory.cards({ from: DAY, to: DAY });
  assert.equal(persisted.length, 1, '沙箱一天一卡');
  assert.equal(persisted[0].gist, result.card.gist, 'gist 随卡持久化');
  assert.deepEqual(persisted[0].keywords, result.card.keywords, 'keywords 随卡持久化');
  assert.equal(counters.calls, 0, '关闭态（enabled=false）整条写入链路零网络');
  assert.equal(cardIndex.stats().gists, 0, '关闭态索引零登记（滞后待 --backfill 补齐）');
  assert.equal(cardIndex.stats().facts, 0, '关闭态事实向量零登记');
  assert.equal(cardIndex.stats().rows, 0, '关闭态行级向量零登记（第二批 T1）');
});

test('card-vector 兜底卡路径：fallback 卡 gist=\'\'/keywords=[] 落库；syncCard 对无 gist 卡显式跳过登记', async () => {
  const DAY = '2026-11-29';   // 无 fixture 文件 → 解析失败 → 抽取式兜底卡
  const messages = [
    { id: 9001, mid: 9001, ts: p2At(DAY, 10, 0), self: false, senderName: '阿澄', text: '今天随便聊聊，说到了豆沙包和底线测试' },
    { id: 9002, mid: 9002, ts: p2At(DAY, 10, 2), self: true, text: '嗯，都记下来了' }
  ];
  const result = await executorMod.runOnce('cards', {
    day: DAY,
    data: { chatKey: 'web:main', day: DAY, now: p2At(DAY, 10, 5), messages, staging: [], facts: [], life: null }
  });
  await cvSettle();
  assert.equal(result.status, 'fallback', `status=${result.status}`);
  assert.equal(result.card.gist, '', '兜底卡 gist 空串（不编造）');
  assert.deepEqual(result.card.keywords, [], '兜底卡 keywords 空数组');
  const persisted = memory.cards({ from: DAY, to: DAY });
  assert.equal(persisted.length, 1, '兜底卡照常落库');
  assert.equal(persisted[0].source, 'fallback', 'source=fallback');
  // 显式断言 syncCard 的无 gist 跳过（计划 §3.3：旧格式卡/兜底卡跳过登记）
  withEmbedding();
  const counters = { calls: 0 };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { counters.calls += 1; throw new Error('无 gist 不该发嵌入'); };
  try {
    const r = await cardIndex.syncCard(persisted[0]);
    assert.equal(r.skipped, 'no-gist', '无 gist → 跳过登记');
    assert.equal(counters.calls, 0, '无 gist 零嵌入调用');
    assert.equal(cardIndex.stats().gists, 0, '兜底卡不进索引');
  } finally {
    globalThis.fetch = orig;
    configMod.setRuntimeConfig(cvSavedConfig);
  }
});

test('card-index syncCard：建行（hash/embed_model/dim 落全）→ 重复同步 hash 未变零 fetch 跳过（幂等不烧嵌入）', async () => {
  withEmbedding();
  fs.rmSync(INDEX_FILE, { force: true });   // 沙箱派生物：清空重来，计数从零确定
  const counters = { calls: 0 };
  const orig = installFakeEmbedFetch(counters);
  try {
    const card = { date: '2026-11-20', gist: '测试卡：星空散步', keywords: ['星空', '散步'], mood: '放松' };
    const r1 = await cardIndex.syncCard(card);
    assert.equal(r1.ok, true, '首次同步建行');
    const callsFirst = counters.calls;
    assert.ok(callsFirst >= 1, '首次同步发嵌入');
    const row = readIndexState().gists['2026-11-20'];
    assert.equal(row.gist, card.gist, '行带 gist');
    assert.equal(row.content_hash, crypto.createHash('sha1').update('测试卡：星空散步\n关键词：星空 散步\n放松', 'utf8').digest('hex'), 'content_hash=sha1(嵌入输入=gist+关键词+mood)');
    assert.equal(row.embed_model, 'text-embedding-qwen3-embedding-0.6b', '行带 embed_model');
    assert.equal(row.dim, FAKE_DIM, '行带 dim');
    const r2 = await cardIndex.syncCard({ ...card });
    assert.equal(r2.skipped, 'hash', 'hash 未变 → 跳过');
    assert.equal(counters.calls, callsFirst, 'hash 未变零 fetch（幂等零嵌入成本）');
    assert.equal(cardIndex.stats().gists, 1, '仍一行（只更新元数据不重复建行）');
  } finally {
    globalThis.fetch = orig;
    configMod.setRuntimeConfig(cvSavedConfig);
  }
});

test('card-index 模型或维度变更 → 自动清表（index_meta 机制）：旧卡行被清、新行按新模型重建', async () => {
  withEmbedding();
  fs.rmSync(INDEX_FILE, { force: true });
  const counters = { calls: 0 };
  const orig = installFakeEmbedFetch(counters);
  try {
    await cardIndex.syncCard({ date: '2026-11-21', gist: '旧模型卡', keywords: [], mood: '' });
    assert.equal(cardIndex.stats().gists, 1, '旧模型下建行');
    // 换模型（假端点对 '768' 模型名返回 768 维 → 模型与维度同时变）
    withEmbedding({ model: 'fake-embed-768' });
    const r = await cardIndex.syncCard({ date: '2026-11-22', gist: '新模型卡', keywords: [], mood: '' });
    assert.equal(r.ok, true);
    const st = cardIndex.stats();
    assert.equal(st.gists, 1, '模型/维度变更 → 清表后只剩新行');
    assert.equal(st.meta.embed_model, 'fake-embed-768', 'meta 登记新模型');
    assert.equal(st.meta.dim, 768, 'meta 登记新维度');
    const state = readIndexState();
    assert.ok(!state.gists['2026-11-21'], '旧模型行已清');
    assert.equal(state.gists['2026-11-22'].dim, 768, '新行按新维度落');
  } finally {
    globalThis.fetch = orig;
    configMod.setRuntimeConfig(cvSavedConfig);
  }
});

test('card-index syncFact：upsert 建行 + 对账修剪（supersede 后孤儿向量行被删）+ superseded 的 key 不建向量', async () => {
  withEmbedding();
  fs.rmSync(INDEX_FILE, { force: true });
  const counters = { calls: 0 };
  const orig = installFakeEmbedFetch(counters);
  try {
    const fa = memory.upsertFact({ kind: 'like', subject: 'other', content: '他喜欢星空', mid: 1 });
    const fb = memory.upsertFact({ kind: 'routine', subject: 'other', content: '他周末睡到中午', mid: 2 });
    await cardIndex.syncFact(fa);
    await cardIndex.syncFact(fb);
    assert.equal(cardIndex.stats().facts, 2, '两条 active 事实各一行');
    assert.equal(readIndexState().facts[fa.key].text, '他喜欢星空', '行带原文');
    // 白盒顶替 fa（supersede 发生在 memory.upsertFact 内部——唯一写者签名不动，索引自愈）。
    // 文件时代=改写 facts.jsonl 行；V3 等价=同语义 DB UPDATE（supersededBy 指针格式同款）。
    dbmod.getDb().prepare("UPDATE facts SET status = 'superseded', supersededBy = ? WHERE key = ?")
      .run(`${fa.key}@0`, fa.key);
    const r = await cardIndex.syncFact(fb);   // 任意一次 syncFact 触发对账
    assert.equal(r.ok, true);
    assert.ok(r.pruned >= 1, `对账修剪删孤儿行（pruned=${r.pruned}）`);
    const st = cardIndex.stats();
    assert.equal(st.facts, 1, '被顶替事实的向量行已删');
    assert.ok(!readIndexState().facts[fa.key], '孤儿行（fa）不在索引');
    assert.ok(readIndexState().facts[fb.key], 'active 行（fb）保留');
    // superseded 的 key 不再建向量
    const r2 = await cardIndex.syncFact({ key: fa.key, content: fa.content });
    assert.equal(r2.skipped, 'not-active', 'superseded key 不建向量');
    assert.equal(cardIndex.stats().facts, 1, '索引不被 superseded 条目复活');
  } finally {
    globalThis.fetch = orig;
    configMod.setRuntimeConfig(cvSavedConfig);
  }
});

test('card-index rebuildFromApi 幂等：两次全量重建 keys/content_hash/向量全等；无 gist 卡跳过；superseded 事实不建向量', async () => {
  withEmbedding();
  fs.rmSync(INDEX_FILE, { force: true });
  const counters = { calls: 0 };
  const orig = installFakeEmbedFetch(counters);
  try {
    memory.writeCard({ date: '2026-11-23', salience: 1, gist: '重建卡：整理旧档', keywords: ['归档'], mood: '平静' });
    memory.writeCard({ date: '2026-11-24', salience: 1, events: ['无 gist 的卡（旧格式模拟）'] });
    const r1 = await cardIndex.rebuildFromApi();
    assert.equal(r1.gists, 2, '有 gist 卡登记（11-13 fixture 卡 + 11-23；无 gist 的 11-24/11-29 跳过）');
    assert.ok(r1.facts >= 1, 'active 事实入索引');
    const s1 = readIndexState();
    assert.deepEqual(Object.keys(s1.gists).sort(), ['2026-11-13', '2026-11-23'], 'gist 行 = 有 gist 卡集合');
    const r2 = await cardIndex.rebuildFromApi();
    const s2 = readIndexState();
    assert.deepEqual(Object.keys(s2.gists), Object.keys(s1.gists), '两次重建 gist keys 全等');
    assert.deepEqual(Object.keys(s2.facts), Object.keys(s1.facts), '两次重建 fact keys 全等');
    assert.deepEqual(
      Object.fromEntries(Object.entries(s2.gists).map(([k, v]) => [k, v.content_hash])),
      Object.fromEntries(Object.entries(s1.gists).map(([k, v]) => [k, v.content_hash]))
      , 'gist content_hash 全等（幂等）');
    assert.deepEqual(s2.gists['2026-11-23'].embedding, s1.gists['2026-11-23'].embedding, '确定性嵌入 → 向量本体全等');
    assert.deepEqual(
      Object.fromEntries(Object.entries(s2.facts).map(([k, v]) => [k, v.content_hash])),
      Object.fromEntries(Object.entries(s1.facts).map(([k, v]) => [k, v.content_hash]))
      , 'fact content_hash 全等（幂等）');
    const activeKeys = new Set(memory.facts({ status: 'active' }).map((f) => f.key));
    assert.ok(Object.keys(s2.facts).every((k) => activeKeys.has(k)), '向量行 key ⊆ active 事实 key（对账后无孤儿）');
  } finally {
    globalThis.fetch = orig;
    configMod.setRuntimeConfig(cvSavedConfig);
  }
});

test('card-index search：暴力点积降序（同输入=1.0 恒为 top）+ 维度不符防御', async () => {
  withEmbedding();
  fs.rmSync(INDEX_FILE, { force: true });
  const counters = { calls: 0 };
  const orig = installFakeEmbedFetch(counters);
  try {
    await cardIndex.syncCard({ date: '2026-11-25', gist: '甲卡：星空散步', keywords: ['星空'], mood: '放松' });
    await cardIndex.syncCard({ date: '2026-11-26', gist: '乙卡：豆沙包早餐', keywords: ['豆沙包'], mood: '满足' });
    const fA = memory.upsertFact({ kind: 'like', subject: 'other', content: '他收藏旧邮票', mid: 3 });
    await cardIndex.syncFact(fA);
    // 卡甲的嵌入输入（cardEmbedInput 口径：gist + '\n关键词：' + join + '\n' + mood）
    const resA = cardIndex.search(fakeVec('甲卡：星空散步\n关键词：星空\n放松'));
    assert.equal(resA.gists[0]?.date, '2026-11-25', '同输入向量点积=1.0 → 甲卡 top');
    assert.ok(resA.gists[0]?.score > 0.999, `score≈1.0（${resA.gists[0]?.score}）`);
    assert.equal(resA.gists.length, 2, 'gist 路 2 行全出（降序）');
    const resF = cardIndex.search(fakeVec('他收藏旧邮票'));
    assert.equal(resF.facts[0]?.key, fA.key, 'fact 路 top=命中的事实');
    assert.ok(resF.facts[0]?.score > 0.999, 'fact score≈1.0');
    assert.deepEqual(cardIndex.search([1, 2, 3]).gists, [], '维度不符 → 空（防御）');
    assert.deepEqual(cardIndex.search([]).facts, [], '空查询 → 空');
  } finally {
    globalThis.fetch = orig;
    configMod.setRuntimeConfig(cvSavedConfig);
  }
});

test('card-index prefetchQuery/peekQuery：query 侧缓存写入 + 未热 null + 单飞替换（新文本胜出）+ 关闭态 null', async () => {
  withEmbedding();
  const counters = { calls: 0 };
  const orig = installFakeEmbedFetch(counters);
  try {
    const v1 = await cardIndex.prefetchQuery('cv-ck1', '上周我们聊了什么');
    assert.ok(Array.isArray(v1) && v1.length === FAKE_DIM, 'query 嵌入成功');
    const hit = cardIndex.peekQuery('cv-ck1');
    assert.equal(hit?.text, '上周我们聊了什么', '缓存按 chatKey 记 text');
    assert.deepEqual(hit?.vec, v1, '缓存向量与返回一致');
    assert.equal(cardIndex.peekQuery('cv-ck-none'), null, '未热 chatKey → null');
    // 单飞语义（last-write-wins）：新文本原子替换旧缓存
    await cardIndex.prefetchQuery('cv-ck1', '豆沙包是哪天');
    assert.equal(cardIndex.peekQuery('cv-ck1').text, '豆沙包是哪天', '同 chatKey 新文本替换旧缓存');
    // 关闭态：null 且缓存不动
    configMod.setRuntimeConfig(cvSavedConfig);
    assert.equal(await cardIndex.prefetchQuery('cv-ck2', 'x'), null, '关闭态 → null');
    assert.equal(cardIndex.peekQuery('cv-ck2'), null, '关闭态不写缓存');
    assert.ok(cardIndex.peekQuery('cv-ck1'), '关闭态不清既有缓存（预取与开关解耦——夜2 读侧语义）');
  } finally {
    globalThis.fetch = orig;
    configMod.setRuntimeConfig(cvSavedConfig);
  }
});

// ══════════ card-vector 夜2 检索链路（T2.5：快照对照 / 三源 RRF 表驱动 / 日期聚合 / recallHits 记账）══════════
// 对照基线 = tools/fixtures/recall-lexical-snapshot.json（T2.0 在改造 recall.js **之前**固化的
// "扩展前词法行为"；对照方法 = 计划 §10-3：改造前固化快照，改造后逐字节对照）。
group('card-vector 夜2 检索链路（快照对照/三源RRF/日期聚合/记账）');

const SNAP_FIXTURE = JSON.parse(fs.readFileSync(path.join(TOOL_DIR, 'fixtures', 'recall-lexical-snapshot.json'), 'utf8'));
const SNAP_CARDS = SNAP_FIXTURE.cards;
// 旧语料 = 剥掉 entry/promises（T2.1 语料扩展的两字段）——剥离后语料与改造前完全同构
const STRIPPED_CARDS = SNAP_CARDS.map(({ entry, promises, ...rest }) => rest);
const snapCanon = (o) => JSON.stringify(o);
// entry/promises 行的可展示形态（"MM-DD " + 行文[:60]，与 retrieveFromCards 输出口径一致）
const EP_DISPLAY_TEXTS = new Set();
for (const card of SNAP_CARDS) {
  if (String(card.entry ?? '').trim()) EP_DISPLAY_TEXTS.add(`${card.date.slice(5)} ${String(card.entry).trim()}`.slice(0, 60));
  for (const pr of (Array.isArray(card.promises) ? card.promises : [])) {
    if (String(pr?.text ?? '').trim()) EP_DISPLAY_TEXTS.add(`${card.date.slice(5)} ${String(pr.text).trim()}`.slice(0, 60));
  }
}
const snapArgs = (c) => ({ text: c.text, lastMessageTs: c.lastMessageTs, now: c.now, names: c.names });

test('夜2① 关闭态对照（§10-3 最易翻车断言）：旧语料（剥 entry/promises）下全部快照用例 gate/hits/lines/deep 逐字节一致（关闭态=旧语料=旧字节）', () => {
  assert.ok(SNAP_FIXTURE.cases.length >= 27, `快照用例数钉死（实际 ${SNAP_FIXTURE.cases.length}）`);
  for (const c of SNAP_FIXTURE.cases) {
    // minScore:0 = 历史快照口径（P11 下限是本轮新增行为，另有专测；这里只比“下限关闭”的旧字节）
    const r = recallForPrompt({ ...snapArgs(c), cards: STRIPPED_CARDS, minScore: 0 });
    assert.equal(snapCanon({ gate: r.gate, hits: r.hits, lines: r.lines }),
      snapCanon({ gate: c.gate, hits: c.hits, lines: c.lines }), `用例 ${c.id} 顶层输出与快照不一致`);
    const deep = retrieveFromCards(c.text, STRIPPED_CARDS, { limit: SNAP_FIXTURE.deepLimit, maxChars: 60, minScore: 0 });
    assert.equal(snapCanon(deep), snapCanon(c.deep), `用例 ${c.id} 深排名与快照不一致`);
  }
});

test('夜2① 差异仅限语料扩展：全语料相对快照 = 新增行全部源自 entry/promises、被挤出的旧行全部仍在深排名内、未变行分数不变、闸门不变', () => {
  for (const c of SNAP_FIXTURE.cases) {
    const r = recallForPrompt({ ...snapArgs(c), cards: SNAP_CARDS, minScore: 0 });
    assert.deepEqual(r.gate, c.gate, `用例 ${c.id} 闸门必须与快照一致（闸门一字未动）`);
    const oldTexts = c.hits.map((h) => h.text);
    const newTexts = r.hits.map((h) => h.text);
    for (const t of newTexts) {
      if (oldTexts.includes(t)) {
        assert.equal(r.hits.find((h) => h.text === t).score,
          c.hits.find((h) => h.text === t).score, `用例 ${c.id} 未变行分数漂移：${t}`);
      } else {
        assert.ok(EP_DISPLAY_TEXTS.has(t), `用例 ${c.id} 新增行不是 entry/promises 行（扩展外差异）：${t}`);
      }
    }
    const removed = oldTexts.filter((t) => !newTexts.includes(t));
    if (removed.length) {
      const deepTexts = retrieveFromCards(c.text, SNAP_CARDS, { limit: SNAP_FIXTURE.deepLimit, maxChars: 60, minScore: 0 }).map((h) => h.text);
      for (const t of removed) {
        assert.ok(deepTexts.includes(t), `用例 ${c.id} 被挤出的旧行不在深排名内（疑似丢失）：${t}`);
      }
    }
  }
});

// ── 三源 RRF 表驱动（假向量注入，零网络零模型调用；名次手工可算）───────────────
// 语料：两卡各一事件行、token 互不重叠 → query '咖啡' 只有 2027-01-01 命中（词法 rank1）。
const RRF_CARDS = [
  { date: '2027-01-01', salience: 1, events: ['咖啡豆到货了'], facts: [], open_loops: [], mood: '' },
  { date: '2027-01-02', salience: 1, events: ['茶具洗好了'], facts: [], open_loops: [], mood: '' }
];
const RRF_ARGS = { text: '咖啡', lastMessageTs: NOW - TWO_H - 1, now: NOW };
const RRF_EPS = 1e-12;
const near = (a, b) => Math.abs(a - b) < RRF_EPS;

test('夜2② 三源RRF 表驱动：行级候选直出 + 同日坍缩标 both（词法行与 gist 行同卡双源 → 保留行记 both，分数不合并）+ gist-only 概括行（- MM-DD {gist}）', () => {
  const vh = [
    { kind: 'gist', date: '2027-01-02', text: '乙卡：茶具与午后', score: 0.9 },
    { kind: 'gist', date: '2027-01-01', text: '甲卡：咖啡豆', score: 0.95 }
  ];
  const r = recallForPrompt({ ...RRF_ARGS, cards: RRF_CARDS, vectorHits: vh });
  assert.equal(r.hits.length, 2, '≤2 条');
  assert.equal(r.hits[0].text, '01-01 咖啡豆到货了', '01-01 词法行 rank1 与 gist rank1 同卡 → 保留词法行（行级直出）');
  assert.ok(near(r.hits[0].score, 1 / 61), `保留行分数 = 自身词法项 1/61（不合并，实际 ${r.hits[0].score}）`);
  assert.equal(r.hits[1].text, '01-02 乙卡：茶具与午后', 'gist-only 展示概括行（带 MM-DD 前缀）');
  assert.ok(near(r.hits[1].score, 1 / 62), `gist rank2 → 1/62（实际 ${r.hits[1].score}）`);
  assert.deepEqual(r.recallHits.hits.map((h) => h.source), ['both', 'gist'], 'source 标签：both（同卡双源）/ gist');
  assert.ok(r.lines.every((l, i) => l === `- ${r.hits[i].text}`), 'lines 即渲染行');
});

test('夜2② 三源RRF 表驱动：fact 行独立成项 + k=60 名次数学钉死（rank1/2/3 → 1/61、1/62、1/63）+ 词法/向量并列时词法先现', () => {
  const vh = [
    { kind: 'fact', key: 'f1', text: '事实一', score: 0.8 },
    { kind: 'fact', key: 'f2', text: '事实二', score: 0.7 },
    { kind: 'fact', key: 'f3', text: '事实三', score: 0.6 }
  ];
  const r = recallForPrompt({ ...RRF_ARGS, cards: RRF_CARDS, vectorHits: vh, limit: 4 });
  assert.deepEqual(r.hits.map((h) => h.text), ['01-01 咖啡豆到货了', '事实一', '事实二', '事实三'], '词法行与 fact1 并列 1/61 时词法先现（稳定序）');
  assert.ok(near(r.hits[0].score, 1 / 61) && near(r.hits[1].score, 1 / 61) && near(r.hits[2].score, 1 / 62) && near(r.hits[3].score, 1 / 63),
    `k=60 名次数学：${r.hits.map((h) => h.score).join(',')}`);
  assert.deepEqual(r.recallHits.hits.map((h) => h.source), ['lexical', 'fact', 'fact', 'fact'], 'source 标签：lexical / fact×3');
});

test('夜2② 权重可调：fuseWeights lexical=2 → 词法行 2/61（both 保留行=自身项）；vector=2 → gist 行 2/62；测后还原', () => {
  configMod.setRuntimeConfig({
    ...cvSavedConfig,
    memory: { ...cvSavedConfig.memory, embedding: { ...cvSavedConfig.memory.embedding, fuseWeights: { lexical: 2, vector: 1 } } }
  });
  try {
    const r = recallForPrompt({ ...RRF_ARGS, cards: RRF_CARDS, vectorHits: [{ kind: 'gist', date: '2027-01-01', text: '甲卡gist', score: 0.95 }] });
    assert.ok(near(r.hits[0].score, 2 / 61), `lexical 权重 2：${r.hits[0].score} ≈ 2/61（保留行=自身词法项×2）`);
    assert.equal(r.recallHits.hits[0].source, 'both');
  } finally {
    configMod.setRuntimeConfig({
      ...cvSavedConfig,
      memory: { ...cvSavedConfig.memory, embedding: { ...cvSavedConfig.memory.embedding, fuseWeights: { lexical: 1, vector: 2 } } }
    });
  }
  try {
    const r2 = recallForPrompt({ ...RRF_ARGS, cards: RRF_CARDS, vectorHits: [{ kind: 'gist', date: '2027-01-02', text: '乙卡gist', score: 0.9 }] });
    const gistRow = r2.recallHits.hits.find((h) => h.source === 'gist');
    assert.ok(gistRow, 'vector 权重 2：gist-only 行在展示序中');
    assert.ok(near(gistRow.score, 2 / 61), `vector 权重 2：gist 行分数 ${gistRow.score} ≈ 2/(60+1)（rank1×权重2）`);
  } finally {
    configMod.setRuntimeConfig(cvSavedConfig);
  }
});

test('夜2② 纯词法回退：vectorHits 缺省 ≡ 空数组（逐字节一致）；vectorHits 在场但闸门未命中 → 零产出；坏形状 vectorHits 全被丢弃', () => {
  const noV = recallForPrompt({ ...RRF_ARGS, cards: RRF_CARDS });
  const emptyV = recallForPrompt({ ...RRF_ARGS, cards: RRF_CARDS, vectorHits: [] });
  assert.equal(snapCanon(noV.hits), snapCanon(emptyV.hits), '缺省 ≡ 空数组（hits）');
  assert.equal(snapCanon(noV.recallHits), snapCanon(emptyV.recallHits), '缺省 ≡ 空数组（recallHits）');
  // W4 起：gateMode 缺省 'always' → vectorHits 在场且预取命中时跳闸门（命中即注入）——
  // 旧断言"零产出"迁移到 strict 档（见下）。always 档：闸门未命中但 gist 命中注入，
  // gate 记账如实保持 hit=false，bypassed=true 标注注入来源。
  const gated = recallForPrompt({ text: '今天天气不错', lastMessageTs: NOW, now: NOW, cards: RRF_CARDS, vectorHits: [{ kind: 'gist', date: '2027-01-01', text: 'x', score: 1 }] });
  assert.equal(gated.gate.hit, false, '闸门未命中（记账如实）');
  assert.deepEqual(gated.hits.map((h) => h.text), ['01-01 x'], 'always 档：vectorHits 命中即注入（不过三闸门）');
  assert.equal(gated.recallHits.bypassed, true, 'bypassed 记账=true（闸门未命中但策略放行）');
  // strict 档 = 旧三闸门回归锁（W4 前行为逐字节一致：vectorHits 不越闸）
  configMod.setRuntimeConfig({
    ...cvSavedConfig,
    memory: { ...cvSavedConfig.memory, embedding: { ...cvSavedConfig.memory.embedding, gateMode: 'strict' } }
  });
  try {
    const gatedStrict = recallForPrompt({ text: '今天天气不错', lastMessageTs: NOW, now: NOW, cards: RRF_CARDS, vectorHits: [{ kind: 'gist', date: '2027-01-01', text: 'x', score: 1 }] });
    assert.equal(gatedStrict.gate.hit, false, 'strict：闸门未命中');
    assert.deepEqual(gatedStrict.hits, [], 'strict：闸门未命中 → 零产出（vectorHits 不越闸，旧行为回归锁）');
    assert.deepEqual(gatedStrict.recallHits.hits, [], 'strict：记账同步为空');
    assert.equal(gatedStrict.recallHits.bypassed, false, 'strict：bypassed=false');
  } finally {
    configMod.setRuntimeConfig(cvSavedConfig);
  }
  const bad = recallForPrompt({
    ...RRF_ARGS, cards: RRF_CARDS,
    vectorHits: [
      { kind: 'weird', date: '2027-01-01', text: 'x', score: 9 },
      { kind: 'gist', date: '9999-99-99', text: '坏日期', score: 9 },
      { kind: 'gist', date: '2027-01-02', text: '', score: 9 },
      { kind: 'gist', date: '2027-01-02', text: '低于 vectorFloor 的 gist', score: 0.3 },
      { kind: 'fact', key: 'f-low', text: '低于 vectorFloor 的 fact', score: 0.44 },
      { kind: 'fact', key: '', text: '坏key', score: 9 },
      { kind: 'fact', key: 'f9', text: '   ', score: 9 }
    ]
  });
  assert.deepEqual(bad.hits.map((h) => h.text), ['01-01 咖啡豆到货了'], '坏形状 + 低于 vectorFloor(0.45) 的向量行全丢弃 → 纯词法产出');
  assert.deepEqual(bad.recallHits.hits.map((h) => h.source), ['lexical']);
});

test('夜2② vectorFloor 边界：score 恰为 0.45 的向量行入选、0.4499 不入选', () => {
  const at = recallForPrompt({ ...RRF_ARGS, cards: RRF_CARDS, vectorHits: [{ kind: 'gist', date: '2027-01-02', text: 'floor 边界 gist', score: 0.45 }] });
  assert.ok(at.hits.some((h) => h.text.includes('floor 边界 gist')), '≥ floor 入选');
  const below = recallForPrompt({ ...RRF_ARGS, cards: RRF_CARDS, vectorHits: [{ kind: 'gist', date: '2027-01-02', text: 'floor 边界 gist', score: 0.4499 }] });
  assert.deepEqual(below.hits.map((h) => h.text), ['01-01 咖啡豆到货了'], '< floor 不入选');
});

// ── W4 注入策略（night-plan-polish §2-W4 · 命中即注入 + 仅参考标注 + gateMode）─────
test('W4 gateMode 判定：缺省 → always（新策略）；非法值 → always（显式 strict 才回退）；标注文案单一事实源钉死', () => {
  assert.equal(recallMod.embeddingGateMode(), 'always', '缺省（DEFAULT_CONFIG）→ always');
  configMod.setRuntimeConfig({ ...cvSavedConfig, memory: { ...cvSavedConfig.memory, embedding: { ...cvSavedConfig.memory.embedding, gateMode: 'bogus' } } });
  try {
    assert.equal(recallMod.embeddingGateMode(), 'always', '非法值 → always（fail-closed 到新策略）');
  } finally {
    configMod.setRuntimeConfig(cvSavedConfig);
  }
  configMod.setRuntimeConfig({ ...cvSavedConfig, memory: { ...cvSavedConfig.memory, embedding: { ...cvSavedConfig.memory.embedding, gateMode: 'strict' } } });
  try {
    assert.equal(recallMod.embeddingGateMode(), 'strict', '显式 strict → strict（旧三闸门可回退）');
  } finally {
    configMod.setRuntimeConfig(cvSavedConfig);
  }
  assert.equal(recallMod.RECALL_NOTE_LINE, '不必刻意提及，相关可提', '标注文案钉死（prompt.js renderRecallSection 引用同一常量，勿复制第二份）');
});

test('W4 always 档零注入面：vectorHits 空（关闭态/预取未热/无命中）→ 闸门照旧零注入；闸门命中 + 向量在场 → 正常融合且 bypassed=false', () => {
  // "无命中不注入"：vectorHits 空 + 闸门未命中 → 零注入（不凭空造内容）
  const none = recallForPrompt({ text: '今天天气不错', lastMessageTs: NOW, now: NOW, cards: RRF_CARDS, vectorHits: [] });
  assert.deepEqual(none.hits, [], '无命中（vectorHits 空）→ 零注入');
  assert.equal(none.recallHits.bypassed, false, '零注入时 bypassed=false');
  // 关闭态同口径：vectorHits 缺省 undefined → 闸门照旧（词法兜底不变式）
  const closed = recallForPrompt({ text: '今天天气不错', lastMessageTs: NOW, now: NOW, cards: RRF_CARDS });
  assert.deepEqual(closed.hits, [], '关闭态（vectorHits 缺省）→ 零注入');
  // 闸门命中（冷启动）+ 向量在场 → 融合注入；闸门本身放行，bypassed=false
  const both = recallForPrompt({ ...RRF_ARGS, cards: RRF_CARDS, vectorHits: [{ kind: 'gist', date: '2027-01-01', text: '甲卡gist', score: 0.95 }] });
  assert.equal(both.gate.hit, true, '冷启动闸门命中');
  assert.ok(both.hits.length >= 1, '融合注入');
  assert.equal(both.recallHits.bypassed, false, '闸门放行时 bypassed=false');
});

test('W4 标注行：renderRecallSection 块头带「仅供参考」标注（紧跟标题行独立成行），空 hits 整段不出现（标注不单独成块）', () => {
  const sec = promptMod.renderRecallSection([{ text: '11-03 海边看日出' }]);
  assert.ok(sec.startsWith('【近期回忆】'), '段头不变');
  assert.ok(sec.includes(recallMod.RECALL_NOTE_LINE), '块头带标注行');
  const [title, note, first] = sec.split('\n');
  assert.equal(note, recallMod.RECALL_NOTE_LINE, '标注行紧跟标题行（独立一行）');
  assert.equal(first, '- 11-03 海边看日出', '条目行在标注行之后');
  assert.equal(promptMod.renderRecallSection([]), '', '空 hits 整段不出现');
});

// ── 日期聚合（输出层组行：同日相邻成组、组按最高分排序、组行后取 ≤2）─────────────
const AGG_CARDS = [
  { date: '2027-02-01', salience: 1, events: ['海边的日落真美', '海边的风有点大'], facts: [], open_loops: [], mood: '' },
  { date: '2027-02-02', salience: 1, events: ['山顶的星空更亮'], facts: [], open_loops: [], mood: '' }
];
const AGG_VH = [{ kind: 'gist', date: '2027-02-02', text: '山顶放空的下午', score: 0.9 }];

test('夜2③ 日期聚合（同日只留一行）：同卡第二行被同日坍缩（不占第二席、异日 gist 正常入选）；同卡词法行+gist 双源 → 保留行标 both', () => {
  // 双行卡：'海边' 命中 02-01 两行（词法 rank1/rank2）；02-02 gist rank1（1/61 与 rank1 并列）。
  // 坍缩：02-01 只留 rank1 行（第二行不进展示序）→ [02-01 日落, 02-02 gist]
  const r2 = recallForPrompt({ text: '海边', lastMessageTs: NOW - TWO_H - 1, now: NOW, cards: AGG_CARDS, vectorHits: AGG_VH });
  assert.deepEqual(r2.hits.map((h) => h.text), ['02-01 海边的日落真美', '02-02 山顶放空的下午'], '同日只留一行（第二行坍缩，异日 gist 入选）');
  assert.deepEqual(r2.recallHits.hits.map((h) => h.source), ['lexical', 'gist']);
  const r3 = recallForPrompt({ text: '海边', lastMessageTs: NOW - TWO_H - 1, now: NOW, cards: AGG_CARDS, vectorHits: AGG_VH, limit: 3 });
  assert.equal(r3.hits.length, 2, 'limit=3 仍只有 2 行：同日第二行是被坍缩丢弃而非仅排序靠后');
  // 同卡双源：02-01 加一条 gist → 词法行保留 + 标 both；02-02 gist 单源 → gist
  const rBoth = recallForPrompt({
    text: '海边', lastMessageTs: NOW - TWO_H - 1, now: NOW, cards: AGG_CARDS,
    vectorHits: [{ kind: 'gist', date: '2027-02-01', text: '海边的下午', score: 0.9 }, { kind: 'gist', date: '2027-02-02', text: '山顶放空的下午', score: 0.8 }]
  });
  assert.deepEqual(rBoth.hits.map((h) => h.text), ['02-01 海边的日落真美', '02-02 山顶放空的下午'], '同卡双源保留词法行（行级直出）');
  assert.deepEqual(rBoth.recallHits.hits.map((h) => h.source), ['both', 'gist'], 'both 标记 = 同日词法+gist 双源在场');
});

test('夜2③ ≤2 条 ≤60 字口径（融合路同样成立：超长 gist/fact 行展示端截断）+ renderRecallSection 渲染融合行（W4 起带标注行）', () => {
  const longGist = '超'.repeat(80);
  const longFact = '长'.repeat(80);
  // 语料与 query 无词法重叠 → 候选只有 gist/fact 两项（都进 top-2，截断口径可单独钉死）
  const r = recallForPrompt({
    text: '咖啡', lastMessageTs: NOW - TWO_H - 1, now: NOW, cards: AGG_CARDS,
    vectorHits: [{ kind: 'gist', date: '2027-02-01', text: longGist, score: 0.9 }, { kind: 'fact', key: 'f1', text: longFact, score: 0.8 }]
  });
  assert.equal(r.hits.length, 2, '融合路 ≤2 条');
  for (const h of r.hits) assert.ok(h.text.length <= 60, `每条 ≤60 字（实际 ${h.text.length}）`);
  assert.ok(r.hits.some((h) => h.text.startsWith('02-01 ') && h.text.length === 60), 'gist 行带 MM-DD 前缀并截到 60');
  assert.ok(r.hits.some((h) => h.text === longFact.slice(0, 60)), 'fact 行截到 60（无日期前缀）');
  const sec = promptMod.renderRecallSection(r.hits);
  assert.ok(sec.startsWith('【近期回忆】'), 'renderRecallSection 正常渲染融合行');
  assert.ok(sec.includes(recallMod.RECALL_NOTE_LINE), 'W4：块头带「仅供参考」标注行');
  assert.equal(sec.split('\n').length - 1, 3, '标题+标注+两行 = 3 个换行');
});

test('夜2④ recallHits 四值记账：lexical/gist/fact/both 全值可达 + gate 落账（M1 承诺）', () => {
  const seen = new Set();
  const r1 = recallForPrompt({ ...RRF_ARGS, cards: RRF_CARDS });                       // 纯词法 → lexical
  seen.add(r1.recallHits.hits[0]?.source);
  const r2 = recallForPrompt({ ...RRF_ARGS, cards: RRF_CARDS, limit: 4, vectorHits: [{ kind: 'fact', key: 'f1', text: '事实一', score: 0.8 }, { kind: 'fact', key: 'f2', text: '事实二', score: 0.7 }] });
  for (const h of r2.recallHits.hits) seen.add(h.source);                              // lexical + fact
  const r3 = recallForPrompt({ ...RRF_ARGS, cards: RRF_CARDS, vectorHits: [{ kind: 'gist', date: '2027-01-02', text: '乙卡gist', score: 0.9 }] });
  for (const h of r3.recallHits.hits) seen.add(h.source);                              // lexical + gist
  const r4 = recallForPrompt({ ...RRF_ARGS, cards: RRF_CARDS, vectorHits: [{ kind: 'gist', date: '2027-01-01', text: '甲卡gist', score: 0.95 }] });
  for (const h of r4.recallHits.hits) seen.add(h.source);                              // both
  assert.deepEqual([...seen].sort(), ['both', 'fact', 'gist', 'lexical'], `四值全可达（实际 ${[...seen].join(',')}）`);
  assert.equal(r1.recallHits.gate.hit, true, 'gate 落账');
  assert.deepEqual(r1.recallHits.gate, r1.gate, 'recallHits.gate 与顶层 gate 同源');
});

test('夜2 T2.2/T2.4 接线：ctx.vectorHits → buildUserPrompt 渲染向量行 + session.recallHits 落账；fact 可见性过滤（pet 面不见 private 事实/private 卡 gist）', () => {
  // 断言口径：只看【近期回忆】段（【记忆】段/未读信息里出现同词属正常渲染面，不属召回职责）。
  // 语料 token '水族馆' 为本卡独占；触发文本不含它（未读信息不干扰断言）。
  // V3 自洁化（对照表登记）：文件时代本断言隐式依赖「旧格式卡 fixture 整文件覆盖」
  // 副作用（它顺手删掉了此前各组的卡）——DB 后端不再破坏数据，历史 ambient 卡存活
  // 会多出 lexical 记账。改为组内显式双表清零，让断言只见本用例语料（孤立探针实证
  // 期望值与原断言一致：web=['both','fact'] pet=['fact']）。
  resetCards();
  resetFacts();
  memory.writeCard({ date: '2026-12-01', salience: 2, events: ['我们计划周末去水族馆看企鹅'], visibility: 'private', gist: '约定周末去水族馆看企鹅', keywords: ['水族馆'] });
  const fPrivate = memory.upsertFact({ kind: 'like', subject: 'other', content: '他的小名只有我知道', mid: 4101 });
  const fAmbient = memory.upsertFact({ kind: 'like', subject: 'other', content: '他喜欢收集旧邮票', mid: 4102, visibility: 'ambient' });
  const recallSectionOf = (up) => {
    const i = up.indexOf('【近期回忆】');
    return i < 0 ? '' : up.slice(i, up.indexOf('【当前时间】', i));
  };
  const trigger = { id: 31, mid: 9101, ts: NOW - 3 * 60 * 60 * 1000, senderId: '10001', senderName: '星野', text: '记得我们上次聊的水族馆计划吗', self: false };
  const mkCtx = (surface) => ({
    chatKey: 'private:10001', kind: 'private', chatId: '10001',
    triggerEntries: [trigger],
    store: { recent: () => [trigger] },
    stickerEntries: [],
    session: { surface },
    promptAnchor: { prev: null },
    vectorHits: [
      { kind: 'gist', date: '2026-12-01', text: '约定周末去水族馆看企鹅', score: 0.9 },
      { kind: 'fact', key: fPrivate.key, text: '他的小名只有我知道', score: 0.8 },
      { kind: 'fact', key: fAmbient.key, text: '他喜欢收集旧邮票', score: 0.7 }
    ]
  });
  const sessWeb = { surface: 'web' };
  const upWeb = promptMod.buildUserPrompt({ ...mkCtx('web'), session: sessWeb });
  const secWeb = recallSectionOf(upWeb);
  assert.ok(secWeb, 'web 面召回段渲染');
  assert.ok(secWeb.includes('水族馆'), 'gist/词法行（both 项）进召回段');
  assert.ok(secWeb.includes('他的小名只有我知道'), 'web 面 private fact 向量行可见');
  assert.ok(sessWeb.recallHits && sessWeb.recallHits.gate.hit === true, 'session.recallHits 落账（T2.4）');
  assert.deepEqual(sessWeb.recallHits.hits.map((h) => h.source), ['both', 'fact'], 'web 面记账：both + fact');
  const sessPet = { surface: 'pet' };
  const upPet = promptMod.buildUserPrompt({ ...mkCtx('pet'), session: sessPet });
  const secPet = recallSectionOf(upPet);
  assert.ok(!secPet.includes('水族馆'), 'pet 面 private 卡（词法+gist）全部不可见');
  assert.ok(!secPet.includes('他的小名只有我知道'), 'pet 面 private fact 向量行被过滤');
  assert.ok(secPet.includes('他喜欢收集旧邮票'), 'pet 面 ambient fact 向量行可见');
  assert.deepEqual(sessPet.recallHits.hits.map((h) => h.source), ['fact'], 'pet 面记账：仅 ambient fact');
});

// ═════════════════ card-vector 第二批 · 行级向量（容器/四源RRF/可见性）════════════════
group('card-vector 第二批 行级向量（容器/四源RRF/可见性）');

test('第二批 T1：syncCard 建行（kind/hash/dim）→ 重复同步零 fetch → 同日替换行集 diff（删旧/更新/未变跳过）', async () => {
  withEmbedding();
  fs.rmSync(INDEX_FILE, { force: true });
  const counters = { calls: 0 };
  const orig = installFakeEmbedFetch(counters);
  try {
    const card = {
      date: '2026-11-25', gist: '行级测试卡', keywords: ['行级'], mood: '平静',
      events: ['事件一', '事件二'],
      facts: [{ content: '卡内事实一', mid: 1 }],
      entry: '正文一',
      promises: [{ text: '约定一', due: '', status: 'open', mid: 2 }],
      open_loops: ['未完一']
    };
    const expected = recallMod.cardRows(card);
    assert.equal(expected.length, 7, '行集 = 2 event + 1 fact + entry + promise + open_loop + mood');
    const r1 = await cardIndex.syncCard(card);
    assert.equal(r1.ok, true, '首同步成功');
    assert.equal(r1.rows.added, 7, '首同步 7 行');
    const st1 = cardIndex.stats();
    assert.equal(st1.rows, 7, '索引 rows=7');
    const rowList = Object.values(readIndexState().rows);
    assert.equal(rowList.length, 7, '容器 rows 表 7 行');
    assert.deepEqual(rowList.map((r) => r.kind).sort(), ['entry', 'event', 'event', 'fact', 'mood', 'open_loop', 'promise'].sort(), 'kind 映射与 cardRows 同源');
    for (const row of rowList) {
      assert.equal(row.content_hash, crypto.createHash('sha1').update(row.text, 'utf8').digest('hex'), `content_hash=sha1(行原文)：${row.text}`);
      assert.equal(row.embed_model, 'text-embedding-qwen3-embedding-0.6b', '行带 embed_model');
      assert.equal(row.dim, FAKE_DIM, '行带 dim');
      assert.ok(Array.isArray(row.embedding) && row.embedding.length === FAKE_DIM, '行带向量本体');
    }
    const callsAfterFirst = counters.calls;
    const r2 = await cardIndex.syncCard({ ...card });
    assert.equal(r2.rows.added, 0, '重复同步零新增');
    assert.equal(r2.rows.updated, 0, '重复同步零更新');
    assert.equal(r2.rows.removed, 0, '重复同步零删除');
    assert.equal(counters.calls, callsAfterFirst, '行 hash 未变零 fetch（幂等零嵌入成本）');
    const card2 = { ...card, events: ['事件二', '事件三'] };
    delete card2.promises;
    delete card2.open_loops;
    const r3 = await cardIndex.syncCard(card2);
    assert.equal(r3.rows.updated, 2, '两个事件行变更');
    assert.equal(r3.rows.removed, 2, 'promise/open_loop 行消失');
    assert.equal(r3.rows.added, 0, 'rowKey 对齐不新增');
    assert.equal(cardIndex.stats().rows, 5, '同日替换后 rows=5');
    const texts = Object.values(readIndexState().rows).map((r) => r.text);
    assert.ok(texts.includes('事件三') && !texts.includes('事件一'), '旧事件行删除、新事件行入索引');
    assert.ok(counters.calls > callsAfterFirst, '变更行触发嵌入');
  } finally {
    globalThis.fetch = orig;
    configMod.setRuntimeConfig(cvSavedConfig);
  }
});

test('第二批 T1：search 返回 rows 降序（自向量 top1）+ stats rows/cardsRows/lag.rows 口径', async () => {
  withEmbedding();
  fs.rmSync(INDEX_FILE, { force: true });
  const counters = { calls: 0 };
  const orig = installFakeEmbedFetch(counters);
  try {
    const card = { date: '2026-11-26', gist: '检索卡', keywords: [], mood: '', events: ['检索行一', '检索行二'], entry: '检索正文' };
    // V3 自洁化（对照表登记）：原 cardsRows>=3 断言隐式依赖此前各组残留的 gist 卡——
    // 文件时代靠执行序偶然成立。改为本用例经 writeCard 落自己的卡（stats() 的 cards()
    // 读回口径），断言收紧为精确等于（更强、且与执行序无关）。
    resetCards();
    memory.writeCard(card);
    await cardIndex.syncCard(card);
    const state = readIndexState();
    const target = Object.values(state.rows).find((r) => r.text === '检索行二');
    assert.ok(target, '目标行在容器内');
    const res = cardIndex.search(target.embedding);
    assert.equal(res.rows[0].rowKey, target.rowKey, '自向量 top1（点积=1）');
    assert.ok(res.rows.every((r, i, arr) => i === 0 || arr[i - 1].score >= r.score), 'rows 按点积降序');
    const st = cardIndex.stats();
    assert.equal(st.rows, 3, 'rows=3（两事件 + 正文；mood 空不建行）');
    assert.equal(st.cardsRows, 3, `cardsRows=本卡预期行数（两事件+正文；实际 ${st.cardsRows}）`);
    assert.equal(st.lag.rows, 0, 'lag.rows=0（已同步行集与预期一致）');
    assert.ok(Number.isInteger(st.lag.rows) && st.lag.rows >= 0, 'lag.rows 口径存在且非负');
  } finally {
    globalThis.fetch = orig;
    configMod.setRuntimeConfig(cvSavedConfig);
  }
});

test('第二批 T3：四源 RRF — row-only 入选（source=row）/ 同日 lexical+row 标 both / rowFloor 边界', () => {
  const cards = [
    { date: '2027-03-01', salience: 1, events: ['咖啡豆到货了'], facts: [], open_loops: [], mood: '' },
    { date: '2027-03-02', salience: 1, events: ['茶具洗好了'], facts: [], open_loops: [], mood: '' }
  ];
  const args = { text: '咖啡', lastMessageTs: NOW - TWO_H - 1, now: NOW, cards };
  const rowOnly = recallForPrompt({
    ...args,
    vectorHits: [{ kind: 'row', date: '2027-03-02', rowKey: 'r1', text: '只有向量能命中的茶具故事', score: 0.9 }]
  });
  const rowHit = rowOnly.recallHits.hits.find((h) => h.text.includes('只有向量能命中的茶具故事'));
  assert.ok(rowHit, 'row 行入展示');
  assert.equal(rowHit.source, 'row', 'row-only 来源=row');
  const both = recallForPrompt({
    ...args,
    vectorHits: [{ kind: 'row', date: '2027-03-01', rowKey: 'r2', text: '咖啡豆是深烘的', score: 0.9 }]
  });
  assert.equal(both.hits[0].text, '03-01 咖啡豆到货了', '同日保留融合序最优行（词法先现）');
  assert.equal(both.recallHits.hits[0].source, 'both', '同日 lexical+row → both');
  const at = recallForPrompt({
    ...args,
    vectorHits: [{ kind: 'row', date: '2027-03-02', rowKey: 'r3', text: 'floor 边界 row', score: 0.45 }]
  });
  assert.ok(at.hits.some((h) => h.text.includes('floor 边界 row')), 'score ≥ rowFloor(0.45) 入选');
  const below = recallForPrompt({
    ...args,
    vectorHits: [{ kind: 'row', date: '2027-03-02', rowKey: 'r4', text: 'floor 边界 row', score: 0.4499 }]
  });
  assert.ok(!below.hits.some((h) => h.text.includes('floor 边界 row')), 'score < rowFloor 不入选');
});

test('第二批 T3：row 向量可见性过滤（private 卡 web 可见 / pet 不可见）', () => {
  memory.writeCard({
    date: '2026-12-05', salience: 1, events: ['周三下午的旧计划'], facts: [], open_loops: [], mood: '',
    gist: '行级可见性私有卡', keywords: ['行级可见性'], visibility: 'private'
  });
  const trigger = { id: 41, mid: 9401, ts: NOW - 3 * 60 * 60 * 1000, senderId: '10001', senderName: '星野', text: '记得我们聊过的那个安排吗', self: false };
  const mk = (surface) => ({
    chatKey: 'private:10001', kind: 'private', chatId: '10001',
    triggerEntries: [trigger],
    store: { recent: () => [trigger] },
    stickerEntries: [],
    session: { surface },
    promptAnchor: { prev: null },
    // 行文本故意与卡内事件/触发文本无词法重叠：web 面若出现只能来自 row 向量。
    vectorHits: [{ kind: 'row', date: '2026-12-05', rowKey: 'r-vis', text: '只有行级向量才带出的细节', score: 0.9 }]
  });
  const upWeb = promptMod.buildUserPrompt(mk('web'));
  assert.ok(upWeb.includes('只有行级向量才带出的细节'), 'web 面 private 卡 row 行可见');
  const upPet = promptMod.buildUserPrompt(mk('pet'));
  assert.ok(!upPet.includes('只有行级向量才带出的细节'), 'pet 面 private 卡 row 行被过滤');
});

// ═══════════════════════ storage-v2 V1 地基（执行清单 T1.3）═══════════════════════
// db.js 地基断言：加载器探测（node 路径——electron 分支由 ELECTRON_RUN_AS_NODE 探针
// 单独实证，输出走文件落地）、WAL/DDL 存在、meta 计数器单调、FTS 触发器增量、
// transaction 回滚、沙箱 DB 建在临时根。沙箱纪律同全文头注：DATA_ROOT 已在进程第一行
// 设为 mkdtemp 临时目录，db.js 经 config.js 解析 DATA_DIR，DB 一律落在临时根。

group('storage-v2 V1 地基（db.js：加载器/懒开/WAL/DDL/transaction/FTS）');

const dbmod = await import('../src/storage/db.js');
const DB_FILE = dbmod.dbFile;
// V3 起记忆组（先于本组定义/执行）会经 memory.upsertFact 首用 DB——「import 后首用前
// 无 DB 文件」的加载期零副作用断言改在**模块加载时点**捕获（此刻任何测试体都未执行，
// 语义与原断言完全等价且不再依赖组顺序）。对照表见交接内部文档 handoff-sqlite-v2.md 夜3。
const DB_ABSENT_AT_IMPORT = !fs.existsSync(DB_FILE);

test('storage T1：加载器探测（node 路径）→ node_modules 构建 + 版本钉 12.11.1', () => {
  assert.equal(process.versions.electron, undefined, '本测试进程应为系统 node（无 electron 键）');
  const info = dbmod.driverInfo();
  assert.equal(info.runtime, 'node', `runtime=${info.runtime}（探测谓词 process.versions.electron）`);
  assert.equal(info.source, 'node_modules', `source=${info.source}（node 路径禁走 vendor）`);
  assert.equal(info.vendorDir, path.resolve(TOOL_DIR, '..', 'vendor', 'better-sqlite3-electron'), 'vendor 目录解析正确');
  const pkg = JSON.parse(fs.readFileSync(path.join(TOOL_DIR, '..', 'node_modules', 'better-sqlite3', 'package.json'), 'utf8'));
  assert.equal(pkg.version, '12.11.1', `node_modules better-sqlite3 版本必须钉 12.11.1（实际 ${pkg.version}）`);
});

test('storage T2：沙箱纪律①——模块加载期零副作用，import db.js 时点 DB 文件不存在（V3 起捕获于加载时点，语义等价）', () => {
  assert.equal(DB_ABSENT_AT_IMPORT, true, `import db.js 后、任何首用前不应存在 ${DB_FILE}`);
});

test('storage T3：懒开 + 沙箱纪律②——DB 建在临时数据根，绝不触真实数据根', () => {
  const db = dbmod.getDb();
  assert.ok(db, 'getDb 返回连接');
  assert.equal(fs.existsSync(DB_FILE), true, '首用后才落库文件');
  assert.equal(DB_FILE, path.join(DATA_ROOT, 'xunxi.db'), `DB 应建在临时根内：${DB_FILE}`);
  assert.ok(DB_FILE.startsWith(DATA_ROOT) && DATA_ROOT.includes(path.join(os.tmpdir(), 'xunxi-person-tests-')), '数据根必须是本进程 mkdtemp 临时目录');
});

test('storage T4：pragma——journal_mode=wal + foreign_keys=ON', () => {
  const db = dbmod.getDb();
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal', 'WAL（plan D2）');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, '外键约束开启');
});

test('storage T5：DDL 全量存在——八表+FTS 虚表+四索引+三触发器+补全列', () => {
  const db = dbmod.getDb();
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'messages_fts_%' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));
  for (const t of ['messages', 'meta', 'messages_fts', 'facts', 'cards', 'staging', 'diary', 'state', 'kv']) {
    assert.ok(tables.has(t), `缺表 ${t}`);
  }
  const idx = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name));
  for (const i of ['idx_messages_ts', 'idx_messages_day', 'idx_facts_status', 'idx_diary_ts']) assert.ok(idx.has(i), `缺索引 ${i}`);
  const trg = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name));
  for (const t of ['messages_ai', 'messages_ad', 'messages_au']) assert.ok(trg.has(t), `缺触发器 ${t}`);
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  // plan §12 补全 + 执行清单 T1.1 cards.extra 兜底列
  for (const c of ['gist', 'keywords', 'range', 'extra', 'writtenAt', 'visibility']) assert.ok(cols('cards').includes(c), `cards 缺列 ${c}`);
  assert.ok(cols('facts').includes('extra'), 'facts 缺 extra（零语义损失兜底）');
  assert.ok(cols('messages').includes('day'), 'messages 缺 day（本地日键索引列）');
  assert.ok(cols('messages').includes('seq'), 'messages 缺 seq（插入序：id 有 3 处历史倒序不能当序键，V2 补全）');
  assert.ok(cols('messages').includes('recalled'), 'messages 缺 recalled（历史撤回标记，NULL=键缺失，V2 补全）');
  assert.ok(cols('meta').includes('key') && cols('meta').includes('value'), 'meta 缺 key/value（nextLocalId 落点）');
});

test('storage T6：meta 精确计数器——往返 + 事务内递增跨事务单调（MAX(id)+1 复用陷阱的地基防护）', () => {
  dbmod.setMeta('test.counter', '5');
  assert.equal(dbmod.getMeta('test.counter'), '5', 'set/get 往返');
  const bumped = dbmod.transaction(() => {
    const cur = Number(dbmod.getMeta('test.counter'));
    dbmod.setMeta('test.counter', String(cur + 1));
    return cur;
  });
  assert.equal(bumped, 5, 'transaction 返回 fn 返回值');
  assert.equal(dbmod.getMeta('test.counter'), '6', '事务内递增持久化');
  dbmod.transaction(() => dbmod.setMeta('test.counter', String(Number(dbmod.getMeta('test.counter')) + 1)));
  assert.equal(dbmod.getMeta('test.counter'), '7', '跨事务仍单调递增');
});

test('storage T7：transaction 回滚——fn 抛错 → INSERT 与 setMeta 全撤销', () => {
  const db = dbmod.getDb();
  dbmod.setMeta('test.rollback', 'keep');
  assert.throws(() => dbmod.transaction(() => {
    db.prepare("INSERT INTO staging (day, seq, text, mid, source, at) VALUES ('2026-11-17', 901, '回滚应抹掉我', null, 'chat', 1)").run();
    dbmod.setMeta('test.rollback', 'changed-inside-tx');
    throw new Error('模拟巩固中途失败');
  }), /模拟巩固中途失败/, '异常应原样上抛');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM staging WHERE day='2026-11-17' AND seq=901").get().n, 0, '事务内 INSERT 应被回滚');
  assert.equal(dbmod.getMeta('test.rollback'), 'keep', '事务内 setMeta 应被回滚');
});

test('storage T8：transaction 提交路径——返回值穿透 + 行落盘 + (day,seq) 复合主键防重', () => {
  const db = dbmod.getDb();
  const ret = dbmod.transaction(() => {
    db.prepare("INSERT INTO staging (day, seq, text, mid, source, at) VALUES ('2026-11-17', 902, '保留我', null, 'chat', 2)").run();
    return 'done';
  });
  assert.equal(ret, 'done', '返回值穿透');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM staging WHERE day='2026-11-17' AND seq=902").get().n, 1, '正常路径行落盘');
  assert.throws(() => db.prepare("INSERT INTO staging (day, seq, text, mid, source, at) VALUES ('2026-11-17', 902, '重复', null, 'chat', 3)").run(),
    /UNIQUE constraint failed: staging\.day, staging\.seq/, '(day,seq) 复合主键必须防重');
});

test('storage T9：FTS 三触发器增量（外部内容表 insert/update/delete 同步）', () => {
  const db = dbmod.getDb();
  const match = (q) => db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(q);
  db.prepare('INSERT INTO messages (id, mid, ts, self, senderId, senderName, text, reply, media, isPoke, atMe, atNames, read, day, seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(9001, 'fts-m1', 1700000000000, 0, 'u1', '测试者', '我们聊过星空之下的大海', null, '[]', 0, 0, '[]', 0, '2026-11-17', 9001);
  assert.equal(match('星空之').length, 1, 'INSERT 后 FTS 可命中（ai 触发器）');
  db.prepare('UPDATE messages SET text=? WHERE id=9001').run('改成海边日落的傍晚了');
  assert.equal(match('星空之').length, 0, 'UPDATE 后旧词不再命中（au 触发器 delete 旧值）');
  assert.equal(match('海边日').length, 1, 'UPDATE 后新词命中（au 触发器 insert 新值）');
  db.prepare('DELETE FROM messages WHERE id=9001').run();
  assert.equal(match('海边日').length, 0, 'DELETE 后不再命中（ad 触发器）');
});

// ═══════════════════ storage-v2 V2 store（执行清单 T2.6）═══════════════════════
// store.js 后端切换（main.json 整文件回写 → messages 表 + meta 计数器）的 DB 行为断言。
// 文件机制断言退役对照表（原断言 → DB 等价断言，零无声删除）见交接内部文档 handoff-sqlite-v2.md
// 夜2 节：web-body-test T10 的文件断言（main.json 落盘/单文件/内嵌键归一）随文件机制退役，
// 以 DB 行为断言等价替代（web-body-test T10 DB 版 + 本组 T1/T4/T6/T10）。
// 沙箱纪律同全文头注：mkdtemp 数据根 + env 先行；store 组与 storage 组共用同一 DB 连接
// （同进程单 DATA_ROOT；closeDb 后重开走幂等 DDL 路径）。

group('storage-v2 V2 store（messages 后端切换：DB 行为断言 + 文件机制退役对照）');

const { ChatStore } = await import('../src/kernel/store.js');

// 组内每个用例先重置时间线（messages 全清 + meta 计数器清）——确定性不依赖执行序
const timelineReset = () => dbmod.transaction(() => {
  dbmod.getDb().prepare('DELETE FROM messages').run();
  dbmod.getDb().prepare("DELETE FROM meta WHERE key IN ('chatKey', 'nextLocalId')").run();
});
// 本地日键（与 src/storage/messages-map.js dayKeyOf 同口径——测试侧独立实现防同源盲区）
const expectDayKey = (ts) => {
  const d = new Date(Number(ts));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('store T1：append 落库（列值）+ meta 计数器随 INSERT 同事务递增 + chatKey 归一 + 返回形状逐字节', () => {
  timelineReset();
  const store = new ChatStore(0);
  const entry = store.appendIncoming('main', { mid: 'web-1-abc', ts: 1700000000000, senderId: '10001', senderName: '星野', text: '第一条入库消息', media: [{ kind: 'image', id: 'm1' }], atMe: null, atNames: [] });
  const db = dbmod.getDb();
  const row = db.prepare('SELECT id, mid, ts, self, senderId, senderName, text, reply, media, isPoke, atMe, atNames, read, seq, day, recalled FROM messages WHERE id = ?').get(entry.id);
  assert.ok(row, '行已落库');
  assert.equal(row.mid, 'web-1-abc');
  assert.equal(row.ts, 1700000000000);
  assert.equal(row.self, 0);
  assert.equal(row.read, 0, '入站 = 未读');
  assert.equal(row.media, JSON.stringify([{ kind: 'image', id: 'm1' }]), 'media JSON 列');
  assert.equal(row.day, expectDayKey(1700000000000), 'day = 本地日键（dayKeyOf 同口径）');
  assert.equal(row.recalled, null, '写入方不再写 recalled → 列 NULL');
  assert.equal(dbmod.getMeta('nextLocalId'), String(entry.id + 1), '计数器递增与 INSERT 同事务（plan §3 meta 注）');
  assert.equal(dbmod.getMeta('chatKey'), 'main', 'chatKey 每次写入归一 main');
  // 返回形状逐字节：键序 = 写入方字面量序（非 self 行含 isPoke/atMe/atNames）
  assert.deepEqual(Object.keys(entry), ['id', 'mid', 'ts', 'senderId', 'senderName', 'text', 'self', 'read', 'reply', 'media', 'isPoke', 'atMe', 'atNames']);
  assert.equal(entry.self, false);
  assert.deepEqual(entry.media, [{ kind: 'image', id: 'm1' }]);
  assert.equal(entry.atMe, null, 'atMe 显式 null 形状保留');
  assert.deepEqual(entry.atNames, []);
});

test('store T2：self 行形状——appendSelf 无 isPoke/atMe/atNames 键 + 列 NULL + 计数器跨实例延续', () => {
  const store = new ChatStore(0);   // 新实例 = 从 DB 重建缓存（T1 的行与计数器读回）
  const entry = store.appendSelf('main', { text: '我自己说的', ts: 1700000001000, mid: null });
  assert.deepEqual(Object.keys(entry), ['id', 'mid', 'ts', 'senderId', 'senderName', 'text', 'self', 'read', 'reply', 'media'], 'self 行键集 = 旧 appendSelf 字面量（无三键）');
  assert.equal(entry.read, true, 'self 行恒已读');
  const row = dbmod.getDb().prepare('SELECT self, read, isPoke, atMe, atNames FROM messages WHERE id = ?').get(entry.id);
  assert.equal(row.self, 1);
  assert.equal(row.read, 1);
  assert.equal(row.isPoke, null, 'self 行 isPoke 列 NULL（读侧据此省略键）');
  assert.equal(row.atMe, null);
  assert.equal(row.atNames, null);
});

test('store T3：id 精确计数器——删最大 id 行后新 id 不复用（MAX(id)+1 陷阱的 store 层实证）', () => {
  const store = new ChatStore(0);
  const b = store.appendSelf('main', { text: 'b', ts: 1700000003000 });
  store.removeByLocalIds('main', [b.id]);   // 删最大 id 行
  const c = store.appendSelf('main', { text: 'c', ts: 1700000004000 });
  assert.equal(c.id, b.id + 1, '计数器不回退（meta.nextLocalId 与行集无关）');
  assert.equal(store.findByLocalId('main', b.id), null, '被删行不回来');
});

test('store T4：读回形状保真（文件时代形态）——数字 mid 重建 number / recalled / self 行缺键 / seq 决定顺序', () => {
  timelineReset();
  const db = dbmod.getDb();
  const ins = db.prepare('INSERT INTO messages (id, mid, ts, self, senderId, senderName, text, reply, media, isPoke, atMe, atNames, read, day, seq, recalled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  // 三行历史形态；seq 故意与 id 逆序（镜像旧文件 3 处 id 倒序：22→21 / 1133→974 / 998→997）——
  // 证明读回顺序由 seq（插入序）决定，不是 id
  ins.run(201, '123456789', 1700000100000, 0, '1008645321', '星野', 'QQ 时代数字 mid', null, '[]', 0, null, '[]', 1, '2026-11-14', 1, 1);
  ins.run(203, 'web-1700000102000-0', 1700000102000, 0, '10001', '星野', 'web 时代字符串 mid', null, '[]', 0, 0, '[]', 0, '2026-11-14', 2, null);
  ins.run(202, null, 1700000101000, 1, 'self', '我', 'self 行', null, '[]', null, null, null, 1, '2026-11-14', 3, null);
  db.prepare("INSERT INTO meta (key, value) VALUES ('nextLocalId', '204')").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('chatKey', 'main')").run();
  const store = new ChatStore(0);
  const msgs = store.recent('main', { limit: 10 });
  assert.deepEqual(msgs.map((m) => m.id), [201, 203, 202], '顺序由 seq 决定（非 id 排序）');
  assert.equal(JSON.stringify(msgs[0]), JSON.stringify({ id: 201, mid: 123456789, ts: 1700000100000, senderId: '1008645321', senderName: '星野', text: 'QQ 时代数字 mid', self: false, read: true, reply: null, media: [], isPoke: false, atMe: null, atNames: [], recalled: true }), '纯整数 mid 重建为 number + recalled:true + atMe 显式 null（键序=写入方字面量序）');
  assert.equal(JSON.stringify(msgs[1]), JSON.stringify({ id: 203, mid: 'web-1700000102000-0', ts: 1700000102000, senderId: '10001', senderName: '星野', text: 'web 时代字符串 mid', self: false, read: false, reply: null, media: [], isPoke: false, atMe: false, atNames: [] }), 'web 字符串 mid 保持 string');
  assert.equal(JSON.stringify(msgs[2]), JSON.stringify({ id: 202, mid: null, ts: 1700000101000, senderId: 'self', senderName: '我', text: 'self 行', self: true, read: true, reply: null, media: [] }), 'self 行省略 isPoke/atMe/atNames（appendSelf 形状）');
});

test('store T5：drainUnread/peekUnread/unreadCount 语义 + batch 引用置已读 + 已读持久化（closeDb 重开）', () => {
  timelineReset();
  const store = new ChatStore(0);
  const t0 = 1700000200000;
  store.appendIncoming('main', { mid: 'u1', ts: t0, senderId: '10001', senderName: '星', text: '未读一' });
  store.appendIncoming('main', { mid: 'u2', ts: t0 + 1000, senderId: '10001', senderName: '星', text: '未读二' });
  store.appendSelf('main', { text: '已读的我', ts: t0 + 2000 });
  assert.equal(store.unreadCount('main'), 2, '未读只计他人（self 恒已读）');
  assert.equal(store.peekUnread('main', 1).length, 1, 'peek 不置已读');
  assert.equal(store.peekUnread('main', 1)[0].read, false);
  const batch = store.drainUnread('main');
  assert.equal(batch.length, 2, 'drain 取走未读');
  assert.equal(batch[0].read, true, '返回的 batch 条目已被置已读（引用语义与旧实现一致）');
  assert.equal(store.unreadCount('main'), 0);
  dbmod.closeDb();
  const store2 = new ChatStore(0);
  assert.equal(store2.unreadCount('main'), 0, '已读状态持久化（重开连接读回）');
  const n = store2.markUnreadInWindow('main', t0 + 1500, t0 + 2000);
  assert.equal(n, 2, '窗口内两条入站翻回未读（winStart 向前放宽 5 分钟；self 不翻）');
  assert.equal(store2.unreadCount('main'), 2);
  assert.equal(store2.markAllRead('main'), 2, 'markAllRead 只翻他人未读');
  assert.equal(store2.unreadCount('main'), 0);
});

test('store T6：removeByLocalIds/clearChat + FTS 同步（ad 触发器）+ clearChat 后 id 延续', () => {
  timelineReset();
  const db = dbmod.getDb();
  const store = new ChatStore(0);
  const e1 = store.appendIncoming('main', { mid: 'f1', ts: 1700000300000, senderId: '10001', senderName: '星', text: '星空之下的大海味道' });
  store.appendIncoming('main', { mid: 'f2', ts: 1700000301000, senderId: '10001', senderName: '星', text: '第二条' });
  const match = (q) => db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(q);
  assert.equal(match('星空之下').length, 1, 'append → FTS 可命中（ai 触发器）');
  assert.equal(store.removeByLocalIds('main', [e1.id]), 1, '部分清除返回删除条数');
  assert.equal(match('星空之下').length, 0, 'removeByLocalIds → FTS 同步移除（ad 触发器）');
  assert.equal(store.findByLocalId('main', e1.id), null);
  assert.equal(store.clearChat('main'), 1, '整体清除返回条数（e1 已先删，剩 1 行）');
  const counterBefore = Number(dbmod.getMeta('nextLocalId'));
  const e3 = store.appendIncoming('main', { mid: 'f3', ts: 1700000302000, senderId: '10001', senderName: '星', text: '清空后第一条' });
  assert.equal(e3.id, counterBefore, 'clearChat 后 id 延续（计数器不重置——旧实现口径）');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('store T7：dedup——同 mid 拒绝返回 null + 同人同文本 1 秒窗口 + 窗口外放行', () => {
  timelineReset();
  const store = new ChatStore(0);
  const t0 = 1700000400000;
  const first = store.appendIncoming('main', { mid: 'dup-1', ts: t0, senderId: '10001', senderName: '星', text: '重复投递' });
  assert.ok(first, '首条入库');
  assert.equal(store.appendIncoming('main', { mid: 'dup-1', ts: t0 + 5000, senderId: '10001', senderName: '星', text: '重复投递' }), null, '同 mid 二次投递 → null');
  assert.equal(store.appendIncoming('main', { mid: 'dup-2', ts: t0 + 300, senderId: '10001', senderName: '星', text: '重复投递' }), null, '同人同文本 1 秒窗口 → null');
  const third = store.appendIncoming('main', { mid: 'dup-3', ts: t0 + 2000, senderId: '10001', senderName: '星', text: '重复投递' });
  assert.ok(third, '窗口外（>1s）放行');
});

test('store T8：day 列本地日键——跨日 ts 各落各的日键（本地时区，与 executor.localDayKey 同口径）', () => {
  timelineReset();
  const db = dbmod.getDb();
  const store = new ChatStore(0);
  const d1 = new Date(2026, 10, 17, 23, 59, 0).getTime();   // 本地 2026-11-17 23:59
  const d2 = new Date(2026, 10, 18, 1, 0, 0).getTime();     // 本地 2026-11-18 01:00
  store.appendSelf('main', { text: '跨日一', ts: d1 });
  store.appendSelf('main', { text: '跨日二', ts: d2 });
  const rows = db.prepare('SELECT day FROM messages ORDER BY seq').all();
  assert.deepEqual(rows.map((r) => r.day), ['2026-11-17', '2026-11-18'], 'day = 本地日键');
});

test('store T9：maxPerChat 裁剪——头部旧行同事务 DELETE + 内存/DB 一致', () => {
  timelineReset();
  const db = dbmod.getDb();
  const store = new ChatStore(2);   // 上限 2
  store.appendSelf('main', { text: '旧一', ts: 1700000500000 });
  store.appendSelf('main', { text: '旧二', ts: 1700000501000 });
  store.appendSelf('main', { text: '旧三', ts: 1700000502000 });   // 超限 → 旧一被裁
  assert.deepEqual(store.recent('main', { limit: 10 }).map((m) => m.text), ['旧二', '旧三'], '内存裁剪');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2, 'DB 同步 DELETE 被裁行');
  store.appendSelf('main', { text: '旧四', ts: 1700000503000 });
  assert.equal(store.recent('main', { limit: 10 }).map((m) => m.text).join(','), '旧三,旧四');
});

test('store T10：重启一致性——closeDb → 新实例 recent 逐字节一致（plan §7-V2 读回回归）', () => {
  const store = new ChatStore(0);
  const before = store.recent('main', { limit: 50 }).map((m) => JSON.stringify(m));
  dbmod.closeDb();
  const store2 = new ChatStore(0);
  const after = store2.recent('main', { limit: 50 }).map((m) => JSON.stringify(m));
  assert.deepEqual(after, before, '重启后读回逐字节一致');
});

// ═══════════════════ storage-v2 V4/V5 收口（执行清单 T4.1-T4.5）═══════════════════
// mind/relationship/self/life → state 表、diary → diary 表、reminders → kv 表的后端切换
// 断言 + executor 巩固段单事务（T4.3）中途失败回滚断言。文件机制白盒（rm/writeMindState
// 直写 *.json）→ DB 行等价操作（resetStateKey/putStateRow），对照表见交接夜4。

// person/self 已于 2026-11-21 整体丢弃（原 selfMod import 摘除——narrative/values
// 零消费方，人设 roleText 覆盖其职责；state 行同删，见 state-ownership v11）。
const diaryMod2 = await import('../src/person/diary.js');   // person/diary（diaryMod = reflection/diary，先占）
const { ReminderStore } = await import('../src/reminders.js');
/** diary 沙箱 reset（含 AUTOINCREMENT 计数归零——id 断言确定性 1..N）。 */
const resetDiary = () => dbmod.transaction(() => {
  dbmod.getDb().prepare('DELETE FROM diary').run();
  if (dbmod.getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get()) {
    dbmod.getDb().prepare("DELETE FROM sqlite_sequence WHERE name = 'diary'").run();
  }
});

group('storage-v2 V4 state 表（mind/life 后端切换；relationship/self 已弃）');

test('state T1：两件各落各 key（整对象 JSON 列）+ updatedAt 落库 + API 读回字节等价', () => {
  for (const k of ['mind', 'life']) resetStateKey(k);
  const m = mind.noteMood({ mood: 'T1 探针', source: 'test' });   // mind：仍可写的小状态（2026-11-21 数值丢弃后只剩文本/心事面）
  const mRow = stateRowOf('mind');
  assert.ok(mRow, 'mind 行落库');
  assert.equal(mRow.key, 'mind');
  assert.deepEqual(JSON.parse(String(mRow.json)), m.state, '行 json 与 API 返回深度相等');
  assert.ok(Number.isFinite(Number(mRow.updatedAt)) && Number(mRow.updatedAt) > 0, 'updatedAt 有限数字（NOT NULL）');
  // updatedAt 归一（state-map 契约 2）：对象自带有限数字 updatedAt → 原值
  assert.equal(Number(mRow.updatedAt), m.state.updatedAt, 'updatedAt = 对象自带值');
  // life：无 updatedAt 顶层键的对象（her-life 时代形状，真实 life.json 普查同形）→ Date.now() 回退
  resetLife();
  lifeStore.write({ version: 1, dayKey: '2026-01-01', plan: null, inner: [] });
  const lifeRow = stateRowOf('life');
  assert.ok(lifeRow, 'life 行落库');
  assert.deepEqual(JSON.parse(String(lifeRow.json)), lifeStore.read(), 'life 行 json 与 read() 深度相等');
  assert.ok(Number.isFinite(Number(lifeRow.updatedAt)), 'life updatedAt 回退 Date.now()（对象无该键）');
  // 读回字节等价（JSON.stringify 键序=文件时代键序——json 列整对象往返保序）
  assert.equal(JSON.stringify(lifeStore.read()), JSON.stringify(JSON.parse(String(lifeRow.json))), 'life read() 键序与行 json 逐字节一致');
});

test('state T2：两 key 互不串写 + closeDb 重开持久化（重启一致性）', () => {
  for (const k of ['mind', 'life']) resetStateKey(k);
  mind.noteMood({ mood: '状态隔离探针', topics: ['隔离心事'], source: 'test' });
  lifeStore.write({ version: 1, dayKey: '2026-02-02', plan: { date: '2026-02-02' } });
  const mindBefore = mind.snapshot();
  const lifeBefore = lifeStore.read();
  dbmod.closeDb();
  assert.equal(JSON.stringify(mind.snapshot()), JSON.stringify(mindBefore), 'mind 重开逐字节一致');
  assert.equal(JSON.stringify(lifeStore.read()), JSON.stringify(lifeBefore), 'life 重开逐字节一致');
  // 两 key 独立行（不互串；relationship/self 已于 2026-11-21 丢弃移出词表）
  const keys = dbmod.getDb().prepare('SELECT key FROM state ORDER BY key').all().map((r) => r.key);
  assert.deepEqual(keys, ['life', 'mind'], '恰好两行各归各 key');
});

test('state T3：life.read() 缺行 → null / planForDay 三层回退不回归（DB 后端同语义）', () => {
  resetLife();
  assert.equal(lifeStore.read(), null, '缺行 → null（文件时代「无文件」等价）');
  assert.equal(lifeStore.planForDay('2026-01-01'), null, '缺行 planForDay → null');
  const plan = { date: '2026-03-03', dayKey: '2026-03-03', items: [] };
  lifeStore.write({ version: 1, plan, plansByDay: { '2026-03-03': plan } });
  assert.equal(lifeStore.planForDay('2026-03-03')?.date, '2026-03-03', 'plansByDay 权威层命中');
  lifeStore.write({ version: 1, plans: [{ date: '2026-04-04' }] });
  assert.equal(lifeStore.planForDay('2026-04-04')?.date, '2026-04-04', 'plans 历史层回退');
  resetLife();
});

test('state T4：mind 零变化不落库（self 行已随 self 面丢弃移除）', () => {
  resetMind();
  const beforeRow = stateRowOf('mind');
  const same = mind.apply({ impact: 0 });   // 无 kind/不达阈值 → 零变化
  assert.ok(same, '零事件返回状态');
  const afterRow = stateRowOf('mind');
  if (beforeRow) {
    assert.equal(afterRow.updatedAt, beforeRow.updatedAt, '零变化不重写（updatedAt 不动）');
  } else {
    assert.equal(afterRow, null, '零变化不落库');
  }
  resetMind();
});

group('storage-v2 V4 diary 表（diary 后端切换）');

test('diary T1：append 落库形状——json 列与文件时代行序列化逐字节同源 + 提取列正确 + 读回键序断言', () => {
  resetDiary();
  const at = new Date(2026, 10, 17, 22, 5).getTime();
  const entry = diaryMod2.append({ content: '第一条 DB 日记。\n\n第二段保留。', title: 'DB 本子', mood: '平静', at, source: 'test', mode: 'long' });
  const row = dbmod.getDb().prepare('SELECT id, ts, mode, title, entry, json FROM diary WHERE id = ?').get(1);
  assert.ok(row, '行落库（id=1 起计）');
  assert.equal(row.ts, at, 'ts 提取列 = at');
  assert.equal(row.mode, 'long', 'mode 提取列');
  assert.equal(row.title, 'DB 本子', 'title 提取列');
  assert.equal(row.entry, entry.content, 'entry 提取列 = content');
  assert.equal(row.json, JSON.stringify({ ...entry, mode: entry.mode || undefined }), 'json 列 = 文件时代 append 行内容逐字节同源');
  // 读回键序 = readAll 归一口径（time,title,mood,content,mode,at,source——文件时代逐字节）
  const back = diaryMod2.entries();
  assert.deepEqual(Object.keys(back[0]), ['time', 'title', 'mood', 'content', 'mode', 'at', 'source'], '读回键序与文件时代一致');
  assert.equal(back[0].content, entry.content, 'content 往返（换行保留）');
  assert.equal(back[0].time, entry.time, 'time 往返');
  // mode 空串 → json 键省略（文件行为）+ mode 列 NULL
  const e2 = diaryMod2.append({ content: '无 mode 一条', at: at + 1000, source: 'test' });
  const row2 = dbmod.getDb().prepare('SELECT mode, json FROM diary WHERE id = 2').get();
  assert.equal(row2.mode, null, 'mode 空串 → 提取列 NULL');
  assert.ok(!row2.json.includes('"mode"'), 'mode 空串 → json 键省略（文件时代 appendFileSync 行为）');
  assert.equal(diaryMod2.entries()[1].mode, '', '读回 mode 归一空串');
  assert.equal(e2.at, at + 1000);
  resetDiary();
});

test('diary T2：读序=at 升序+并列保插入序（乱序追加回归）+ entriesBetween/On/recent 口径', () => {
  resetDiary();
  const t0 = new Date(2026, 10, 18, 9, 0).getTime();
  diaryMod2.append({ content: '晚写的先', at: t0 + 5000, source: 'test' });
  diaryMod2.append({ content: '早写的后', at: t0, source: 'test' });
  diaryMod2.append({ content: '同刻甲', at: t0 + 2000, source: 'test' });
  diaryMod2.append({ content: '同刻乙', at: t0 + 2000, source: 'test' });
  const all = diaryMod2.entries();
  assert.deepEqual(all.map((e) => e.content), ['早写的后', '同刻甲', '同刻乙', '晚写的先'], '读序 = at 升序，并列保插入序（文件时代 stable sort 语义）');
  const win = diaryMod2.entriesBetween({ from: t0 + 2000, to: t0 + 2000 });
  assert.deepEqual(win.map((e) => e.content), ['同刻甲', '同刻乙'], '闭区间判重口径（writeGate dedup 语义）');
  assert.equal(diaryMod2.entriesBetween({ from: t0 + 2001, to: t0 + 1999 }).length, 0, '空窗');
  assert.equal(diaryMod2.entriesOn('2026-11-18').length, 4, 'entriesOn 按本地日（time 前缀）');
  assert.equal(diaryMod2.entriesOn('bad-day').length, 0, '非法日键 → 空数组');
  assert.deepEqual(diaryMod2.recent(2).map((e) => e.content), ['同刻乙', '晚写的先'], 'recent 截尾（升序取尾）');
  resetDiary();
});

group('storage-v2 V4 巩固事务收口（executor T4.3：三仓单事务 + 中途失败回滚）');

const C_day = '2026-11-13';   // 与 P2 fixture 同源（card-2026-11-13.json：2 facts + 1 episode + 1 promise）
const C_messages = [
  { id: 5205, mid: 5205, ts: p2At(C_day, 12, 1), self: false, senderName: '阿澄', text: '过来问项目的事' },
  { id: 5212, mid: 5212, ts: p2At(C_day, 12, 3), self: true, text: '我说慢点也没关系，他说不赶' },
  { id: 5216, mid: 5216, ts: p2At(C_day, 18, 2), self: false, senderName: '阿澄', text: '在整理学习笔记，说是状态最好的时候' },
  { id: 5222, mid: 5222, ts: p2At(C_day, 21, 4), self: false, senderName: '阿澄', text: '这几天一直在陪着推进' },
  { id: 5225, mid: 5225, ts: p2At(C_day, 22, 6), self: false, senderName: '阿澄', text: '忙完这轮就带我把旧文件归档' },
  { id: 5228, mid: 5228, ts: p2At(C_day, 23, 2), self: true, text: '晚安，好梦' }
];

test('巩固收口 T1（ask 指定断言）：伪造 parse 后的写入失败 → 三仓全回滚（cards/facts/mind 净零变化）+ 重跑成功三仓齐写', async () => {
  resetCards(); resetFacts(); resetMind();
  writeMindState({});   // 预置 mind 状态（2026-11-21 数值丢弃后巩固不再写 mind——预置态应原样保持）
  const mindBefore = JSON.stringify(mind.snapshot());
  const factsBefore = memory.facts({ status: 'all' });
  const db = dbmod.getDb();
  const origPrepare = db.prepare.bind(db);
  let factsInserts = 0;
  db.prepare = (sql, ...rest) => {
    if (typeof sql === 'string' && sql.startsWith('INSERT INTO facts')) {
      factsInserts += 1;
      if (factsInserts >= 2) throw new Error('注入：facts 第二条 INSERT 失败（巩固中途失败）');
    }
    return origPrepare(sql, ...rest);
  };
  let result;
  try {
    result = await executorMod.runOnce('cards', {
      day: C_day,
      data: { chatKey: 'web:main', day: C_day, now: p2At(C_day, 23, 32), messages: C_messages, staging: [], facts: [], life: null }
    });
  } finally {
    delete db.prepare;   // 解除注入（恢复原型方法）
  }
  assert.equal(result.status, 'failed', `巩固应 failed（实际 ${result.status}）`);
  assert.match(String(result.reason), /consolidation-transaction-failed/, 'reason 标记巩固事务失败');
  assert.ok(factsInserts >= 2, '注入确实在第二条 facts INSERT 处触发（中途=卡与首条事实已写入事务内）');
  // ── 三仓全回滚 ──
  assert.equal(memory.cards({ from: C_day, to: C_day }).length, 0, '① cards 回滚：当日无卡（writeCard 已在事务内执行过）');
  assert.deepEqual(memory.facts({ status: 'all' }), factsBefore, '② facts 回滚：行集全等（第一条 INSERT + 全部 UPDATE 一并撤销）');
  assert.equal(JSON.stringify(mind.snapshot()), mindBefore, '③ mind 回滚：快照逐字节一致（applyEpisodes 未达/未落）');
  // ── 解除注入重跑（force 跳过失败冷却）→ 三仓齐写 ──
  const ok = await executorMod.runOnce('cards', {
    day: C_day, force: true,
    data: { chatKey: 'web:main', day: C_day, now: p2At(C_day, 23, 32), messages: C_messages, staging: [], facts: [], life: null }
  });
  assert.equal(ok.status, 'written', `重跑应 written（实际 ${ok.status} ${ok.reason ?? ''}）`);
  assert.equal(ok.factsUpserted, 2, '两条事实落库');
  assert.equal(memory.cards({ from: C_day, to: C_day }).length, 1, '① 卡落库');
  assert.equal(memory.facts({ status: 'active' }).length, 2, '② 两条 active 事实');
  assert.equal(JSON.stringify(mind.snapshot()), mindBefore, '③ mind 快照零变化（episodes 面已退役——巩固事务回到 cards/facts 双表）');
  resetCards(); resetFacts(); resetMind();
});

test('巩固收口 T2：跨表原子直证——state 写入随外层事务回滚/提交（writeCard+mind.noteMood 同事务）', () => {
  resetCards(); resetMind();
  assert.throws(() => dbmod.transaction(() => {
    mind.noteMood({ mood: '事务探针' });   // state 写（事务嵌套语义；2026-11-21 起 noteMood 是 mind 的可预期写入口）
    memory.writeCard({ date: '2026-03-01', salience: 1, events: ['事务回滚卡'] });
    throw new Error('注入回滚');
  }), /注入回滚/, '外层事务抛错上抛');
  assert.equal(stateRowOf('mind'), null, 'mind 写随事务回滚（state 行不存在）');
  assert.equal(memory.cards({ from: '2026-03-01', to: '2026-03-01' }).length, 0, 'writeCard 随事务回滚');
  dbmod.transaction(() => {
    mind.noteMood({ mood: '事务探针' });
    memory.writeCard({ date: '2026-03-01', salience: 1, events: ['事务提交卡'] });
  });
  assert.ok(stateRowOf('mind'), 'mind 落库（提交路径）');
  assert.equal(memory.cards({ from: '2026-03-01', to: '2026-03-01' }).length, 1, '卡落库（提交路径）');
  assert.throws(() => memory.upsertFact({ kind: 'nonsense', subject: 'other', content: 'x' }), /PERSON_FACT_KINDS/, '校验错仍按旧口径抛出（消息不变）');
  const verr = (() => { try { memory.upsertFact({ kind: 'nonsense', subject: 'other', content: 'x' }); } catch (e) { return e; } throw new Error('unreachable'); })();
  assert.equal(verr.validation, true, '校验错带 validation 标记（executor 丢弃判据）');
  resetCards(); resetMind();
});

group('storage-v2 V5 kv 表（reminders 后端切换）');

test('kv T1：ReminderStore 全 API 往返 + kv 行形状（v=原文件形态 {reminders}）+ 重开持久化', () => {
  dbmod.getDb().prepare("DELETE FROM kv WHERE k IN ('reminders', 'transition')").run();
  const store = new ReminderStore();
  assert.deepEqual(store.reminders, [], '缺行 → 空表（文件时代 reminders.json 缺失同语义）');
  const a = store.add({ chatKey: 'main', text: '十分钟后收衣服', dueAt: 1700000000000, createdBy: 'tool' });
  assert.match(a.id, /^r_/, 'id 格式不变');
  const b = store.add({ chatKey: 'main', text: '一小时后提醒', dueAt: 1700000300000, createdBy: 'tool' });
  assert.deepEqual(store.pending('main').map((r) => r.id), [a.id, b.id], 'pending 按 dueAt 升序');
  assert.equal(store.due(1700000100000).length, 1, 'due 到点判定');
  assert.equal(store.markFired(a.id), true, 'markFired');
  assert.equal(store.pending('main').length, 1, '已触发不再 pending');
  const row = dbmod.getDb().prepare("SELECT k, v, updatedAt FROM kv WHERE k = 'reminders'").get();
  assert.ok(row, 'kv 行落库');
  const parsed = JSON.parse(String(row.v));
  assert.ok(Array.isArray(parsed.reminders) && parsed.reminders.length === 2, 'v = {reminders:[…]} 原文件形态');
  assert.ok(parsed.reminders[0].firedAt != null, 'firedAt 随 markFired 落容器');
  assert.ok(Number(row.updatedAt) > 0, 'updatedAt 有限');
  assert.equal(store.cancel(b.id), true, 'cancel');
  assert.equal(store.cancel('r_nope'), false, '取消不存在 → false');
  dbmod.closeDb();
  const store2 = new ReminderStore();
  assert.equal(store2.reminders.length, 1, '重开持久化（markFired/cancel 都落库）');
  assert.equal(store2.reminders[0].id, a.id, '重启读回同一条');
  assert.equal(store2.reminders[0].fired, true, 'fired 状态持久');
  dbmod.getDb().prepare("DELETE FROM kv WHERE k IN ('reminders', 'transition')").run();
});

test('kv T2：整容器 UPSERT 覆盖（save 幂等）+ kv 与 state 表互不串', () => {
  dbmod.getDb().prepare("DELETE FROM kv WHERE k = 'reminders'").run();
  const store = new ReminderStore();
  store.add({ chatKey: 'main', text: '第一条', dueAt: 1, createdBy: 't' });
  store.add({ chatKey: 'main', text: '第二条', dueAt: 2, createdBy: 't' });
  const n = dbmod.getDb().prepare('SELECT COUNT(*) AS n FROM kv').get().n;
  assert.equal(n, 1, '整容器 UPSERT：两次 save 仍一行（不追加行）');
  assert.equal(JSON.parse(dbmod.getDb().prepare("SELECT v FROM kv WHERE k = 'reminders'").get().v).reminders.length, 2, '容器内容覆盖为最新');
  assert.equal(dbmod.getDb().prepare("SELECT 1 FROM state WHERE key = 'reminders'").get(), undefined, 'reminders 不落 state 表（kv/state 各归各）');
  dbmod.getDb().prepare("DELETE FROM kv WHERE k = 'reminders'").run();
});

// ══════════ P01/P11/P12/P13/P14/P16/P21/P22 提示词整改（2026-11-20）══════════
group('P01/P11/P12/P13/P14/P16/P21/P22 提示词整改（2026-11-20）');

test('P01：主人标签走 ownerLabel（默认对方），旧存档 senderName=我 回落对方，不再出现 (owner)', () => {
  const lines = promptMod.buildTriggerBlock([
    { id: 1, mid: 1, ts: NOW, senderId: 'owner', senderName: '对方', text: '在吗', self: false },
    { id: 2, mid: 2, ts: NOW, senderId: 'owner', senderName: '我', text: '旧存档', self: false },
    { id: 3, mid: 3, ts: NOW, senderId: 'self', senderName: '我', text: '我在', self: true }
  ], { selfName: '汐' });
  assert.ok(lines.includes('对方：在吗'), '新消息主人标签=对方');
  assert.ok(lines.includes('对方：旧存档'), '旧存档 senderName=我 回落对方');
  assert.ok(!lines.includes('(owner)'), '不再渲染 (owner) 后缀');
  assert.ok(lines.includes('我：我在'), '她自己的发言仍是“我”');

  const saved = configMod.getConfig();
  configMod.setRuntimeConfig({ ...saved, persona: { ...saved.persona, ownerLabel: '对方({surface})' } });
  try {
    assert.equal(configMod.ownerLabelFor('web'), '对方(web)', '支持 {surface} 平台后缀');
    assert.equal(configMod.ownerLabelFor(''), '对方', '无 surface 时清掉空括号');
  } finally {
    configMod.setRuntimeConfig(saved);
  }
});

test('P21/P22：system 无安全规则、含中文思考/remember/工具诚实句；无 @；表情关闭时不提表情工具', () => {
  const saved = configMod.getConfig();
  assert.ok(!promptMod.buildSystemPrompt({}).includes('安全规则'), '安全规则段已删除');
  assert.ok(!promptMod.buildSystemPrompt({}).includes('@'), '@ 文案已清出');
  configMod.setRuntimeConfig({ ...saved, sticker: { ...(saved.sticker || {}), enabled: false } });
  try {
    const sys = promptMod.buildSystemPrompt({});
    assert.ok(sys.includes('思考和回复都用中文'), '中文思考');
    assert.ok(sys.includes('记住今天'), 'remember 使用说明');
    assert.ok(sys.includes('你只能通过工具做事'), '工具诚实句');
    assert.ok(!sys.includes('get_sticker_image'), '表情关闭时不提 get_sticker_image');
  } finally {
    configMod.setRuntimeConfig(saved);
  }
});

test('P11：lexicalFloor 默认 1.5——单字命中不召回，显式 minScore=0 可回退；标注文案统一', () => {
  const cards = [{ date: '2026-11-01', events: ['猫'] }];
  assert.equal(recallMod.retrieveFromCards('猫', cards).length, 0, '单字命中被下限滤掉');
  assert.equal(recallMod.retrieveFromCards('猫', cards, { minScore: 0 }).length, 1, '显式 0 可回退（bench/历史对照）');
  assert.equal(recallMod.RECALL_NOTE_LINE, '不必刻意提及，相关可提', '单一事实源');
});

test('P12：superseded fact 的旧向量不会从召回里复活（active key 白名单）', () => {
  const trigger = { id: 61, mid: 9601, ts: NOW, senderId: '10001', senderName: '星野', text: '在吗', self: false };
  const up = promptMod.buildUserPrompt({
    chatKey: 'private:10001', kind: 'private', chatId: '10001',
    triggerEntries: [trigger], store: { recent: () => [trigger] }, stickerEntries: [],
    session: { surface: 'web', startedAt: NOW }, promptAnchor: { prev: null },
    vectorHits: [{ kind: 'fact', key: 'cleanup:deleted', text: '不应出现的旧事实', score: 0.99 }]
  });
  assert.ok(!up.includes('【近期回忆】'), '唯一命中的是 superseded fact → 整段不注入');
  assert.ok(!up.includes('不应出现的旧事实'), '旧事实文本不出现');
});

test('P12/P13：记忆段分【长期事实】/【最近两天】/【今天记下的】，保留 entry 正文并带“不是台词”', () => {
  memory.writeCard({ date: '2026-12-01', entry: 'P13散文正文不应被删', events: [] });
  memory.upsertFact({ kind: 'like', subject: 'other', content: 'P12长期事实', mid: null });
  memory.remember({ text: 'P12今日暂存', mid: null });
  const out = promptMod.renderPersonMemorySection('web');
  assert.ok(out.includes('【长期事实】') && out.includes('P12长期事实'), '长期事实小节');
  assert.ok(out.includes('【最近两天】') && out.includes('P13散文正文不应被删'), '最近两天小节 + 完整 entry');
  assert.ok(out.includes('【今天记下的】') && out.includes('P12今日暂存'), '今天记下的小节');
  assert.ok(out.includes('不是要复述的台词'), '记忆不是台词');
});

test('P14：life.promptMode 缺省 off——聊天提示词不渲染【今日日程】', () => {
  assert.equal(configMod.getConfig().life.promptMode, 'off', '出厂默认 off');
  const trigger = { id: 41, mid: 9401, ts: NOW, senderId: '10001', senderName: '星野', text: '今天在忙什么', self: false };
  const up = promptMod.buildUserPrompt({
    chatKey: 'private:10001', kind: 'private', chatId: '10001',
    triggerEntries: [trigger], store: { recent: () => [trigger] }, stickerEntries: [],
    session: { surface: 'web', startedAt: NOW }, promptAnchor: { prev: null }
  });
  assert.ok(!up.includes('【今日日程】'), 'off 时整段缺席');
});

test('P16 接线：transitionText 落在【未读信息】之后、【当前时间】之前（尾部易变区）', () => {
  const trigger = { id: 51, mid: 9501, ts: NOW, senderId: '10001', senderName: '星野', text: '在吗', self: false };
  const up = promptMod.buildUserPrompt({
    chatKey: 'private:10001', kind: 'private', chatId: '10001',
    triggerEntries: [trigger], store: { recent: () => [trigger] }, stickerEntries: [],
    session: { surface: 'web', startedAt: NOW }, promptAnchor: { prev: null },
    transitionText: '【上一轮你想到一半的地方】\nP16接线上一条思考'
  });
  const iUnread = up.indexOf('【未读信息】');
  const iTrans = up.indexOf('【上一轮你想到一半的地方】');
  const iTime = up.indexOf('【当前时间】');
  assert.ok(iUnread > 0 && iTrans > iUnread && iTime > iTrans, 'transition 在未读之后、当前时间之前');
});

test('P16：transition 注入上一条已结束 session 的【深度思考】；当前会话排除、TTL 过期不注入、超长截断', async () => {
  const trans = await import('../src/transition.js');
  const now = Date.now();
  const index = [
    { id: 'cur', chatKey: 'main', status: 'running', startedAt: now, endedAt: null },
    { id: 'prev', chatKey: 'main', status: 'done', startedAt: now - 60000, endedAt: now - 30000 }
  ];
  const get = (id) => (id === 'prev'
    ? { messages: [{ role: 'assistant', content: `【深度思考】\n${'想'.repeat(600)}` }] }
    : null);
  const sec = trans.buildTransitionSection({ sessions: { index, get }, chatKey: 'main', currentSessionId: 'cur', now });
  assert.ok(sec.includes('【上一轮你想到一半的地方】'), '段头');
  assert.ok(sec.includes('后略'), '超长截断标注');
  assert.ok(sec.includes('用中文想'), '中文思考提示');

  const expired = trans.buildTransitionSection({
    sessions: {
      index: [{ id: 'prev2', chatKey: 'main', status: 'done', startedAt: now - 2 * 3600000, endedAt: now - 2 * 3600000 }],
      get: () => ({ messages: [{ role: 'assistant', content: '【深度思考】\nx' }] })
    },
    chatKey: 'main',
    currentSessionId: 'cur',
    now
  });
  assert.equal(expired, '', 'TTL 过期不注入');

  const currentOnly = trans.buildTransitionSection({ sessions: { index: [index[0]], get: () => null }, chatKey: 'main', currentSessionId: 'cur', now });
  assert.equal(currentOnly, '', '当前会话不注入');
});

for (const item of queue) {
  if (item.header !== undefined) {
    console.log(`\n── ${item.header} ──`);
    continue;
  }
  try {
    await item.fn();
    passed += 1;
    console.log(`  ok  ${item.name}`);
  } catch (err) {
    failures.push(item.name);
    console.error(`FAIL  ${item.name}`);
    console.error(`      ${err?.message ?? err}`);
  }
}

console.log(`\n[person-tests] ${passed} 通过，${failures.length} 失败（数据根 ${DATA_ROOT}，进程退出后自动作废）`);
if (failures.length) {
  console.error('[person-tests] 失败清单：');
  for (const f of failures) console.error(`  - ${f}`);
}
process.exitCode = failures.length ? 1 : 0;
