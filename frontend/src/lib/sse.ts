/* ============================================================
   SSE /api/events 客户端 —— 事件名与载荷口径照抄旧 02-sse-sessions.js：
   session-start / session-update / session-end / chat-update
   （memory 等事件与其它页相关，
    这里不订阅，等价于旧 UI 里 tab!=='sessions' 分支的空操作。）
   W6（night-plan §4 W6 / plan Step 6）新增对话页两事件：
   chat-message / chat-typing —— 载荷即 surfaces/web/adapter.js broadcast
   的原样形状（self 分条 / 三点动画），仍复用这唯一一条 EventSource。

   断线重连：EventSource 规范内建自动重连（旧 UI 即依赖它，L172）；
   这里只补一个浏览器放弃（readyState=CLOSED）时的手动兜底重试
   （指数退避 1s→15s 封顶），并把连接状态回调给页面显示。

   P2（night-plan-pwa §P2）重连加固：onerror 连击计数——EventSource 原生
   自动重连期间每次失败都会再触发 onerror（readyState 保持 CONNECTING，
   浏览器不放弃），计次即覆盖「无限原生重连」形态；连续失败达 OFFLINE_AFTER
   次状态转 'offline'（页面显示离线点），短暂抖动（1-2 次）仍显示连接中；
   onopen 复位计数并回 'connected'，且断线后重连成功时触发一次 onRecover
   恢复回调（useChat 在此重拉 tail 按 mid 去重合并补断线缺口）。首次连接
   成功不触发 onRecover（消费方挂载时本就先 load()）。
   连清（handoff §28-7①/§29-3⑦ 同款纪律）：本文件的 SseState/计数/恢复结构
   已同步 kernelSse.ts（同一 /api/events 端点的另一客户端）。
   ============================================================ */
import type { SessionEndPayload, SessionUpdatePayload } from './types'

/** 连接状态三态（P2 扩）：connected=在线；reconnecting=连接中（原生重连或
 *  退避重试在途，失败未达阈值）；offline=离线（连续失败≥OFFLINE_AFTER）。 */
export type SseState = 'connected' | 'reconnecting' | 'offline'

/** 连续失败次数阈值：第 N 次 onerror 起显示离线。3 次 ≈ 断网后数秒
 * （原生重连间隔约 1-3s 起），单次抖动/闪断不闪离线点。 */
const OFFLINE_AFTER = 3

/** web 身体 self 分条（adapter.js broadcast('chat-message', …) 原样载荷） */
export interface ChatMessagePayload {
  conversationId: string
  role: 'self'
  text: string
  ts: number
  messageId: string
  /** Q6+Q8 媒体层：随消息附带的媒体（mediaStore 内容哈希 id），img src=/api/media/<id> */
  mediaIds?: string[]
  /** V2 语音条 TTS（voice-walkie）：该分条的可播放语音（TTS 合成 wav 的
   *  mediaStore 内容哈希 id），audio src=/api/media/<id>；纯文字分条不带 */
  audioIds?: string[]
}

/** web 身体输入状态（adapter.js broadcast('chat-typing', …) 原样载荷） */
export interface ChatTypingPayload {
  conversationId: string
  on: boolean
}

export interface SessionEventHandlers {
  onSessionStart?: () => void
  onSessionUpdate?: (data: SessionUpdatePayload) => void
  onSessionEnd?: (data: SessionEndPayload) => void
  onChatUpdate?: () => void
  onChatMessage?: (d: ChatMessagePayload) => void
  onChatTyping?: (d: ChatTypingPayload) => void
  onStateChange?: (state: SseState) => void
  /** P2 恢复回调：断线（至少一次 onerror）后重新 onopen 时触发一次——
   *  消费方在此重拉 tail 补断线缺口。首次连接成功不触发。 */
  onRecover?: () => void
}

/** 连接句柄：disconnect=组件卸载；reconnect=手动重连一次
 *  （S2 设计稿二：顶栏「刷新」移除后，连接状态点点击=手动重连，替代原刷新语义；
 *  断线状态下重连成功会照常触发 onRecover → 消费方补拉 tail 补缺口）。 */
export interface EventConnection {
  disconnect(): void
  reconnect(): void
}

function parseJson<T>(raw: unknown): T | null {
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return null
  }
}

/** 返回连接句柄（卸载时调 disconnect，避免重复连接） */
export function connectEvents(handlers: SessionEventHandlers): EventConnection {
  let es: EventSource | null = null
  let tornDown = false
  let retryTimer: number | undefined
  let retryDelay = 1000
  let errorCount = 0 // P2：连续 onerror 计数（onopen 归零）

  const connect = (): void => {
    if (tornDown) return
    // E6（R2）：SSE 与 HTTP 统一凭证携带方式——POST /api/auth/login 下发的
    // HttpOnly cookie。同源下浏览器本就随请求带 cookie，withCredentials 显式
    // 声明同一口径（反代/跨域部署时也成立），原生自动重连不丢凭证。
    es = new EventSource('/api/events', { withCredentials: true })
    es.onopen = () => {
      // P2：errorCount>0 = 本条连接前经历过失败（断线后重连成功）——先复位
      // 计数与退避再广播 connected，随后触发一次恢复回调（补拉 tail）。
      const recovered = errorCount > 0
      errorCount = 0
      retryDelay = 1000
      handlers.onStateChange?.('connected')
      if (recovered) handlers.onRecover?.()
    }
    es.addEventListener('session-start', () => handlers.onSessionStart?.())
    es.addEventListener('session-update', (ev) => {
      // 载荷坏了跳过本条，不断流（旧 UI 同口径 L19）
      const data = parseJson<SessionUpdatePayload>((ev as MessageEvent).data)
      if (data) handlers.onSessionUpdate?.(data)
    })
    es.addEventListener('session-end', (ev) => {
      // 数据坏了也照常刷列表（旧 UI 同口径 L56）
      const data = parseJson<SessionEndPayload>((ev as MessageEvent).data) ?? {}
      handlers.onSessionEnd?.(data)
    })
    es.addEventListener('chat-update', () => handlers.onChatUpdate?.())
    es.addEventListener('chat-message', (ev) => {
      // 载荷坏了跳过本条，不断流（同 session-update 口径）
      const data = parseJson<ChatMessagePayload>((ev as MessageEvent).data)
      if (data) handlers.onChatMessage?.(data)
    })
    es.addEventListener('chat-typing', (ev) => {
      const data = parseJson<ChatTypingPayload>((ev as MessageEvent).data)
      if (data) handlers.onChatTyping?.(data)
    })
    es.onerror = () => {
      // P2：连击计数（原生重连期间每次失败都再触发），达阈值转离线
      errorCount += 1
      handlers.onStateChange?.(errorCount >= OFFLINE_AFTER ? 'offline' : 'reconnecting')
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
  return {
    disconnect: () => {
      tornDown = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      es?.close()
      es = null
    },
    // 手动重连一次（S2 设计稿二）：立即关掉当前 EventSource 重建。不动退避
    // 计数——断线态（errorCount>0）下重连成功仍触发 onRecover 补拉 tail；
    // 在线态手动重连 = errorCount=0，onopen 只广播 connected，无副作用。
    reconnect: () => {
      if (tornDown) return
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer)
        retryTimer = undefined
      }
      es?.close()
      es = null
      connect()
    },
  }
}
