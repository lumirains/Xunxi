// 内核 · 钟（步骤⑤ / T5.1）—— 极简调度原语。
//
// 职责边界（v3 §0 词汇表「皮层唯一的钟」的落地件）：
//   · 钟只管"到点了吗 / 到点就跑"这一件事：registerTick 登记检查与动作，
//     心跳到点逐个问 check(now)，为真才跑 run()。
//   · 钟不含任何业务词表（B 类枢纽耦合上限的另一半：调度器触发词表 ≤10 条目，
//     这里是 0 条）—— check/run 由子系统（反思执行器等）提供，钟不认识它们。
//   · 心跳定时器 unref：不阻塞进程退出；stop() 只停心跳，不清登记
//     （重复 startHeartbeat 可原样续跑，登记方自己负责注销）。
//
// 本文件是前额叶的一部分（v3 §0：kernel/* 归前额叶）；禁止 import 身体模块
//（tools/check-boundaries.mjs 门禁覆盖 src/kernel/**）。

/** @typedef {{id: string, check: (now: number) => boolean, run: () => (void|Promise<void>)}} Tick */

/**
 * 创建一个钟实例。
 * @returns {{
 *   registerTick: (tick: Tick) => () => void,
 *   unregisterTick: (id: string) => boolean,
 *   listTicks: () => string[],
 *   fire: (now?: number) => Promise<number>,
 *   startHeartbeat: (intervalMs?: number) => void,
 *   stop: () => void,
 *   isBeating: () => boolean
 * }}
 */
export function createClock() {
  /** @type {Map<string, Tick>} */
  const ticks = new Map();
  let heartbeatTimer = null;
  let firing = false;            // 心跳重入闸：上一轮 run 还没跑完就跳过本轮（run 允许异步）

  function registerTick(tick) {
    if (!tick || typeof tick !== 'object') throw new Error('registerTick 需要 {id, check, run}');
    if (typeof tick.id !== 'string' || !tick.id.trim()) throw new Error('registerTick 的 id 必须是非空字符串');
    if (typeof tick.check !== 'function') throw new Error(`tick "${tick.id}" 缺 check(now)=>bool`);
    if (typeof tick.run !== 'function') throw new Error(`tick "${tick.id}" 缺 run()`);
    ticks.set(tick.id, { id: tick.id, check: tick.check, run: tick.run });
    return () => { ticks.delete(tick.id); };
  }

  function unregisterTick(id) {
    return ticks.delete(String(id));
  }

  /**
   * 跑一轮"到点检查 + 动作"。返回实际执行了 run() 的 tick 数。
   * 单个 tick 的 check/run 抛错只 console.warn，不影响其它 tick（钟不能被一个坏子系统拖死）。
   */
  async function fire(now = Date.now()) {
    if (firing) return 0;        // 上一轮未结束：本轮整体跳过（不排队，等下一个心跳）
    firing = true;
    let fired = 0;
    try {
      for (const tick of [...ticks.values()]) {
        let due = false;
        try {
          due = tick.check(now) === true;
        } catch (err) {
          console.warn(`[clock] tick "${tick.id}" check 出错:`, err?.message ?? err);
          continue;
        }
        if (!due) continue;
        fired += 1;
        try {
          await tick.run(now);
        } catch (err) {
          console.warn(`[clock] tick "${tick.id}" run 出错:`, err?.message ?? err);
        }
      }
    } finally {
      firing = false;
    }
    return fired;
  }

  function startHeartbeat(intervalMs = 60000) {
    stop();                       // 幂等：已在跳就先停旧的
    const ms = Math.max(1000, Number(intervalMs) || 60000);
    heartbeatTimer = setInterval(() => { fire().catch(() => {}); }, ms);
    heartbeatTimer.unref?.();     // 不阻塞进程退出（既有惯例，同 typingTimers/wakeTimers）
  }

  function stop() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function isBeating() {
    return heartbeatTimer !== null;
  }

  return { registerTick, unregisterTick, listTicks: () => [...ticks.keys()], fire, startHeartbeat, stop, isBeating };
}

// ── 进程级默认钟（步骤⑥交钟的落点）────────────────────────────────────────
// "皮层唯一的钟"（v3 §0/§1）的具体落法：orchestrator 的反思 tick 与各子系统
//（日记/日程子系统——步骤⑥ T6.2/T6.3 从 setTimeout 自续链交钟而来）
// 共用这一个实例。各开各的 createClock() 会让"唯一的钟"变成 N 个心跳；
// 所以这里给一个进程级单例，一律经 getDefaultClock() 取用、registerTick 登记。
let defaultClock = null;
export function getDefaultClock() {
  if (!defaultClock) defaultClock = createClock();
  return defaultClock;
}
