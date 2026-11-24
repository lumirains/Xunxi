/* ============================================================
   kernel-event SSE 客户端（15f 事件流直播，D43）。
   复用既有 SSE 通道 /api/events（src/app.js L1347，零后端 SSE 改动），
   只多订阅一个事件名 'kernel-event'——后端由 routes.js 的 onAppend 桥
   在 events.jsonl 落盘成功后 emit（kernel/events.js 通知监听器）。

   断线重连口径与 sse.ts 一致：EventSource 内建自动重连 + 浏览器放弃
   （readyState=CLOSED）时的手动兜底（指数退避 1s→15s 封顶）。
   P2（night-plan-pwa §P2）重连加固与 sse.ts 逐项同步（连清纪律
   handoff §28-7①/§29-3⑦：同一 /api/events 端点的另一客户端，结构必须
   同口径——onerror 连击计数、连续失败≥3 转离线态、onRecover 恢复回调；
   Events.vue 现有三元文案对 offline 落 '实时重连中…' 与改前同条件同文案
   =桌面零视觉变化，onRecover 可选参数 Events.vue 未传=零行为变化）。
   ============================================================ */
import type { KernelEvent } from './types'

/** 连接状态三态（与 sse.ts 同口径，P2 同步扩）：connected=在线；
 *  reconnecting=连接中；offline=离线（连续失败≥OFFLINE_AFTER）。 */
export type SseState = 'connected' | 'reconnecting' | 'offline'

/** 连续失败次数阈值（与 sse.ts 同值同义）。 */
const OFFLINE_AFTER = 3

function parseJson<T>(raw: unknown): T | null {
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return null
  }
}

/** 返回卸载函数（组件卸载时调用，避免重复连接） */
export function connectKernelEvents(
  onEvent: (event: KernelEvent) => void,
  onStateChange?: (state: SseState) => void,
  onRecover?: () => void,
): () => void {
  let es: EventSource | null = null
  let tornDown = false
  let retryTimer: number | undefined
  let retryDelay = 1000
  let errorCount = 0 // P2：连续 onerror 计数（onopen 归零，与 sse.ts 同口径）

  const connect = (): void => {
    if (tornDown) return
    // E6（R2）：与 sse.ts 同口径——/api/events 唯一通道改带 cookie 凭证
    //（POST /api/auth/login 下发）。连清：本文件是同一 SSE 端点的另一客户端
    //（kernel-event 流），漏改会在 token≠'' 时出现"HTTP 正常、事件流 401"的分裂。
    es = new EventSource('/api/events', { withCredentials: true })
    es.onopen = () => {
      // P2：断线后重连成功触发一次恢复回调（与 sse.ts 同构；首次连接不触发）
      const recovered = errorCount > 0
      errorCount = 0
      retryDelay = 1000
      onStateChange?.('connected')
      if (recovered) onRecover?.()
    }
    es.addEventListener('kernel-event', (ev) => {
      // 载荷坏了跳过本条，不断流（与 sse.ts 同口径）
      const data = parseJson<KernelEvent>((ev as MessageEvent).data)
      if (data) onEvent(data)
    })
    es.onerror = () => {
      // P2：连击计数（与 sse.ts 同口径），达阈值转离线
      errorCount += 1
      onStateChange?.(errorCount >= OFFLINE_AFTER ? 'offline' : 'reconnecting')
      if (es && es.readyState === EventSource.CLOSED && !tornDown && retryTimer === undefined) {
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined
          retryDelay = Math.min(retryDelay * 2, 15000)
          connect()
        }, retryDelay)
      }
    }
  }

  connect()
  return () => {
    tornDown = true
    if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    es?.close()
    es = null
  }
}
