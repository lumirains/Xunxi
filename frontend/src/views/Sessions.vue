<script setup lang="ts">
// ============================================================
// 会话页「她的一天」（2026-11-18 S2 · ui-redesign 设计稿一，修 P1-1/P1-2）：
//   · 列表从"运行切片流水"变成按天分组的日子（今天/昨天/日期 粘性分组头，
//     顶部统计收进分组头："昨天 · 11-16 · 12 段对话"）；
//   · 条目标题 = `HH:MM · 她的回应摘要`（≤40 字；取 lastSent=sent 最后一条，
//     后端 #summary 新增字段，设计稿一"不足再补 API 字段"路径）——chatKey
//     'main'/tok/轮数/web 徽标全部退出首屏（工程遥测只在抽屉折叠区）；
//   · 状态徽章收敛一枚圆点：未回复=琥珀 / 出错=红 / 运行等待=琥珀脉冲 /
//     正常=无；waiting 剩余时间与 running 活动摘要保留为次行；
//   · 点击条目 → 右滑详情抽屉（480px，不跳页）：对话视角（触发消息 + 她说
//     了什么 + 时间）为主阅读面，底部折叠「运行细节」= 原工程视图
//     （模型/tok/finish 工具流/系统提示），默认收起。
// 数据端点与载荷口径 100% 复用旧 UI（不改动）：
//   /api/sessions?limit=1048576 / /api/sessions/:id / /api/chats
//   SSE /api/events 的 session-start/session-update/session-end/chat-update
// 右侧状态栏 StatusRail 由 AppLayout 常驻；会话级事件经 statusNudge
// 驱动它立即补刷（等价旧 UI 的 refreshStatus() 调用点）。
// ============================================================
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ensureVoiceEngines, fetchChats, fetchSession, fetchSessions, runEveningReflection } from '../lib/api'
import { publishEveningResult } from '../lib/eveningBus'
import { describeEnsureResult } from '../lib/voiceEngines'
import {
  argsText,
  fmtClock,
  fmtTokens,
  isDeepThink,
  statusLabel,
  surfaceOf,
  toolIcon,
  toolLabel,
  toolSummary,
} from '../lib/format'
import { connectEvents, type SseState } from '../lib/sse'
import { nudgeStatus } from '../lib/statusNudge'
import type {
  ChatMeta,
  SessionDetail,
  SessionMessageItem,
  SessionSummary,
  SessionUpdatePayload,
  ToolCallItem,
  ToolImagesItem,
} from '../lib/types'

/* 分页常量照抄旧 00-core.js L231-232 */
const SESSION_PAGE = 50
const SESSION_KEEP = 400
/* 列表轮询间隔：与后端 DEFAULT_CONFIG.ui.refreshMs 兜底一致（旧 L201-206） */
const REFRESH_MS = 15000

// ---- 状态 ----
const sessions = ref<SessionSummary[]>([])
const chats = ref<ChatMeta[]>([])
const currentId = ref<string | null>(null)
const detail = ref<SessionDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
const listLimit = ref(SESSION_PAGE)
const sseState = ref<SseState>('reconnecting')
const now = ref(Date.now()) // 等待中会话的剩余时间 + 分组「今天」跨日刷新用
const detailEl = ref<HTMLElement | null>(null)
let wasAtBottom = true

// ---- 按天分组（设计稿一）：今天/昨天/日期 粘性分组头，统计收进组头 ----
interface DayGroup {
  key: string
  label: string
  count: number
  items: SessionSummary[]
}

function dayKeyOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const dayGroups = computed<DayGroup[]>(() => {
  const today = dayKeyOf(now.value)
  const yesterday = dayKeyOf(now.value - 86_400_000)
  const groups: DayGroup[] = []
  const indexOf = new Map<string, number>()
  for (const s of shownSessions.value) {
    const key = dayKeyOf(Number(s.startedAt) || 0)
    let gi = indexOf.get(key)
    if (gi === undefined) {
      const label = key === today ? `今天 · ${key.slice(5)}` : key === yesterday ? `昨天 · ${key.slice(5)}` : key.slice(5)
      groups.push({ key, label, count: 0, items: [] })
      gi = groups.length - 1
      indexOf.set(key, gi)
    }
    groups[gi].items.push(s)
    groups[gi].count++
  }
  return groups
})

// ---- 列表 ----
// 时间倒序（后端 index 本身按 startedAt 降序，这里防御性再排一次，稳定同序）
const sortedSessions = computed<SessionSummary[]>(() =>
  sessions.value.slice().sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0)),
)
// 分页渲染：一次只渲染 listLimit 条（照旧 renderSessionList L344-349）
const shownSessions = computed<SessionSummary[]>(() => sortedSessions.value.slice(0, listLimit.value))
const hiddenCount = computed<number>(() => Math.max(0, sortedSessions.value.length - shownSessions.value.length))

// 条目标题：她的回应摘要 ≤40 字（lastSent = sent 最后一条；无回应时退
// triggerSummary 让条目仍可辨认——noreply 会话没有 sent，只有触发可读）
function summaryOf(s: SessionSummary): string {
  const raw = (String(s.lastSent ?? '').trim() || String(s.trigger ?? '').trim()).replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw
}

// 状态收敛为一枚圆点（设计稿一）：出错=红 / 未回复=琥珀 / 运行·等待=琥珀脉冲 / 正常=无
function dotClass(s: SessionSummary): string {
  if (s.status === 'error') return 'dot-err'
  if (s.status === 'noreply') return 'dot-warn'
  if (s.status === 'running' || s.status === 'waiting') return 'dot-live'
  return ''
}

function waitRemain(until?: number | null): string {
  if (!until) return '等待中'
  const remain = Math.max(0, Number(until) - now.value)
  return remain > 0 ? `等待中 · ${(remain / 1000).toFixed(1)}s` : '等待中 · 启动…'
}

// 滚动到底部附近就加载下一批（距底 400px，照 attachScrollLoader 口径；
// 加载动作只是 bump 一个数字 → computed slice，开销极小，简单节流即可）
let lastListScrollAt = 0
function onListScroll(e: Event): void {
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight < el.scrollHeight - 400) return
  const t = Date.now()
  if (t - lastListScrollAt < 120) return
  lastListScrollAt = t
  loadMore()
}
function loadMore(): void {
  const all = sortedSessions.value.length
  if (listLimit.value >= all) return
  listLimit.value = Math.min(all, listLimit.value + SESSION_PAGE)
}

// ---- 详情抽屉 ----
function selectSession(id: string): void {
  currentId.value = id
  detail.value = null
  detailError.value = ''
  detailLoading.value = true
  wasAtBottom = true
  void loadSessionDetail(id).then(() => {
    // 切换会话首次打开：滚到底（旧 renderSessionDetail L712-714 firstRender 分支）
    void nextTick(() => scrollToBottom())
  })
}

function closeDrawer(): void {
  currentId.value = null
  detail.value = null
  detailError.value = ''
  detailLoading.value = false
}

async function loadSessionDetail(id: string, { quiet = false } = {}): Promise<void> {
  try {
    const s = await fetchSession(id)
    if (currentId.value !== id) return // 期间用户切走了会话，别覆盖当前视图
    detail.value = s
    detailError.value = ''
  } catch (e) {
    if (quiet) return
    detailError.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (currentId.value === id) detailLoading.value = false
  }
}

// 消息流条目（旧 renderSessionDetail L596-637 同口径的三类 + 深度思考细分）
type FlowEntry =
  | { key: string; kind: 'tool'; call: ToolCallItem }
  | { key: string; kind: 'images'; images: ToolImagesItem }
  | { key: string; kind: 'deep' | 'draft'; text: string }

// 三类条目的判别谓词（载荷是松散 union，in 判别 + 谓词收窄）
function isToolCall(x: SessionMessageItem): x is { toolCall: ToolCallItem } {
  return 'toolCall' in x
}
function isToolImages(x: SessionMessageItem): x is { toolImages: ToolImagesItem } {
  return 'toolImages' in x
}
function isAssistant(x: SessionMessageItem): x is { role: string; content: string | null; tool_calls?: unknown } {
  return 'role' in x
}

const flow = computed<FlowEntry[]>(() => {
  const s = detail.value
  const items: SessionMessageItem[] = Array.isArray(s?.messages) ? (s?.messages as SessionMessageItem[]) : []
  const out: FlowEntry[] = []
  items.forEach((item, i) => {
    if (isToolCall(item)) {
      out.push({ key: `t${i}`, kind: 'tool', call: item.toolCall })
      return
    }
    if (isToolImages(item)) {
      out.push({ key: `i${i}`, kind: 'images', images: item.toolImages })
      return
    }
    if (!isAssistant(item) || item.role !== 'assistant') return
    const text = typeof item.content === 'string' ? item.content : ''
    // 纯工具调用轮（有 tool_calls 无文本）：卡片已展示，旧 UI 同口径跳过（L627）
    if (Array.isArray(item.tool_calls) && (item.tool_calls as unknown[]).length && !text.trim()) return
    // 无 tool_calls 的空文本 assistant 也渲染思考卡，占位文案照旧 UI L635
    out.push({
      key: `a${i}`,
      kind: isDeepThink(text) ? 'deep' : 'draft',
      text: text.trim() ? text : '（无文本输出，仅调用工具）',
    })
  })
  return out
})

const sentList = computed(() => (Array.isArray(detail.value?.sent) ? (detail.value?.sent ?? []) : []))

// user 角色的真实触发消息来自存档 triggerText；proactive 会话没有触发消息
const hasTriggerText = computed<boolean>(() => Boolean(String(detail.value?.triggerText ?? '').trim()))

// 抽屉「对话视角」的落空提示：非进行中且没发出过消息（noreply/aborted）不再干等
const convIdle = computed<boolean>(() => {
  const s = detail.value
  if (!s) return false
  const running = s.status === 'running' || s.status === 'waiting'
  return !running && !(Array.isArray(s.sent) && s.sent.length)
})

// ---- 抽屉滚动跟随（旧 L524/L712-716：贴底才跟随，否则保留阅读位置）----
function onDetailScroll(e: Event): void {
  const el = e.target as HTMLElement
  wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}
function scrollToBottom(): void {
  const el = detailEl.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(
  () => detail.value?.messages?.length,
  async () => {
    await nextTick()
    if (wasAtBottom) scrollToBottom()
  },
)

// ---- 数据加载（照旧 loadSessions L176-195）----
let autoFollowed = false
async function loadSessions({ quiet = false } = {}): Promise<void> {
  try {
    const list = await fetchSessions()
    sessions.value = list
    // 自动跟随最新运行中的会话：只在还没选中时挑一次（旧 L183-186）
    if (!autoFollowed && !currentId.value) {
      const active = sessions.value.find((s) => s.status === 'waiting' || s.status === 'running')
      if (active) {
        autoFollowed = true
        selectSession(active.id)
      }
    }
    // 当前打开的会话在等待/运行中时，顺手刷新详情（旧 L187-193）
    if (currentId.value) {
      const cur = sessions.value.find((s) => s.id === currentId.value)
      if (cur && (cur.status === 'running' || cur.status === 'waiting')) {
        void loadSessionDetail(currentId.value, { quiet: true })
      }
    }
  } catch (e) {
    if (!quiet) detailError.value = e instanceof Error ? e.message : String(e)
  }
}

async function loadChats(): Promise<void> {
  try {
    chats.value = await fetchChats()
  } catch {
    /* 名字拿不到就退回 formatChatTitle 兜底（历史键美化/原始键直显）——
       S2 设计稿一后首屏/抽屉都不再展示 chatKey，此兜底仅为保留数据面 */
  }
}

// ---- 晚安整理（night-plan-life §L1）：页头按钮 → POST /api/reflection/run-evening ----
// S2 设计稿六（Bug2 反馈断链修复，2026-11-18）：结果改经 eveningBus 广播 →
// StatusRail 常驻三行明细（卡片✓/日记✓/明日日程✓，8s 后仅折叠为角标），
// 替代原"8s 淡出 toast"成功反馈（11-17 实际成功但 UI 无可见反馈的断链）。
// 传输异常（无结构化结果）仍走 toast；广播后顺手 nudge 状态栏立即补刷
// （明日日程/已发生标注马上可见，不等 10s 轮询）。
const eveningLoading = ref(false)
const engineLoading = ref(false)
type EveningToastKind = 'ok' | 'info' | 'bad'
const eveningToast = ref<{ kind: EveningToastKind; text: string } | null>(null)
let eveningToastTimer: number | undefined

function showEveningToast(kind: EveningToastKind, text: string): void {
  eveningToast.value = { kind, text }
  if (eveningToastTimer !== undefined) window.clearTimeout(eveningToastTimer)
  eveningToastTimer = window.setTimeout(() => {
    eveningToast.value = null
    eveningToastTimer = undefined
  }, 8000)
}

async function runEvening(): Promise<void> {
  if (eveningLoading.value) return
  eveningLoading.value = true
  try {
    const r = await runEveningReflection()
    publishEveningResult(r)
    nudgeStatus()
  } catch (e) {
    showEveningToast('bad', `整理失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    eveningLoading.value = false
  }
}

// ---- 本地语音引擎（2026-11-20）：重开应用后配置仍为 enabled，不会自动拉起；
// 按钮直接调 /api/voice/ensure（探测→auto 拉起→健康探针→TTS 预热），不改配置。
async function runVoiceEngines(): Promise<void> {
  if (engineLoading.value) return
  engineLoading.value = true
  try {
    const r = await ensureVoiceEngines()
    const s = describeEnsureResult(r?.result)
    showEveningToast(s.kind, s.text)
  } catch (e) {
    showEveningToast('bad', `拉起本地引擎失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    engineLoading.value = false
  }
}

// ---- SSE 实时（事件口径照旧 connectSSE L4-81）----
// session-update 很密（每轮思考/每个工具一次），列表重载合批 200ms 一次（旧 L224-232）
let reloadTimer: number | undefined
function scheduleReload(): void {
  if (reloadTimer !== undefined) return
  reloadTimer = window.setTimeout(() => {
    reloadTimer = undefined
    void loadSessions({ quiet: true })
  }, 200)
}

/** session-update 载荷 patch 进列表（旧 L23-49 同字段口径） */
function patchList(data: SessionUpdatePayload): void {
  const id = data.sessionId
  if (!id) return
  const patch: Partial<SessionSummary> = {
    chatKey: data.chatKey || '',
    status: data.status,
    waitUntil: data.waitUntil ?? null,
    activity: data.activity || '',
    webSearchCount: data.webSearchCount || 0,
    rounds: data.rounds || 0,
    usage: data.usage ?? null,
    trigger: data.triggerSummary ?? '',
    startedAt: data.startedAt ?? 0,
    endedAt: data.endedAt ?? null,
  }
  // sent/finishReason/error：后端给了才写，不能无脑写 null（旧 L36-41 注释口径）
  if (Array.isArray(data.sent)) {
    patch.sent = data.sent
    // 设计稿一：live patch 同步刷新她的回应摘要（与 #summary.lastSent 同口径）
    const last = data.sent[data.sent.length - 1]
    if (last) patch.lastSent = String(last.text ?? '').slice(0, 120)
  }
  if (data.finishReason !== undefined) patch.finishReason = data.finishReason
  if (data.error !== undefined) patch.error = data.error
  const existing = sessions.value.find((s) => s.id === id)
  if (existing) {
    Object.assign(existing, patch)
  } else {
    sessions.value.unshift({ id, ...patch } as SessionSummary)
    sessions.value = sessions.value.slice(0, SESSION_KEEP) // 上限照旧 L47-48
  }
}

/** session-update 快照合并进当前详情（SSE 没带的字段保留 HTTP 值） */
function patchDetail(data: SessionUpdatePayload): void {
  const id = data.sessionId
  if (!id || currentId.value !== id) return
  // SSE 载荷的 trigger 是 triggerSummary 字符串（src/app.js L604），直接合并会把
  // 详情接口的原值（'message'|'proactive'，src/sessions.js L277）覆盖掉，
  // 主动机会会话的详情头「触发：」会退化成 '-' —— 剥离后再合并
  //（旧 UI 的详情 patch 同样不含 trigger 键，01-boot.js L107-127 口径）。
  const { trigger: _sseTrigger, ...snapshot } = data
  if (detail.value && detail.value.id === id) {
    Object.assign(detail.value, snapshot)
  } else if (!detail.value) {
    detail.value = snapshot as unknown as SessionDetail
  }
}

const conn = connectEvents({
  onSessionStart: () => {
    scheduleReload()
    nudgeStatus()
    // 自动跟随新会话（等待中/运行中；旧 L8-15：已有选中也会切到新会话）
    void loadSessions({ quiet: true }).then(() => {
      const active = sessions.value.find((s) => s.status === 'waiting' || s.status === 'running')
      if (active && active.id !== currentId.value) selectSession(active.id)
    })
  },
  onSessionUpdate: (data) => {
    // SSE 事件本身携带完整会话快照：先 patch 本地，渲染交给响应式（旧 L22）
    patchList(data)
    patchDetail(data)
  },
  onSessionEnd: (data) => {
    scheduleReload()
    nudgeStatus()
    // discarded：后端已把等待会话连磁盘文件一起删掉，本地同步摘掉（旧 L59-68）
    if (data.sessionId && data.status === 'discarded') {
      sessions.value = sessions.value.filter((s) => s.id !== data.sessionId)
      if (currentId.value === data.sessionId) {
        closeDrawer()
      }
    }
    // 会话刚结束必须主动重拉一次详情：最终态（sent/finishReason/error）
    // 之后再也不来，不重拉就看不到收尾（旧 L69-76 注释口径）
    if (data.sessionId && data.sessionId === currentId.value) {
      detailLoading.value = true
      void loadSessionDetail(data.sessionId, { quiet: true })
    }
  },
  onChatUpdate: () => {
    scheduleReload()
    nudgeStatus()
  },
  onStateChange: (state) => {
    sseState.value = state
  },
})

// ---- 轮询兜底 + 等待剩余时间 ticker（旧 startListPoller/startWaitTicker 口径）----
let pollTimer: number | undefined
let tickTimer: number | undefined

onMounted(() => {
  void loadChats()
  void loadSessions()
  pollTimer = window.setInterval(() => void loadSessions({ quiet: true }), REFRESH_MS)
  tickTimer = window.setInterval(() => {
    now.value = Date.now()
  }, 500)
})
onUnmounted(() => {
  conn.disconnect()
  if (pollTimer !== undefined) window.clearInterval(pollTimer)
  if (tickTimer !== undefined) window.clearInterval(tickTimer)
  if (reloadTimer !== undefined) window.clearTimeout(reloadTimer)
  if (eveningToastTimer !== undefined) window.clearTimeout(eveningToastTimer)
})
</script>

<template>
  <section class="sessions-page">
    <!-- 会话列表（按天分组；统计收进组头；工程遥测退出首屏） -->
    <aside class="list-pane card">
      <header class="list-head">
        <h2>会话</h2>
        <!-- 晚安整理（night-plan-life §L1）：提前关应用前手动触发今晚的记忆卡+日记整理 -->
        <button
          type="button"
          class="btn evening-btn"
          :disabled="eveningLoading"
          :title="eveningLoading ? '正在请求模型整理…' : '把今天的记忆卡和私密日记现在就整理一遍（不等晚安定时）'"
          @click="runEvening"
        >
          {{ eveningLoading ? '整理中…' : '整理今晚记忆卡与日记' }}
        </button>
        <!-- 本地语音引擎手动拉起（2026-11-20）：重开应用后不必再取消/重新勾选开关 -->
        <button
          type="button"
          class="btn evening-btn engine-btn"
          :disabled="engineLoading"
          :title="engineLoading ? '正在探测/拉起本地引擎…' : '探测并拉起设置里已配置的本地 ASR/TTS 引擎（首次 TTS 约 30-60 秒；不修改配置）'"
          @click="runVoiceEngines"
        >
          {{ engineLoading ? '拉起中…' : '拉起引擎' }}
        </button>
        <span class="sse-hint" :class="{ ok: sseState === 'connected' }">
          {{ sseState === 'connected' ? '实时已连接' : '实时重连中…' }}
        </span>
      </header>
      <div class="list-scroll" @scroll="onListScroll">
        <p v-if="!sessions.length" class="empty-hint">还没有会话（给她发条消息，或等一次主动机会）</p>
        <template v-for="g in dayGroups" :key="g.key">
          <!-- 粘性分组头：今天 · 11-18 · N 段对话（顶部统计收进来） -->
          <p class="day-head">
            <span class="dh-day">{{ g.label }}</span>
            <span class="dh-count">{{ g.count }} 段对话</span>
          </p>
          <button
            v-for="s in g.items"
            :key="s.id"
            type="button"
            class="session-item"
            :class="{ selected: s.id === currentId, waiting: s.status === 'waiting' }"
            @click="selectSession(s.id)"
          >
            <span class="si-row">
              <span class="si-dot" :class="dotClass(s)" aria-hidden="true"></span>
              <span class="si-time">{{ fmtClock(s.startedAt).slice(0, 5) }}</span>
              <span class="si-summary" :class="{ dim: !s.lastSent }">{{ summaryOf(s) || '（无记录）' }}</span>
            </span>
            <span v-if="s.status === 'waiting' && s.waitUntil" class="si-sub">{{ waitRemain(s.waitUntil) }}</span>
            <span v-else-if="s.status === 'running' && s.activity" class="si-sub">{{ s.activity }}</span>
          </button>
        </template>
        <p v-if="hiddenCount > 0" class="list-more">向下滚动加载更多（还有 {{ hiddenCount }} 条）</p>
        <p v-else-if="sessions.length > SESSION_PAGE" class="list-more">已显示全部 {{ sessions.length }} 条</p>
      </div>
    </aside>

    <!-- 详情抽屉（右滑 480px，不跳页）：对话视角为主，运行细节折叠收底 -->
    <transition name="drawer-slide">
      <aside v-if="currentId" class="drawer card">
        <header class="drawer-head">
          <p class="drawer-when">
            {{ detail ? `${fmtClock(detail.startedAt)}${detail.endedAt ? ` – ${fmtClock(detail.endedAt)}` : ' – 进行中'}` : '' }}
          </p>
          <div class="drawer-head-row">
            <span v-if="detail" class="status-badge" :class="`st-${detail.status}`">{{ statusLabel(detail.status) }}</span>
            <button type="button" class="drawer-close" title="关闭" @click="closeDrawer">✕</button>
          </div>
        </header>

        <div ref="detailEl" class="drawer-scroll" @scroll="onDetailScroll">
          <p v-if="detailLoading && !detail" class="empty-hint pad">加载中…</p>
          <p v-else-if="detailError && !detail" class="empty-hint pad">加载失败：{{ detailError }}</p>
          <template v-else-if="detail">
            <!-- ── 对话视角：触发消息 + 她说了什么 ── -->
            <p class="drawer-label">对话</p>

            <div class="user-bubble">
              <p class="role-tag">对方 · 触发消息</p>
              <pre v-if="hasTriggerText" class="msg-text">{{ detail.triggerText }}</pre>
              <p v-else class="msg-text dim">（主动机会 · 无触发消息）</p>
            </div>

            <div v-if="sentList.length" class="her-lines">
              <div v-for="(m, i) in sentList" :key="i" class="her-line">
                <p class="sent-at">已发送{{ m.to ? ` → ${m.to}` : '' }}{{ m.at ? ` · ${m.at}` : '' }}</p>
                <pre class="msg-text">{{ m.text }}</pre>
              </div>
            </div>
            <p v-else-if="detail.error" class="conv-error">{{ detail.error }}</p>
            <p v-else-if="convIdle" class="conv-idle">（她这次没有发出消息）</p>

            <!-- ── 运行细节（默认折叠）：模型/tok/finish 工具流/系统提示 ── -->
            <details class="ops-fold">
              <summary>运行细节（模型 · token · 工具流 · 系统提示）</summary>
              <div class="ops-body">
                <p class="dh-sub">
                  <span>触发：{{ detail.triggerSummary || (detail.trigger === 'proactive' ? '主动机会' : '-') }}</span>
                  <span>身体 {{ surfaceOf(detail.chatKey, detail.surface) }}</span>
                  <span>模型 {{ detail.model || '-' }}</span>
                  <span>
                    {{ detail.usage?.calls || 0 }} 次调用 ·
                    {{ fmtTokens(detail.usage?.promptTokens) }} 入 /
                    {{ fmtTokens(detail.usage?.completionTokens) }} 出 /
                    {{ fmtTokens(detail.usage?.totalTokens) }} 总
                  </span>
                  <span>{{ detail.rounds || 0 }} 轮工具</span>
                  <span>联网搜索 {{ Number(detail.webSearchCount) || 0 }} 次</span>
                </p>

                <details v-if="detail.systemPrompt" class="prompt-fold">
                  <summary>系统提示（{{ detail.systemPrompt.length }} 字符，每次运行重发）</summary>
                  <pre class="fold-body">{{ detail.systemPrompt }}</pre>
                </details>
                <details v-if="detail.userPrompt" class="prompt-fold">
                  <summary>本次输入（{{ detail.userPrompt.length }} 字符 —— 零对话历史，全部来自 JSON 存档）</summary>
                  <pre class="fold-body">{{ detail.userPrompt }}</pre>
                </details>

                <p class="flow-label">消息流（user → bot 处理 → 发送）</p>

                <!-- bot 处理流：思考气泡（Q16 默认折叠）+ 工具紧凑行（可展开） -->
                <template v-for="f in flow" :key="f.key">
                  <details v-if="f.kind === 'tool'" class="flow-item tool-row" :class="{ 'tool-error': f.call.isError }">
                    <summary>
                      <span class="fi-ico">{{ toolIcon(f.call.name) }}</span>
                      <span class="fi-name">{{ f.call.name }}</span>
                      <span class="fi-label">{{ toolLabel(f.call.name) }}</span>
                      <span class="fi-summary">{{ toolSummary(f.call) }}</span>
                      <span class="fi-badge" :class="f.call.isError ? 'bad' : 'ok'">{{ f.call.isError ? '失败' : '成功' }}</span>
                    </summary>
                    <div class="fi-body">
                      <p class="fi-cap">参数</p>
                      <pre class="fi-args">{{ argsText(f.call.args) }}</pre>
                      <p class="fi-cap">结果</p>
                      <pre class="fi-result" :class="{ 'is-error': f.call.isError }">{{ f.call.result }}</pre>
                    </div>
                  </details>
                  <details v-else-if="f.kind === 'images'" class="flow-item tool-row">
                    <summary>
                      <span class="fi-ico">🖼️</span>
                      <span class="fi-name">{{ f.images.tool }}</span>
                      <span class="fi-label">{{ f.images.count }} 张图片</span>
                    </summary>
                    <div class="fi-body dim">已作为图像输入注入模型</div>
                  </details>
                  <details v-else class="flow-item think-row" :class="{ 'think-deep': f.kind === 'deep' }">
                    <summary>
                      <span class="fi-ico">💭</span>
                      <span class="fi-name">{{ f.kind === 'deep' ? '深度思考' : '思考' }}</span>
                      <span class="fi-label">不发送</span>
                      <span class="fi-preview">{{ f.text.replace(/\s+/g, ' ').slice(0, 60) }}</span>
                    </summary>
                    <pre class="fi-think">{{ f.text }}</pre>
                  </details>
                </template>

                <details v-if="detail.error" class="flow-item error-card" open>
                  <summary>
                    <span class="fi-ico">⚠</span>
                    <span class="fi-name">错误</span>
                    <span class="fi-label">运行失败</span>
                    <span class="fi-badge bad">异常</span>
                  </summary>
                  <pre class="fold-body is-error">{{ detail.error }}</pre>
                </details>
                <details v-if="detail.finishReason" class="flow-item finish-card" open>
                  <summary>
                    <span class="fi-ico">🏁</span>
                    <span class="fi-name">finish</span>
                    <span class="fi-label">结束本次</span>
                  </summary>
                  <pre class="fold-body">{{ detail.finishReason }}</pre>
                </details>
              </div>
            </details>
          </template>
        </div>
      </aside>
    </transition>

    <!-- 晚安整理结果 toast：成功条数/失败原因逐项如实；点击即关（8s 自灭） -->
    <transition name="evening-toast">
      <div
        v-if="eveningToast"
        class="evening-toast"
        :class="eveningToast.kind"
        role="status"
        @click="eveningToast = null"
      >
        {{ eveningToast.text }}
      </div>
    </transition>
  </section>
</template>

<style scoped>
/* 纸张风：白卡 + 1px 细线分层 + 克制点缀（phase9 §1）。
   S2 设计稿一：列表页随容器占满主列，详情改右滑抽屉（不再双列）。 */
.sessions-page {
  height: 100%;
  min-height: 0;
}

/* ---- 左列表（占满） ---- */
.list-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.list-head {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--line);
}

.list-head h2 {
  font-size: 20px; /* D48：标题 ≥20px（15px → 20px） */
  letter-spacing: 0.12em;
}

/* 晚安整理按钮（night-plan-life §L1）：既有 .btn 口径 + 列表头内的尺寸对齐 */
.evening-btn {
  padding: 1px 10px;
  font-size: 12px;
  white-space: nowrap;
}
.evening-btn:disabled {
  color: var(--ink-2);
}

/* 结果 toast：白卡面 + 1px 细线（与 .card 同纸感），固定右下角；三态只换描边/文字色 */
.evening-toast {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 80;
  max-width: min(520px, 80vw);
  padding: 10px 14px;
  background: var(--card);
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink);
  box-shadow: 0 2px 10px rgba(47, 46, 43, 0.12);
  cursor: pointer;
}
.evening-toast.ok {
  border-color: var(--accent);
  color: var(--accent);
}
.evening-toast.info {
  border-color: var(--line-strong);
  color: var(--ink-2);
}
.evening-toast.bad {
  border-color: var(--ink);
  color: var(--ink);
}
.evening-toast-enter-active,
.evening-toast-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.evening-toast-enter-from,
.evening-toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.sse-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--ink-2);
  letter-spacing: 0.08em;
}

.sse-hint.ok {
  color: var(--accent);
}

.list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-1);
}

/* 粘性分组头：小字 + 呼吸间距（设计稿一视觉规格；组头颜色 --ink-2 级） */
.day-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  margin: var(--space-3) 0 4px;
  padding: 4px 10px 2px;
  background: var(--card);
  border-bottom: 1px solid var(--line);
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--ink-2);
  user-select: none;
}

.day-head:first-child {
  margin-top: 0;
}

.dh-count {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--mist-3);
}

.session-item {
  display: block;
  width: 100%;
  padding: 10px;
  margin-bottom: 2px;
  border: 1px solid transparent;
  border-radius: var(--radius-card);
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.session-item:hover {
  border-color: var(--line);
}

.session-item.selected {
  border-color: var(--line-strong);
  background: var(--paper);
}

.session-item.waiting {
  color: var(--ink-2);
}

/* 条目单行：圆点 + 时间 + 她的回应摘要（高度收敛，设计稿一 ~64px → 两行内） */
.si-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

/* 状态圆点（收敛为一枚）：出错=红 / 未回复=琥珀 / 运行·等待=琥珀脉冲 / 正常=无 */
.si-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: transparent;
  align-self: center;
}

.si-dot.dot-warn {
  background: var(--accent);
}

.si-dot.dot-err {
  background: #c0392b; /* 与 Pwa.vue .pwa-note.err 同源的错误红（语义色，唯一例外） */
}

.si-dot.dot-live {
  background: var(--accent);
  animation: si-pulse 1.4s infinite ease-in-out;
}

@keyframes si-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.si-time {
  flex: none;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-2);
}

.si-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.si-summary.dim {
  color: var(--ink-2);
}

.si-sub {
  display: block;
  margin-top: 2px;
  padding-left: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--ink-2);
}

.dim {
  color: var(--ink-2);
}

.list-more {
  padding: var(--space-1);
  text-align: center;
  font-size: 11px;
  color: var(--ink-2);
}

/* ---- 详情抽屉（右滑 480px） ---- */
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 70;
  display: flex;
  flex-direction: column;
  width: min(480px, 94vw);
  border-radius: 0;
  border-top: none;
  border-right: none;
  border-bottom: none;
  border-left: 1px solid var(--line);
  box-shadow: -12px 0 30px -18px rgba(47, 46, 43, 0.35);
}

.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: transform 0.2s ease;
}

.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(100%);
}

.drawer-head {
  flex: none;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-2) var(--space-1);
  border-bottom: 1px solid var(--line);
}

.drawer-when {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ink-2);
}

.drawer-head-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.drawer-close {
  appearance: none;
  padding: 2px 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-card);
  background: var(--card);
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.drawer-close:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.drawer-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2);
}

.drawer-label {
  margin: 0 0 var(--space-1);
  font-size: 11px;
  letter-spacing: 0.25em;
  color: var(--ink-2);
}

.pad {
  padding: var(--space-3);
}

.empty-hint {
  color: var(--ink-2);
  font-size: 13px;
}

/* 对话视角落空提示 / 错误（红=语义色，同 Pwa 口径） */
.conv-idle {
  margin: var(--space-1) 0 0;
  font-size: 12px;
  color: var(--mist-3);
}

.conv-error {
  margin: var(--space-1) 0 0;
  padding: 8px 10px;
  border: 1px solid #c0392b;
  border-radius: var(--radius-card);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: #c0392b;
}

/* 运行细节折叠区：默认收起，展开后承接原工程视图 */
.ops-fold {
  margin-top: var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--card);
}

.ops-fold summary {
  padding: 6px 10px;
  font-size: 12px;
  letter-spacing: 0.06em;
  color: var(--ink-2);
  cursor: pointer;
  user-select: none;
}

.ops-fold summary:hover {
  color: var(--accent);
}

.ops-body {
  padding: var(--space-1) 10px var(--space-2);
  border-top: 1px solid var(--line);
}

.dh-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 4px var(--space-2);
  margin: 0;
  font-size: 12px;
  color: var(--ink-2);
}

.prompt-fold {
  margin-top: var(--space-1);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--paper);
}

.prompt-fold summary {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--ink-2);
  cursor: pointer;
  user-select: none;
}

.fold-body {
  margin: 0;
  padding: var(--space-1) 10px;
  border-top: 1px solid var(--line);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}

.is-error {
  color: var(--ink);
}

.flow-label {
  margin: var(--space-2) 0 var(--space-1);
  font-size: 11px;
  letter-spacing: 0.25em;
  color: var(--ink-2);
}

/* user 气泡 */
.user-bubble {
  max-width: 92%;
  margin: 0 0 var(--space-1) 0;
  padding: var(--space-1) 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-card);
  background: var(--paper);
}

.role-tag {
  margin: 0;
  font-size: 10px;
  letter-spacing: 0.2em;
  color: var(--ink-2);
}

.msg-text {
  margin: 4px 0 0;
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap; /* 文本保留换行 */
  word-break: break-word;
}

/* 她说的话（对话视角主阅读面）：陶土竖线 + 衬线（全站非对称消息布局同款） */
.her-lines {
  margin: var(--space-1) 0 0;
}

.her-line {
  padding: 2px 0 2px 14px;
  border-left: 2px solid var(--warm);
}

.her-line + .her-line {
  margin-top: var(--space-1);
}

.sent-at {
  margin: 0;
  font-size: 10px;
  letter-spacing: 0.15em;
  color: var(--accent);
}

.her-line .msg-text {
  font-family: var(--font-serif);
  font-size: 14px;
  line-height: 1.9;
}

/* bot 处理流：思考折叠（Q16）与工具行 */
.flow-item {
  margin: 6px 0 6px auto;
  max-width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--card);
}

.flow-item summary {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.flow-item summary::-webkit-details-marker {
  display: none;
}

.fi-ico {
  flex: none;
  font-size: 12px;
}

.fi-name {
  flex: none;
  font-size: 12px;
  color: var(--ink);
}

.fi-label {
  flex: none;
  font-size: 11px;
  color: var(--ink-2);
}

.fi-preview,
.fi-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--ink-2);
}

.fi-badge {
  flex: none;
  padding: 0 6px;
  border-radius: 4px;
  border: 1px solid var(--line-strong);
  font-size: 10px;
  line-height: 18px;
  color: var(--ink-2);
}

.fi-badge.ok {
  color: var(--accent);
}

.fi-badge.bad {
  border-color: var(--ink);
  color: var(--ink);
}

.fi-body {
  padding: var(--space-1) 10px;
  border-top: 1px solid var(--line);
  font-size: 12px;
}

.fi-cap {
  margin: 4px 0 2px;
  font-size: 10px;
  letter-spacing: 0.2em;
  color: var(--ink-2);
}

.fi-args,
.fi-result {
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--paper);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 260px;
  overflow-y: auto;
}

.fi-think {
  margin: 0;
  padding: var(--space-1) 10px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap; /* 思考文本保留换行 */
  word-break: break-word;
  max-height: 420px;
  overflow-y: auto;
}

/* 深度思考气泡：细线强调，名字用 accent（克制） */
.think-deep {
  border-color: var(--line-strong);
}

.think-deep .fi-name {
  color: var(--accent);
}

.error-card,
.finish-card {
  max-width: 100%;
}

/* ---- 窄窗：列表占满，抽屉已自适应（min(480px, 94vw)） ---- */
@media (max-width: 1000px) {
  .list-pane {
    max-height: none;
  }
}
</style>
