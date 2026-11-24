/* ============================================================
   晚安整理结果的共享总线（S2 · ui-redesign 设计稿六，2026-11-18）：
   修 Bug2 反馈断链——11-17 晚安按钮实际成功但 StatusRail 无任何可见反馈。
   按钮面（Sessions.vue 桌面 / Pwa.vue 移动）调 publishEveningResult()，
   状态栏（StatusRail.vue）订阅并渲染**常驻三行明细**（卡片/日记/明日日程
   各带状态），8s 后仅折叠为角标（点击再展开）——替代原"8s 淡出 toast"。
   模式照 statusNudge.ts：window CustomEvent 总线，零依赖，发布/订阅解耦。
   三行状态由 badgesOf 统一派生（按钮面与状态栏共用同一口径，Pwa 提示条
   也用它拼同款三段文案）。
   ============================================================ */
import type { EveningResult } from './api'

/** 单行状态：ok=✓ / bad=✗ / info=–（幂等跳过、无可整理都归 info，不算报错） */
export interface EveningBadge {
  label: string
  state: 'ok' | 'bad' | 'info'
  note: string
}

export interface EveningDetail {
  result: EveningResult
  badges: EveningBadge[]
  /** 汇总态（bad > info > ok），角标配色用 */
  kind: 'ok' | 'info' | 'bad'
}

const EVT = 'xunxi:evening-result'

/** 三行明细统一派生（卡片 ✓ / 日记 ✓ / 明日日程 ✓，各带状态与一句说明）。
 *  口径与 Sessions eveningCardPart/eveningDiaryPart 同源：
 *  · 卡片 ok+skipped=今日已整理（info）；ok=已整理；否则 ✗（error/reason 短句）
 *  · 日记 wrote=已写；skipped='今日已整理'=幂等（ok 语义）；error=✗；其余 skipped=info
 *  · 明日日程 ok（status≠failed）=已备好（skipped 带原因）；否则 ✗ */
export function badgesOf(r: EveningResult): EveningBadge[] {
  const out: EveningBadge[] = []
  // 记忆卡
  const c = r.card
  if (c?.ok && c.status === 'skipped') {
    out.push({ label: '记忆卡', state: 'info', note: '今日已整理（之后没有新的对话）' })
  } else if (c?.ok) {
    out.push({ label: '记忆卡', state: 'ok', note: `已整理（事件 ${c.card?.events?.length ?? 0} 条 · 事实 +${c.factsUpserted ?? 0}）` })
  } else {
    out.push({ label: '记忆卡', state: 'bad', note: String(c?.error || c?.reason || '未整理') })
  }
  // 私密日记
  const d = r.diary
  if (d?.wrote) {
    out.push({ label: '日记', state: 'ok', note: `《${d.entry?.title || '无题'}》已写` })
  } else if (d?.skipped === '今日已整理') {
    out.push({ label: '日记', state: 'ok', note: '今日已整理（幂等跳过）' })
  } else if (d?.error) {
    out.push({ label: '日记', state: 'bad', note: String(d.error) })
  } else if (d?.skipped) {
    out.push({ label: '日记', state: 'info', note: String(d.skipped) })
  } else {
    out.push({ label: '日记', state: 'bad', note: '未写' })
  }
  // 明日日程（life-prose v2：按钮=今天结束立即备明天；planExists 幂等）
  const p = (r as EveningResult & { plan?: { ok?: boolean; status?: string; reason?: string; error?: string } }).plan
  if (!p) {
    out.push({ label: '明日日程', state: 'info', note: '端点未返回（旧后端？）' })
  } else if (p.ok && p.status === 'skipped') {
    out.push({ label: '明日日程', state: 'ok', note: String(p.reason || '已有明日安排（幂等跳过）') })
  } else if (p.ok) {
    out.push({ label: '明日日程', state: 'ok', note: '已备好' })
  } else {
    out.push({ label: '明日日程', state: 'bad', note: String(p.error || p.reason || '未生成') })
  }
  return out
}

function summarize(badges: EveningBadge[]): EveningDetail['kind'] {
  if (badges.some((b) => b.state === 'bad')) return 'bad'
  if (badges.some((b) => b.state === 'info')) return 'info'
  return 'ok'
}

/** 按钮面在拿到结构化结果后调用（HTTP 传输异常没有结构化结果，走各自原有错误提示） */
export function publishEveningResult(result: EveningResult): void {
  const badges = badgesOf(result)
  const detail: EveningDetail = { result, badges, kind: summarize(badges) }
  try {
    window.dispatchEvent(new CustomEvent(EVT, { detail }))
  } catch {
    /* 非浏览器环境忽略 */
  }
}

/** 状态栏订阅；返回退订函数 */
export function onEveningResult(cb: (d: EveningDetail) => void): () => void {
  const handler = (ev: Event): void => {
    const detail = (ev as CustomEvent<EveningDetail>).detail
    if (detail) cb(detail)
  }
  window.addEventListener(EVT, handler)
  return () => window.removeEventListener(EVT, handler)
}

/** 单行符号（状态栏明细行与 Pwa 提示条共用） */
export function badgeMark(state: EveningBadge['state']): string {
  return state === 'ok' ? '✓' : state === 'bad' ? '✗' : '–'
}
