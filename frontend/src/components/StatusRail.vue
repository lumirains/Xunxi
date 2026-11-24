<script setup lang="ts">
// 右侧常驻状态栏（phase9-plan §2）：数据源 GET /api/person/state，10s 轮询。
// 后端对每个子项防御式返回 null（src/routes.js 聚合快照），本组件逐格可空：
// 任何一格缺失只降级显示「—」，不拖垮整栏；请求失败保留旧值并提示，轮询继续。
//
// 2026-11-16「灯下」重做：整栏改成一张浮起的卡片（此刻 · 她），
// 她的名字用陶土（--warm）。
// 2026-11-21 数值清理：潮位管（relationship.attitude.valence 档位）与心绪数值点
// （mood valence 透明度）整体移除——对应数值轴已丢弃，UI 不再展示无消费方的数值。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { onStatusNudge } from '../lib/statusNudge'
import { badgeMark, onEveningResult, type EveningDetail } from '../lib/eveningBus'

interface MindState {
  mood?: { text?: string }
  preoccupations?: Array<{ id?: string; text?: string }>
}
/** 今日日程 plan（life-prose v2 形状；/api/person/state 的 lifeToday =
 *  personLife.planForDay(今天)，plansByDay[今天] 权威取值——routes.js:1457） */
interface PlanItem {
  time?: string
  activity?: string
  /** life tick 消费时间戳：有值=这件事已经发生（与提示词渲染口径一致） */
  consumedAt?: number | string | null
}
interface LifeToday {
  date?: string
  dayKey?: string
  items?: PlanItem[]
  prose?: string
  mood?: string
}
interface PersonState {
  self?: unknown
  mind?: MindState | null
  /** 生活模块开关（config.modules.life.enabled，缺省 true）——false 时今日段显示"未开启" */
  lifeEnabled?: boolean
  /** 她的名字（config.persona.botName，后端兜底"汐"）——不写死在 UI */
  botName?: string
  /** 自定义头像 mtime（0=未设置，回落内置圆徽章） */
  avatarTs?: number
  lifeToday?: LifeToday | null
  sleep?: { asleep?: boolean; awakeUntil?: number } | null
  now?: number
}

const POLL_MS = 10_000

const state = ref<PersonState | null>(null)
const unreachable = ref(false)
let timer: number | undefined
let inflight = false
// 会话页联动信号（statusNudge）的退订句柄
let offNudge: (() => void) | undefined
// 晚安整理结果（eveningBus）的退订句柄
let offEvening: (() => void) | undefined

async function poll(): Promise<void> {
  if (inflight) return
  inflight = true
  try {
    const res = await fetch('/api/person/state', { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    state.value = (await res.json()) as PersonState
    unreachable.value = false
  } catch {
    // 优雅降级：保留旧数据，仅标记不可得；已有数据继续展示。
    unreachable.value = true
  } finally {
    inflight = false
  }
}

onMounted(() => {
  void poll()
  timer = window.setInterval(() => void poll(), POLL_MS)
  // 会话页在会话级事件（session-start/end、chat-update）时经 statusNudge
  // 广播过来，这里立即补刷一次 —— 等价旧 UI refreshStatus() 的调用点口径
  //（02-sse-sessions.js L6-81）；poll 自带 inflight 防重入，密集信号安全。
  offNudge = onStatusNudge(() => { void poll() })
  // 晚安整理结果（S2 设计稿六）：按钮面发布 → 常驻三行明细（Bug2 反馈断链修复）
  offEvening = onEveningResult(showEvening)
})
onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer)
  if (offNudge) { offNudge(); offNudge = undefined }
  if (offEvening) { offEvening(); offEvening = undefined }
  if (eveningFoldTimer !== undefined) window.clearTimeout(eveningFoldTimer)
})

// ---- 逐格取数（全部可空）----
const moodText = computed(() => state.value?.mind?.mood?.text?.trim() || '')
const worries = computed(() =>
  (state.value?.mind?.preoccupations ?? [])
    .map((p) => String(p?.text ?? '').trim())
    .filter(Boolean)
    .slice(0, 3),
)
// 她的名字与头像：读配置（persona.botName，缺省"汐"）；自定义头像未设置回落内置圆徽章
const botName = computed(() => state.value?.botName?.trim() || '汐')
const avatarSrc = computed(() =>
  state.value?.avatarTs ? `/api/avatar?v=${state.value.avatarTs}` : '/icons/avatar-128.png',
)

// ---- 今天要做什么（S2 设计稿六修 Bug2 数据断链）----
// 旧读数 lifeToday?.ongoing 是旧日程插件形状（life-prose v2 后恒空 → 该区
// 恒空=反馈断链的数据面）。新读数 = lifeToday.items（= plansByDay[今天].items，
// routes.js planForDay 权威三层回退），条目 = 时间 + 事项；已消费（consumedAt
// 有值）标「已发生」——与 prompt.js renderLegacyLifeTodaySection 的提示词
// 渲染口径（`- HH:MM 事项（已发生）`）一致。
const todayPlan = computed<LifeToday | null>(() => state.value?.lifeToday ?? null)
const planItems = computed(() =>
  (Array.isArray(todayPlan.value?.items) ? todayPlan.value?.items ?? [] : [])
    .map((i) => ({
      time: String(i?.time ?? '').trim(),
      activity: String(i?.activity ?? '').trim(),
      done: Boolean(i?.consumedAt),
    }))
    .filter((i) => i.activity)
    .slice(0, 6),
)

// ---- 晚安整理明细（S2 设计稿六修 Bug2 反馈断链）----
// 按钮面（Sessions/Pwa）经 eveningBus 广播结构化结果 → 常驻三行明细
// （卡片 ✓ / 日记 ✓ / 明日日程 ✓，各带状态）；8s 后仅折叠为角标（点击再展开）。
const evening = ref<EveningDetail | null>(null)
const eveningFolded = ref(false)
let eveningFoldTimer: number | undefined

function showEvening(d: EveningDetail): void {
  evening.value = d
  eveningFolded.value = false
  if (eveningFoldTimer !== undefined) window.clearTimeout(eveningFoldTimer)
  // 「淡出」= 8s 后折叠至角标（不再消失——明细常驻可回看，设计稿六.3）
  eveningFoldTimer = window.setTimeout(() => {
    eveningFolded.value = true
    eveningFoldTimer = undefined
  }, 8000)
}

function dismissEvening(): void {
  evening.value = null
  eveningFolded.value = false
  if (eveningFoldTimer !== undefined) {
    window.clearTimeout(eveningFoldTimer)
    eveningFoldTimer = undefined
  }
}

const asleep = computed<boolean | null>(() => {
  const s = state.value?.sleep
  if (!s || typeof s !== 'object') return null
  return typeof s.asleep === 'boolean' ? s.asleep : null
})
const sleepText = computed(() => {
  const a = asleep.value
  return a === null ? '——' : a ? '睡着了' : '醒着'
})
</script>

<template>
  <aside class="rail">
    <div class="now-card">
      <h2 class="rail-title">{{ botName }} · 此刻</h2>

      <!-- 她：头像 + 名字（陶土）+ 醒或睡 -->
      <div class="persona">
        <img class="persona-avatar" :src="avatarSrc" :alt="botName" width="54" height="54" />
        <div class="persona-info">
          <b>{{ botName }}</b>
          <span class="persona-state">{{ sleepText }}</span>
        </div>
      </div>

      <section class="block">
        <p class="label">心绪</p>
        <p class="value mood">
          <span v-if="moodText" class="mood-dot" aria-hidden="true"></span><span v-if="moodText">{{ moodText }}</span>
          <span v-else class="empty">—</span>
        </p>
      </section>

      <section class="block">
        <p class="label">挂心事 <span class="count">×{{ worries.length }}</span></p>
        <ul v-if="worries.length" class="list">
          <li v-for="w in worries" :key="w">{{ w }}</li>
        </ul>
        <p v-else class="empty value">暂无挂心事</p>
      </section>

      <section class="block">
        <p class="label">今天要做什么</p>
        <ul v-if="planItems.length" class="list plan-list">
          <li v-for="(p, i) in planItems" :key="i" :class="{ 'is-done': p.done }">
            <span v-if="p.time" class="plan-time">{{ p.time }}</span>{{ p.activity }}
            <span v-if="p.done" class="plan-done">已发生</span>
          </li>
        </ul>
        <!-- 生活模块关闭时说明去处在哪开（右栏说明，所有者 2026-11-21 要求） -->
        <p v-else-if="state?.lifeEnabled === false" class="empty value">日程未开启 · 设置 → 记忆整理 → 她的生活</p>
        <p v-else class="empty value">今天还没有安排</p>
      </section>

      <!-- 晚安整理明细（S2 设计稿六修 Bug2）：常驻三行，8s 后仅折叠为角标 -->
      <section v-if="evening && !eveningFolded" class="block evening-block">
        <p class="label">
          晚安整理
          <button type="button" class="evening-x" title="收起明细" @click="dismissEvening">✕</button>
        </p>
        <ul class="list evening-list">
          <li
            v-for="b in evening.badges"
            :key="b.label"
            class="evening-line"
            :class="{ ok: b.state === 'ok', bad: b.state === 'bad' }"
          >
            <span class="evening-mark">{{ badgeMark(b.state) }}</span>
            <span class="evening-item">{{ b.label }}</span>
            <span class="evening-note">{{ b.note }}</span>
          </li>
        </ul>
      </section>

      <!-- 折叠角标：明细淡出后的常驻入口（点击再展开） -->
      <button
        v-if="evening && eveningFolded"
        type="button"
        class="evening-badge"
        :class="evening.kind"
        title="查看晚安整理明细"
        @click="eveningFolded = false"
      >
        晚安整理 · {{ evening.badges.map((b) => badgeMark(b.state)).join('') }}
      </button>

      <p class="footnote">
        <template v-if="unreachable">状态暂不可得 · 每 10 秒重试</template>
        <template v-else>每 10 秒刷新</template>
      </p>
    </div>
  </aside>
</template>

<style scoped>
/* ============================================================
   「灯下」右栏：一张浮起来的卡片（此刻 · 她）
   —— 卡片不描边，靠亮度分层；左上角一团极淡的暖光 = 台灯照着
   ============================================================ */
.rail {
  padding: var(--space-3) 22px;
  border-left: 1px solid var(--line);
  background: var(--paper);
  overflow: auto;
}

.now-card {
  position: relative;
  overflow: hidden;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 20px 20px 18px;
  box-shadow: var(--shadow);
}

/* 灯：唯一允许的渐变，是光源不是装饰 */
.now-card::before {
  content: "";
  position: absolute;
  inset: 0;
  background: var(--lamp);
  pointer-events: none;
}

.now-card > * {
  position: relative;
}

.rail-title {
  font-family: var(--font-serif);
  font-weight: 400;
  font-size: 19px;
  letter-spacing: 0.16em;
  color: var(--ink-strong);
}

/* 她：头像带一圈琥珀细光 */
.persona {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 0 18px;
}

.persona-avatar {
  width: 54px;
  height: 54px;
  border-radius: 50%;
  display: block;
  box-shadow: var(--ring);
}

.persona-info b {
  display: block;
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 16px;
  letter-spacing: 0.16em;
  color: var(--warm);
}

.persona-state {
  font-size: 12px;
  color: var(--ink-2);
}

.block {
  padding: 15px 0;
  border-top: 1px solid var(--line);
}

.persona + .block {
  border-top: none;
  padding-top: 0;
}

.label {
  margin: 0 0 9px;
  color: var(--mist-3);
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

.count {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0;
}

/* 心绪：她的声音用衬线 */
.value {
  margin: 0;
  font-size: 13px;
}

.mood {
  font-family: var(--font-serif);
  font-size: 15.5px;
  line-height: 1.9;
  color: var(--warm);
}

.mood-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 8px;
  vertical-align: middle;
  border-radius: 50%;
  background: var(--warm);
  opacity: 0.9;
}

.empty {
  color: var(--mist-3);
}

/* 挂心事 / 今天要做什么：她的措辞，衬线 */
.list li {
  position: relative;
  margin-top: 4px;
  padding-left: 15px;
  font-family: var(--font-serif);
  font-size: 14.5px;
  line-height: 1.95;
  color: var(--ink-2);
}

.list li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 12px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--warm);
  opacity: 0.55;
}

/* 日程条目（设计稿六）：时间等宽小字；已发生=整条降饱和 + 琥珀小标注
   （与提示词渲染口径 `- HH:MM 事项（已发生）` 对齐） */
.plan-time {
  margin-right: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--mist-3);
}

.plan-list li.is-done {
  color: var(--mist-3);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--mist-3) 55%, transparent);
  text-decoration-thickness: 1px;
}

.plan-done {
  margin-left: 6px;
  padding: 0 5px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.08em;
  color: var(--accent);
  white-space: nowrap;
}

/* 晚安整理明细（设计稿六.3）：常驻三行，淡出仅折叠至角标 */
.evening-block .label {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.evening-x {
  appearance: none;
  padding: 0 5px;
  border: none;
  background: transparent;
  color: var(--mist-3);
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
}

.evening-x:hover {
  color: var(--accent);
}

.evening-list li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding-left: 0;
  font-size: 12.5px;
  line-height: 1.7;
}

.evening-list li::before {
  display: none;
}

.evening-mark {
  flex: none;
  font-family: var(--font-mono);
  color: var(--mist-3);
}

.evening-list li.ok .evening-mark {
  color: var(--olive);
}

.evening-list li.bad .evening-mark {
  color: #c0392b;
}

.evening-item {
  flex: none;
  color: var(--ink);
}

.evening-note {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--mist-3);
}

/* 角标：明细 8s 后折叠至此（常驻可回看，点击展开） */
.evening-badge {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: var(--space-2);
  padding: 3px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--card);
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.evening-badge:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.evening-badge.ok {
  color: var(--olive);
}

.evening-badge.bad {
  border-color: #c0392b;
  color: #c0392b;
}

.footnote {
  margin: var(--space-3) 0 0;
  color: var(--mist-3);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
}
</style>
