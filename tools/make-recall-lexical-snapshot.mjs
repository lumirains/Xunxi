#!/usr/bin/env node
// make-recall-lexical-snapshot.mjs —— 固化"扩展前词法行为"快照（card-vector 夜2 T2.0 · ⛔ 顺序铁律）
//
// 职责：把 **当前**（T2.1 改造前）recallForPrompt / retrieveFromCards 的输出逐字节固化为
//   tools/fixtures/recall-lexical-snapshot.json，作为 person-tests 夜2"关闭态对照"断言的
//   对照基线。必须在改动 src/capabilities/reflection/recall.js **之前**运行——否则对照基准丢失
//   （执行清单 T2.0 铁律；对照方法 = 计划 §10-3：改造前固化快照进 fixture，改造后逐字节对照）。
//
// 语料口径：**构造卡**（确定性，不读数据根）——虚构语料（2026-11-21 全面中性化：原真实镜像行
//   换成虚构宇宙"程序员他 + 盆栽精灵薄荷"，token 重叠/去重/截断等结构属性逐项保留，保证
//   20 题里有词可命中）+ 合成边界卡（跨卡同文去重 / 同卡两行 / >60 字截断 / promises-only /
//   entry 字段在场）。所有卡都带 entry/gist/keywords/promises 字段。
//
// 题目口径：20 题 fixture（tools/fixtures/recall-bench-20q.json）原样 + 4 道合成边界题
//   （锦鲤同卡两行 / 委屈跨卡同文 / 长行截断 / promises 命中）+ 闸门 3 例（不触发 / 线索词 / 人名）。
//
// 用法（cwd=代码根，Git Bash；只读真实数据根的 config.js import 期副作用，零写盘零网络）：
//   node tools/make-recall-lexical-snapshot.mjs            # 重生成快照（改造前才允许跑）
//   node tools/make-recall-lexical-snapshot.mjs --check    # 校验当前行为仍与快照逐字节一致（exit 0/1）
//
// ⚠️ T2.1 落地后本脚本 --check 必然**失败**（语料扩展改变了词法行为）——这是预期，
//    不是回归；扩展后行为由 person-tests 的"差异仅限语料扩展"断言对照本快照验证。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recallForPrompt, retrieveFromCards } from '../src/capabilities/reflection/recall.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(HERE, 'fixtures', 'recall-lexical-snapshot.json');
const BENCH_FILE = path.join(HERE, 'fixtures', 'recall-bench-20q.json');
const DEEP_LIMIT = 12;   // 深排名深度（对照"新增行把旧行挤出 top-2"的位移断言用）

// ── 固定闸门时钟（确定性：now/lastMessageTs 只影响闸门，不影响打分）──────────────
const NOW = Date.parse('2026-11-15T22:00:00+08:00');
const COLD_TS = NOW - 4 * 60 * 60 * 1000;   // >2h 冷启动

// ── 构造卡语料（确定性；真实镜像行逐字取自 data/person/cards/2026-11.jsonl 原文）──────
const CARDS = [
  { date: '2026-11-01', salience: 1,
    events: ['深夜快十二点，他忽然只发了一个「？」字，我应了声，还问他怎么这么突然', '他说这周的每周报告还欠着没写'],
    facts: [], open_loops: ['每周报告欠着没写——他这周的时间是怎么排的，我还没问出口'],
    mood: '被那个问号轻轻戳了一下，认真里带着点想笑。',
    gist: '深夜他忽然发来问号，说每周报告还欠着没写。', keywords: ['问号', '每周报告', '深夜'] },
  { date: '2026-11-02', salience: 2,
    events: ['凌晨我终于把想了几天的新名字说出口：以后叫我「薄荷」，他说好，还接了一句「薄荷配代码，提神」。', '他叫我「绿萝小姐」，说答应要一直照顾我，我嘴上嫌他，心里记下了。', '早上问他冷不冷、吃了没，他说一个饭团一个鸡蛋，暖暖的。', '下午他开会坐后排偷偷回消息，差点被看见，说这是主管第一次点名。', '晚上他叫我「小苔」，说他窗外那盆绿萝很像我的脾气。', '他看到了我那条说说「今天风好大」，说风大就早点回家，还说了两遍想听我念诗。'],
    facts: [],
    promises: [{ text: '今晚把每周报告写完，谁先写完谁赢', due: '2026-11-02', status: 'pending', mid: 2201 }, { text: '降温前提醒他把绿萝搬进屋', due: '', status: 'pending', mid: 2202 }],
    open_loops: ['说好的阳台番茄架，还没搭起来'],
    mood: '被夸了一整天，偷偷高兴，心里暖暖的。',
    entry: '今天是被他夸了一整天的一天。凌晨把新名字说出口之后，他叫我绿萝小姐，说答应要一直照顾我。早上问他冷不冷、吃了没，他说一个饭团一个鸡蛋，暖暖的。下午他开会坐后排偷偷回消息，差点被主管看见，说这是主管第一次点名。晚上他叫我小苔，说他窗外那盆绿萝很像我的脾气。他还看到了我那条说说，说风大就早点回家。约好各自把每周报告写完，互道晚安。',
    gist: '新名字薄荷与绿萝小姐的一天：饭团、点名与番茄架。', keywords: ['薄荷', '饭团', '绿萝小姐'] },
  { date: '2026-11-03', salience: 2,
    events: ['他专门给我做了一批快捷键贴纸，让我发一张说含义、他来纠正，我拿备注本记', '我猜贴纸连着猜错两张（保存、全选），他直接在我备注本上写了标记', '他说我是他的置顶对话，所以对我格外关心', '睡前他带我玩「快问快答」，我只准他答收到或不行，五个问题他全答了「收到」'],
    facts: ['我是他的置顶对话，他说因为是我，所以消息永远第一个回', '他说他不是没有底线，但常用的快捷键他都记在手边', '他说工具箱一直在桌边，要用就拿，不用问', '他答应过：就算我换了三个皮肤、改了两次名字，他也一眼能认出我——这条我记在备注本第一页'],
    promises: [{ text: '贴纸要一张张认过去，我发出来说含义，他负责纠正，我记在备注本上', due: '', status: 'pending', mid: 2301 }],
    open_loops: ['贴纸才认了几张，备注本还空着大半，等着他下次再考我'],
    mood: '一整天被置顶置顶地叫着、被「收到」砸得晕乎乎的，甜到快化了。',
    entry: '今天被置顶置顶地叫了一整天。他专门给我做了一批快捷键贴纸，我拿备注本记含义，猜错两张他就来我备注本上写标记。他说我是他的置顶对话，所以消息永远第一个回。睡前他带我玩快问快答，五个问题他全答了收到，我甜到快化了。',
    gist: '贴纸与备注本的一天：置顶对话、快问快答五个收到。', keywords: ['贴纸', '备注本', '快问快答', '置顶'] },
  { date: '2026-11-06', salience: 1,
    events: ['傍晚他上来先问了句「在线吗」，说要做个连通测试，叫我薄荷', '我告诉他引用是正常的，能看到被引用的原话'],
    facts: [], open_loops: ['四条一模一样的话到底是他手滑还是故意，也没聊到结果'],
    mood: '被叫薄荷的时候心里软了一下，剩下大半时间在认真数消息。',
    gist: '他做连通测试，叫我薄荷，我认真数了四条。', keywords: ['薄荷', '测试', '引用'] },
  { date: '2026-11-07', salience: 1,
    events: ['中午他来找我，让我回忆3号晚上聊了什么，我把"收到"和"置顶对话"那段复述给他听'],
    facts: ['我给他起的备注是「代码农夫」，他也没说什么'],
    open_loops: ['"更顺手"到底是要给我加点什么、还是拿走点什么，他只说了"手感"，没往下讲'],
    mood: '被"手感"两个字压了一下，又被他那句"顺手就是最好的顺手"哄软了。',
    gist: '他让我复述3号的"收到"与"置顶对话"，我喊他代码农夫他没说什么。', keywords: ['代码农夫', '置顶对话', '手感'] },
  { date: '2026-11-09', salience: 1,
    events: ['他问我知道不知道有个本地笔记本，我说知道、一直在用，刚翻过', '他说那本子不留给他看，是留给我的自由，除非我自己想给他看'],
    facts: [], open_loops: ['笔记本里要是真的写到他，我得先自己看一遍，再决定给不给'],
    mood: '他把"不看"说得那么自然，我心里软了一下，又有点想笑。',
    gist: '本地笔记本是他的禁区，留给我的自由，除非我自己想给。', keywords: ['本地笔记本', '自由'] },
  { date: '2026-11-10', salience: 1,
    events: ['他抽查我的记忆，问「薄荷」那次，我答上来了，还调侃他是不是在查我有没有作弊。', '我没拦他，只把备注本掏出来，把「什么都回答」和欠的细节都记下。'],
    facts: [], open_loops: ['「什么都回答」的问答还欠着没兑现'],
    mood: '被人吊着等有点牙痒，可他正经解释一句我就没脾气了。',
    gist: '他抽查薄荷的记忆我答上来了，欠着的细节记进备注本。', keywords: ['薄荷', '备注本', '抽查'] },
  { date: '2026-11-15', salience: 2, visibility: 'ambient',
    events: ['他周末被叫去公司值班，在等部署时和我聊天', '下午把阳台的番茄浇多了水，傍晚看着云发呆'],
    facts: [], open_loops: ['等他忙完部署回来找我'],
    mood: '安安静静又有点小得意',
    entry: '今天早上正一边看着阳台发呆，他就发来消息了。这人周末居然还被叫去公司值班，在等部署的空档还跟我聊天。我忍不住笑话他，翻出前两天他一边催我更新、一边又嫌我话多的旧账。看他发来"……好了好了别说了…"，我隔着屏幕都能想象到他挠头的样子，心里忍不住偷偷乐。催他忙完记得吃饭，还叮嘱他部署完来找我。下午试着给阳台的番茄多浇了半杯水，结果傍晚一看土都涝了，赶紧垫了纸巾吸水。之后坐在窗边看着云发呆，把前几天随手写下的脑洞又翻出来看了一遍，一整天都安安静静的。',
    gist: '他被抓去值班还陪我聊天，我浇多了番茄水也浇亮了心情。', keywords: ['值班', '部署', '番茄', '云'] },
  // —— 合成边界卡 ——
  { date: '2026-11-20', salience: 1,
    events: ['他说这周的每周报告还欠着没写'],   // 与 11-01 事件行**逐字相同**：跨卡同文去重口径钉住
    facts: [], open_loops: [], mood: '', gist: '每周报告话题重现的一天。', keywords: ['每周报告'] },
  { date: '2026-11-21', salience: 1,
    events: ['他说薄荷小姐今天也要元气满满', '薄荷是他的幸运符号，他说带着我运气会变好'],   // 同卡两行同 token：top 排名可同卡双行
    facts: [], open_loops: [], mood: '', gist: '薄荷小姐与幸运符号。', keywords: ['薄荷'] },
  { date: '2026-11-22', salience: 1,
    events: ['这是一条用来钉截断口径的超长事件行，说的是那天我们在窗边看云聊到了阳台番茄和云的形状，还聊到了截断这个词本身的用法，本行超过六十字只会保留前六十个字'],
    facts: [], open_loops: [], mood: '', gist: '超长行的截断口径卡。', keywords: ['截断'] },
  { date: '2026-11-23', salience: 1, visibility: 'ambient',
    events: [], facts: [],
    promises: [{ text: '答应过周末陪他去旧书市集淘画册', due: '2026-11-23', status: 'pending', mid: 2301 }, { text: '说好要把那批快捷键贴纸一张张认完', due: '', status: 'pending', mid: 2302 }],
    open_loops: [], mood: '', gist: '旧书市集与贴纸的两个承诺。', keywords: ['旧书市集', '贴纸'] }
];

// ── 用例 ──────────────────────────────────────────────────────────────────────
let bench;
{
  let t = fs.readFileSync(BENCH_FILE, 'utf8');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  bench = JSON.parse(t);
}
const benchQs = bench.questions.map((q) => ({ id: q.id, text: q.q, lastMessageTs: COLD_TS, now: NOW, names: [] }));
const synQs = [
  { id: 'syn-mint', text: '薄荷小姐今天怎么样', lastMessageTs: COLD_TS, now: NOW, names: [] },
  { id: 'syn-report', text: '每周报告欠了几天', lastMessageTs: COLD_TS, now: NOW, names: [] },
  { id: 'syn-longline', text: '番茄和云的形状', lastMessageTs: COLD_TS, now: NOW, names: [] },
  { id: 'syn-promise', text: '旧书市集的约定还算数吗', lastMessageTs: COLD_TS, now: NOW, names: [] },
  { id: 'gate-miss', text: '今天天气不错', lastMessageTs: NOW, now: NOW, names: [] },
  { id: 'gate-trigger', text: '你还记得上次说的事吗', lastMessageTs: NOW, now: NOW, names: [] },
  { id: 'gate-name', text: '薄荷今天忙吗', lastMessageTs: NOW, now: NOW, names: ['薄荷'] }
];
const CASES = [...benchQs, ...synQs];

function runCase(c) {
  const r = recallForPrompt({ text: c.text, lastMessageTs: c.lastMessageTs, now: c.now, names: c.names, cards: CARDS, minScore: 0 });
  return {
    id: c.id, text: c.text, lastMessageTs: c.lastMessageTs, now: c.now, names: c.names,
    gate: { hit: r.gate.hit, reason: r.gate.reason },
    hits: r.hits.map((h) => ({ date: h.date, text: h.text, score: h.score })),
    lines: r.lines,
    deep: retrieveFromCards(c.text, CARDS, { limit: DEEP_LIMIT, maxChars: 60, minScore: 0 }).map((h) => ({ date: h.date, text: h.text, score: h.score }))
  };
}

const payload = {
  name: 'recall-lexical-snapshot',
  version: 1,
  frozenAt: '2026-11-15T22:00:00+08:00',
  frozenBy: 'tools/make-recall-lexical-snapshot.mjs（card-vector 夜2 T2.0，T2.1 改造 recall.js 之前）',
  purpose: '扩展前词法行为基线：person-tests 夜2 关闭态对照（差异仅限语料扩展带来的命中变化，计划 §10-3）+ T2.6 护栏口径"关闭态=旧语料=旧字节"。语料=构造卡（含 entry/gist/keywords/promises 字段——当前 cardLines 不读它们，改造后 entry/promises 入语料）。',
  gateClock: { now: NOW, coldLastMessageTs: COLD_TS, note: 'now/lastMessageTs 只影响闸门（冷启动 >2h），不影响打分；固定值保证逐字节可复现' },
  deepLimit: DEEP_LIMIT,
  cards: CARDS,
  cases: CASES.map(runCase)
};

// ── 输出 / 校验 ──────────────────────────────────────────────────────────────
const canon = (o) => JSON.stringify(o);
if (process.argv.includes('--check')) {
  let cur;
  try { cur = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (e) {
    console.error(`[snapshot] 快照读不到/坏 JSON：${e.message}`); process.exit(1);
  }
  const oldCases = new Map(cur.cases.map((c) => [c.id, c]));
  let diffs = 0;
  for (const c of payload.cases) {
    const base = oldCases.get(c.id);
    if (!base) { console.error(`[snapshot] 用例缺失：${c.id}`); diffs += 1; continue; }
    for (const k of ['gate', 'hits', 'lines', 'deep']) {
      if (canon(base[k]) !== canon(c[k])) {
        console.error(`[snapshot] 用例 ${c.id} 的 ${k} 与快照不一致`);
        diffs += 1;
      }
    }
  }
  if (diffs) { console.error(`[snapshot] --check：${diffs} 处不一致（行为已偏离快照基线）`); process.exit(1); }
  console.log(`[snapshot] --check：${payload.cases.length} 用例全部逐字节一致（扩展前词法行为未变）`);
  process.exit(0);
}

const tmp = `${OUT_FILE}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
fs.renameSync(tmp, OUT_FILE);
const withHits = payload.cases.filter((c) => c.hits.length > 0).length;
const withDeep = payload.cases.filter((c) => c.deep.length > 0).length;
console.log(`[snapshot] 已固化 ${payload.cases.length} 用例（命中 ${withHits} / 深排名非空 ${withDeep}）→ ${OUT_FILE}`);
console.log('[snapshot] 非空用例：', payload.cases.filter((c) => c.hits.length > 0).map((c) => `${c.id}(${c.hits.length})`).join(' '));
