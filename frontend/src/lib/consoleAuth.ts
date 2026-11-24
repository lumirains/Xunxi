/* ============================================================
   E6（R2）控制台令牌登录态 —— api.ts 401 → 浮层 → 重试的中枢。
   （白皮书 §7.9「单用户 ≠ 无认证」；night-plan-pwa §0-8：浮层是 App 级，
    /pwa 等所有页面自动继承。）

   流程：
   - api() 收 401 → requestLogin() 登记等待者并把 authGate.visible 置 true；
   - AuthOverlay.vue（App 级挂载）按 authGate 渲染浮层；
   - submitLogin(token) → POST /api/auth/login（后端免检端点）；
     成功：cookie 已由 Set-Cookie 落地（HttpOnly，JS 不可读也不需要读），
     放行全部等待者 → api() 各自重试原请求一次；
     失败：错误留在 authGate.error，浮层不关。
   ============================================================ */
import { reactive } from 'vue'

/** 浮层渲染状态（AuthOverlay.vue 唯一数据源；authGate 本身无 DOM） */
export const authGate = reactive({
  visible: false,
  error: '',
  submitting: false,
})

// 排队中的 401 请求：登录成功 → 全部 resolve(true)（各自重试一次）；
// 用户取消 → 全部 resolve(false)（调用方按"未授权"失败）。
type Waiter = (granted: boolean) => void
let waiters: Waiter[] = []

/** api() 收 401 时调用：登记等待者并弹浮层。resolve(true)=已登录可重试。 */
export function requestLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    waiters.push(resolve)
    authGate.visible = true
    authGate.error = ''
  })
}

/** 浮层提交。true=登录成功（浮层已关、等待者已放行）；false=失败（浮层留显错误）。 */
export async function submitLogin(token: string): Promise<boolean> {
  authGate.submitting = true
  authGate.error = ''
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!res.ok) {
      authGate.error = res.status === 401 ? '令牌不匹配，请重试' : `登录失败（HTTP ${res.status}）`
      return false
    }
    authGate.visible = false
    const pending = waiters
    waiters = []
    for (const w of pending) w(true)
    return true
  } catch {
    authGate.error = '网络错误，请重试'
    return false
  } finally {
    authGate.submitting = false
  }
}

/** 用户关闭浮层：等待者按失败放行（原请求不重试）。 */
export function cancelLogin(): void {
  authGate.visible = false
  const pending = waiters
  waiters = []
  for (const w of pending) w(false)
}
