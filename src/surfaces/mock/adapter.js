// Mock 身体 · adapter（Phase 8a 测试件）。
// 用途（草案 §5"Phase 8 前若需要模拟启停，用 mock 身体"；v2 清单 §6 验收
// "mock 身体下 call 返回 {}，平台工具在 mock 下返回不支持而不是崩溃"）：
// 不启动协议端、不碰网络就能跑工具循环 —— emit 只把 intent 登记进内存数组，
// 供测试经 getIntents() 断言"只产生 intent、零网络"。
// 能力（T8a 规格）：canText:true 其余全 false —— 只能"发文字意图"，别的一概不支持。
// 零依赖、零网络、零定时器、零落盘：纯内存，进程结束即消失。

export function createMockAdapter() {
  const intents = [];

  return {
    surface: 'mock',

    /** 能力握手：canText 以外全关（T8a 规格）。maxTextLength 0 = 不设限（无消费方，仅登记）。 */
    capabilities() {
      return {
        surface: 'mock',
        canText: true,
        canVoice: false,
        canSticker: false,
        canImage: false,
        canAnimate: false,
        canTyping: false,
        maxTextLength: 0,
        supportsReply: false
      };
    },

    /** 只登记，不发送。恒返回 {ok:true, messageId:null}：mock 永远"登记成功、没有 mid"。 */
    async emit(intent) {
      intents.push(intent);
      return { ok: true, messageId: null };
    },

    /** 读回恒空对象（草案 §4 规则 4）：平台工具必须容忍空读回，而不是崩溃。 */
    async call() {
      return {};
    },

    /** 测试断言用：已登记 intent 的浅拷贝快照（外部拿不到内部数组引用）。 */
    getIntents() {
      return [...intents];
    }
  };
}
