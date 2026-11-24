// context-budget 纯函数测试（Q15 收编）。
// 只测纯变换，不碰真实数据根、不发请求。
import assert from 'node:assert/strict';
import {
  DEFAULTS, trimHistory, trimToolDescriptions, trimToolResult
} from '../src/context-budget.js';

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

const conf = (over = {}) => ({ ...DEFAULTS, ...over });

test('trimHistory：system / 末条 / tool / 带 tool_calls 的 assistant 不删', () => {
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'early-1 '.repeat(60) },
    { role: 'assistant', content: 'early-2 '.repeat(60), tool_calls: [{ id: 'c1' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'tool-result' },
    { role: 'user', content: 'early-3 '.repeat(60) },
    { role: 'user', content: 'recent-1' },
    { role: 'assistant', content: 'recent-2' },
    { role: 'user', content: 'last' }
  ];
  trimHistory(messages, conf({ keepRecentMessages: 3, maxDigestChars: 200 }));
  assert.equal(messages[0].role, 'system');
  assert.ok(messages.some((m) => m.role === 'tool'), 'tool 消息必须保留');
  assert.ok(messages.some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length), 'tool_calls assistant 必须保留');
  assert.equal(messages[messages.length - 1].content, 'last');
  assert.ok(messages.length < 8, '应该裁掉一些早期消息');
});

test('trimHistory：早期长消息压成摘要', () => {
  const early = [];
  for (let i = 0; i < 8; i += 1) early.push({ role: 'user', content: `early-${i} `.repeat(80) });
  const messages = [
    { role: 'system', content: 'S' },
    ...early,
    { role: 'user', content: 'recent-1' },
    { role: 'assistant', content: 'recent-2' },
    { role: 'user', content: 'recent-3' },
    { role: 'user', content: 'last' }
  ];
  trimHistory(messages, conf({ keepRecentMessages: 4, maxDigestChars: 200 }));
  assert.ok(messages.length < 13, '应裁掉早期消息');
  assert.ok(messages.some((m) => String(m.content).includes('较早对话摘要')), '应有摘要');
});

test('trimHistory：off 模式完全不动', () => {
  const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'u1' }, { role: 'user', content: 'u2' }];
  const before = JSON.stringify(messages);
  trimHistory(messages, conf({ historyMode: 'off', keepRecentMessages: 4 }));
  assert.equal(JSON.stringify(messages), before);
});

test('trimHistory：短会话不动', () => {
  const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'u1' }];
  trimHistory(messages, conf({ keepRecentMessages: 10 }));
  assert.equal(messages.length, 2);
});

test('trimToolDescriptions：只清空白/空行，不删工具、不改参数', () => {
  const body = {
    tools: [{
      type: 'function',
      function: {
        name: 'demo',
        description: 'line1\n\n\nline2   with   spaces',
        parameters: { type: 'object', properties: { a: { type: 'string' } } }
      }
    }]
  };
  trimToolDescriptions(body, conf());
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].function.name, 'demo');
  assert.ok(!body.tools[0].function.description.includes('\n\n'));
  assert.deepEqual(body.tools[0].function.parameters, { type: 'object', properties: { a: { type: 'string' } } });
});

test('trimToolDescriptions：trimToolDescriptions=false 不动', () => {
  const body = { tools: [{ function: { name: 'x', description: 'a\n\n\nb' } }] };
  trimToolDescriptions(body, conf({ trimToolDescriptions: false }));
  assert.equal(body.tools[0].function.description, 'a\n\n\nb');
});

test('trimToolResult：只截文本并标注省略字数', () => {
  const result = { content: 'x'.repeat(600) };
  trimToolResult(result, conf({ maxToolResultChars: 500 }));
  assert.ok(result.content.length <= 520);
  assert.ok(result.content.includes('已省略'));
});

test('trimToolResult：parts 数组（图片/视频）不碰', () => {
  const result = { content: [{ type: 'text', text: 'x'.repeat(600) }, { type: 'image_url', image_url: { url: 'data:' } }] };
  const before = JSON.stringify(result);
  trimToolResult(result, conf({ maxToolResultChars: 10 }));
  assert.equal(JSON.stringify(result), before);
});

console.log(`\n[context-budget-test] ${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
