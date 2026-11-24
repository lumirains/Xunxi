// 语音切句器纯函数测试（S8 · V2 准备②；内部文档 asr-tts-v2-execution-spec.md §2.2 R1-R7 全覆盖）。
// 只测纯函数，零网络零数据根零引擎；另断言 split.js 的 import 图（零 import——
// src/voice/ 不在 check-boundaries 扫描面，§7.3 纪律由本测试承担）。
//
// 全局不变式（每条用例都验）：段拼接 === 输入（逐字节，R7 保序不丢字不改写）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitForSpeech as split } from '../src/voice/split.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

/** 用例跑分 + 全局不变式（非空结果必须逐字节还原输入）。 */
function run(input, opts) {
  const segs = split(input, opts);
  const joined = segs.map((s) => s.text).join('');
  assert.equal(joined, input, `R7 逐字节还原破坏：${JSON.stringify(segs)}`);
  return segs;
}
const texts = (segs) => segs.map((s) => s.text);

// ── R1 强切点 ──────────────────────────────────────────────────────────────
test('R1 中文强切点 。！？； 各自成段（末段 <8 并回前段=R6）', () => {
  assert.deepEqual(texts(run('今天。明天！真的吗？好吧；')), ['今天。', '明天！', '真的吗？好吧；']);
  assert.deepEqual(texts(run('今天。明天！真的吗？好吧；就这样定了呀。')), ['今天。', '明天！', '真的吗？', '好吧；就这样定了呀。']);
});
test('R1 ASCII 强切点 .!?; 与换行（R6 只并末段）', () => {
  assert.deepEqual(texts(run('hi! how are you? fine; ok.\nnext')), ['hi!', ' how are you?', ' fine;', ' ok.\nnext']);
  // 换行是强切点：第一行独立成段（换行符随左段 flush；第二行 ≥8 字免 R6 并段，才能看到切痕）
  assert.deepEqual(texts(run('第一行\n第二行的内容比较长一些呀')), ['第一行\n', '第二行的内容比较长一些呀']);
});
test('R1 省略号连续（……）并入前段不产生空段', () => {
  const segs = run('我想想……好吧。就这么定了。');
  assert.deepEqual(texts(segs), ['我想想……', '好吧。就这么定了。']);
});

// ── R2 弱切点 ──────────────────────────────────────────────────────────────
test('R2 缓冲 ≤18 字的逗号不切（R3 已让位后的段内逗号）', () => {
  const segs = run('你好。今天天气真好，我们出去走走吧。');
  assert.deepEqual(texts(segs), ['你好。', '今天天气真好，我们出去走走吧。']);
});
test('R2 缓冲 >18 字的逗号切（标点随左段）', () => {
  const segs = run('你好。今天天气真好呀我们一起出去走走逛逛看看，风景很好呀心情也不错。');
  assert.deepEqual(texts(segs), ['你好。', '今天天气真好呀我们一起出去走走逛逛看看，', '风景很好呀心情也不错。']);
});
test('R2 顿号 、 与半角逗号 , 同为弱切点', () => {
  const segs = run('一二三四五六七八九十一二三四五六七、甲乙丙丁戊己庚辛壬');
  assert.equal(segs.length, 2);
  const segs2 = run('aaaa,bbbb,cccc,dddd,eeee,ffff,gggg,hhhh,iiii,jjjj,kkkk,llll');
  assert.ok(segs2.length >= 2);
});
test('R2 数字千分位 1,234,567 不切', () => {
  const segs = run('这个数字是1,234,567。记得帮我记一下账好吗。');
  assert.deepEqual(texts(segs), ['这个数字是1,234,567。', '记得帮我记一下账好吗。']);
});

// ── R3 首句特判 ────────────────────────────────────────────────────────────
test('R3 首段达 15 字：优先窗口内最近的逗号切', () => {
  const segs = run('今天天气真好呀，我们一起出去走走逛逛看看风景放松放松心情。');
  assert.deepEqual(texts(segs), ['今天天气真好呀，', '我们一起出去走走逛逛看看风景放松放松心情。']);
});
test('R3 无逗号：硬切 15 字', () => {
  const segs = run('今天天气真好我们一起出去走走逛逛看看风景放松放松心情');
  assert.equal(texts(segs)[0].length, 15);
  assert.equal(segs.length, 2);
});
test('R3 首段 15 字内自然强切则规则让位（首段=自然段）', () => {
  const segs = run('你好。我们一起出去走走逛逛看看风景放松放松心情好不好呀。');
  assert.equal(texts(segs)[0], '你好。');
});

// ── R4 强制切 ──────────────────────────────────────────────────────────────
test('R4 缓冲 >25 无标点无空格无连词：硬切 20 字', () => {
  // 首段 R3 切 15；余段 30 字在 26 字处硬切 20，剩 10 字（≥8 不并）
  const segs = run('一二三四五六七八九十一二三四五甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥甲乙丙丁戊己');
  assert.deepEqual(segs.map((s) => s.text.length), [15, 20, 8]);
});
test('R4 优先最近空格（空格随左段）', () => {
  const segs = run('aaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbb cccccccc');
  assert.equal(segs.length, 3);
  assert.ok(texts(segs)[1].endsWith(' '), `左段应含空格结尾：${JSON.stringify(texts(segs))}`);
});
test('R4 优先最近连词（切在连词前，连词归下一段）', () => {
  const segs = run('一二三四五六七八九十一二三四五甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未但是申酉戌亥甲乙丙丁戊己庚辛');
  assert.equal(segs.length, 3);
  assert.ok(texts(segs)[2].startsWith('但是'), `连词应归下一段开头：${JSON.stringify(texts(segs))}`);
});

// ── R5 不切 ────────────────────────────────────────────────────────────────
test('R5 引号内弱切点不切（缓冲 >18 也不切）', () => {
  const segs = run('他说「这是一段很长很长很长很长的引号内容，你看怎么切」然后就好了。');
  assert.equal(segs.length, 1);
});
test('R5 引号对被切点撕开时右移到闭引号后（引号段原子）', () => {
  const segs = run('他说「好，行」然后我们就一起出发了马上就走');
  assert.deepEqual(texts(segs), ['他说「好，行」', '然后我们就一起出发了马上就走']);
});
test('R5 直引号 " 配对同样原子（撇号不参与配对）', () => {
  const segs = run('他说"今天不去，明天见"然后走了啊走得特别快');
  assert.deepEqual(texts(segs), ['他说"今天不去，明天见"', '然后走了啊走得特别快']);
  const segs2 = run("it's fine. ok then. good luck with that my friend");
  assert.ok(segs2.length >= 2, `撇号不应把全文锁进引号：${JSON.stringify(texts(segs2))}`);
});
test('R5 小数点不切', () => {
  const segs = run('版本号是2.6。这一版的改动特别多需要慢慢说。');
  assert.deepEqual(texts(segs), ['版本号是2.6。', '这一版的改动特别多需要慢慢说。']);
});
test('R5 英文缩写 Mr. / e.g. / etc. 不切', () => {
  const segs = run('他是Mr.Wang。这样的写法比如e.g.这样用。整体还是很好懂的样子呀。');
  assert.ok(texts(segs)[0].includes('Mr.Wang'));
  assert.ok(texts(segs)[1].includes('e.g.这样'));
});
test('R5 硬切不撕数字串（切点右移到数字串末尾）', () => {
  const segs = run('验证码是86152530358979001234请查收一下然后回我一条消息就行', { firstMax: 20, hardCut: 20 });
  for (const s of texts(segs)) {
    assert.ok(!/^\d+$/.test(s) || s.length >= 20, `数字串被撕开：${JSON.stringify(texts(segs))}`);
  }
  assert.ok(texts(segs).join('').includes('86152530358979001234'), '数字串必须完整保留在同一序位');
});

// ── R6 尾句合并 ────────────────────────────────────────────────────────────
test('R6 末段 <8 字并入前段（"嗯。"不单独合成）', () => {
  const segs = run('今天天气真好。嗯。');
  assert.deepEqual(texts(segs), ['今天天气真好。嗯。']);
});
test('R6 末段恰 8 字不并（<8 才并）', () => {
  const segs = run('今天天气真好。一二三四五六七八。');
  assert.deepEqual(texts(segs), ['今天天气真好。', '一二三四五六七八。']);
});
test('R6 单段不并', () => {
  const segs = run('嗯。');
  assert.deepEqual(texts(segs), ['嗯。']);
});

// ── R7 / 形状 / 边界 ───────────────────────────────────────────────────────
test('输出形状：{index,text,isFirst}，index 连续，isFirst=index===0', () => {
  const segs = run('今天。明天！后天？大后天。');
  segs.forEach((s, i) => {
    assert.deepEqual(Object.keys(s), ['index', 'text', 'isFirst']);
    assert.equal(s.index, i);
    assert.equal(s.isFirst, i === 0);
  });
});
test('边界：空串/纯空白/纯标点/无实词 → []', () => {
  assert.deepEqual(split(''), []);
  assert.deepEqual(split('   '), []);
  assert.deepEqual(split('。'), []);
  assert.deepEqual(split('！！……'), []);
  assert.deepEqual(split('……'), []);
  assert.deepEqual(split('……，'), []);
  assert.deepEqual(split(null), []);
  assert.deepEqual(split(undefined), []);
  assert.deepEqual(split(123), []);
});
test('边界：单字/单词一段且 isFirst', () => {
  const segs = run('嗯');
  assert.deepEqual(segs, [{ index: 0, text: '嗯', isFirst: true }]);
});
test('边界：前导标点/空白不丢字（回贴下段或并前段）', () => {
  run('你好。 \n 今天。');           // 全局不变式（逐字节还原）已在 run 内断言
  run('……今天天气真的很好我们一起出去走走看看吧。');
  run('。。今天。明天。');
});
test('不变式：混合语料全量逐字节还原（多场景轮询）', () => {
  const corpus = [
    '在吗？我在弄语音那块，卡了好几天，有点烦躁。',
    '喂，听得到吗？……听不清，你说什么？',
    '版本号是2.6。今天先上线，Mr.Wang 说 e.g. 这种写法可以，1,234,567 这个数别动。',
    '好「那我们」就这样，说完就睡。晚安！',
    '嗯，我在呢。怎么了，这么晚打电话，出什么事了吗？没事就早点休息呀。',
  ];
  for (const t of corpus) run(t);
});
test('import 图：split.js 零 import（src/voice 不入 boundary 扫描面，纪律由本测试承担）', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'voice', 'split.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'split.js 必须零 import（纯函数，规格 §2.2）');
});

console.log(`\n[voice-split-test] ${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
