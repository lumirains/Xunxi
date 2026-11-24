// 内核事件日志：data/events.jsonl，一行一条 JSON，纯追加（原清单 §6 / 细化清单 T2.3）。
// 职责只有写入、读取、按时间过滤；不做聚合、不调模型、不建定时器、不预读进内存。
// events.jsonl 的唯一写者就是本模块。
// append 全程吞错（只 console.warn）：事件失败绝不能影响聊天主链路。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 创建一个事件日志实例。
 * @param {string} filePath events.jsonl 的绝对路径
 * @returns {{ append: Function, since: Function, onAppend: Function, path: string }}
 */
export function createEventLog(filePath) {
  // Phase 9 M2（15f）：追加后监听器（SSE 桥用）。纯通知，不改写路径语义：
  // 只在 appendFileSync 成功后调用；监听器抛错吞掉——事件落盘绝不能被 UI 拖挂。
  const appendListeners = new Set();

  /**
   * 注册追加监听器。返回退订函数。
   * @param {(event: object) => void} fn
   */
  function onAppend(fn) {
    if (typeof fn !== 'function') return () => {};
    appendListeners.add(fn);
    return () => appendListeners.delete(fn);
  }

  // ── E2（夜间交接计划 Q1）：seq 单调计数器 ─────────────────────────
  // 模块（实例）内单调计数器：null = 未初始化；首次 append 时读现有文件行数作为
  // 初值（= 进程启动语义：文件里已有 N 条 → 本进程第一条 seq=N+1），此后每条 +1。
  // 只增不重置：appendFileSync 纯追加语义保持，跨重启续号；读侧（since / 前端）
  // 按 JSON 字段读，对缺 seq 的历史行宽容。
  // 注意：写盘失败时计数器仍已前进（下一条跳号）——单调性不受影响，绝不回退。
  let seqCounter = null;
  const countLines = () => {
    try {
      const buf = fs.readFileSync(filePath);
      let n = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
      if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) n++;   // 末行无换行符也计一条
      return n;
    } catch {
      return 0;   // 文件不存在（首次落盘前）等读取失败：从 0 起步，第一条 seq=1
    }
  };

  /**
   * 追加一条事件。字段缺省时补默认值，另补 ts: Date.now()。
   * 整体 try/catch：失败只 console.warn，绝不向上抛。
   *
   * E2 字段落位（夜间交接计划 Q1）：surface / seq **总是落盘**——
   *   · surface：事件归属的身体面（'web' / 反射按语境）。缺省空串 ''，
   *     由调用方显式传（不给缺省身体——缺省值会污染非身体事件）。
   *   · seq：单调计数器（见上方 seqCounter），跨重启按文件行数续号。
   * 历史行（无 surface/seq）读侧宽容；channel/visibility/conversationId 仍按
   * Phase 8b 规则：三个都不传 = 不落这三个字段（输出除 surface/seq 外不变），
   * 任一显式传入时三个一起落盘，缺的按缺省补齐
   * （channel '' / visibility 'shared' / conversationId ''；channel 缺省原为旧
   *   身体名，Q14 终审改为空串——该分支当前零调用方，属死路径缺省对齐）。
   * visibility 只落字段、不做过滤逻辑（D20：单一消费者时不做通用机制）。
   */
  function append({ source, kind, valence = 0, impact = 0, text = '', ref = '', channel, visibility, conversationId, surface = '' } = {}) {
    try {
      if (seqCounter === null) seqCounter = countLines();
      seqCounter += 1;
      const event = { source, kind, surface, seq: seqCounter, valence, impact, text, ref, ts: Date.now() };
      if (channel !== undefined || visibility !== undefined || conversationId !== undefined) {
        event.channel = channel ?? '';
        event.visibility = visibility ?? 'shared';
        event.conversationId = conversationId ?? '';
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });   // recursive：目录已存在时是幂等空操作
      fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
      // 落盘成功才通知（Phase 9 M2：SSE 桥往前端推 kernel-event）；监听器异常不影响主链路
      for (const fn of appendListeners) {
        try { fn(event); } catch { /* 通知失败与日志无关 */ }
      }
    } catch (err) {
      console.warn('[events] append failed', err?.message ?? err);
    }
  }

  /**
   * 读取 ts >= sinceTs 的事件，按 ts 升序，最多 limit 条。
   * 文件不存在返回 []；坏行（非合法 JSON）跳过；容忍 BOM。
   */
  function since(sinceTs, { limit = 500 } = {}) {
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      return [];   // 文件不存在（首次启动前）等读取失败：视为没有事件
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // 剥 BOM
    const matched = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t);
        if (e && e.ts >= sinceTs) matched.push(e);
      } catch { /* 坏行跳过 */ }
    }
    matched.sort((a, b) => a.ts - b.ts);
    return matched.length > limit ? matched.slice(matched.length - limit) : matched;
  }

  return { append, since, onAppend, path: filePath };
}

// 默认实例：数据根 = config.js 的 DATA_DIR（进程单一真源；Q14 起不再自读进程
// 环境变量）。import 时不创建任何文件，首次 append 才落盘。
export const events = createEventLog(path.join(DATA_DIR, 'events.jsonl'));
