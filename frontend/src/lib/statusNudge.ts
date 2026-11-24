/* ============================================================
   状态栏联动的小信号（旧 UI 在 session-start/session-end/chat-update
   时调 refreshStatus()，见 02-sse-sessions.js L6-81；新 UI 的状态栏
   数据源是 /api/person/state 10s 轮询，本模块让会话事件驱动它立即
   补刷一次，口径等价）。
   用 window CustomEvent 当总线：零依赖，页面与 StatusRail 解耦。
   ============================================================ */
const EVT = 'xunxi:status-nudge'

/** 会话页在会话级事件时调用（不要在密集的 session-update 里调） */
export function nudgeStatus(): void {
  try {
    window.dispatchEvent(new CustomEvent(EVT))
  } catch {
    /* 非浏览器环境忽略 */
  }
}

/** StatusRail 订阅；返回退订函数 */
export function onStatusNudge(cb: () => void): () => void {
  const handler = (): void => cb()
  window.addEventListener(EVT, handler)
  return () => window.removeEventListener(EVT, handler)
}
