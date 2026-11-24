<script setup lang="ts">
// ============================================================
// 15f 事件流直播（phase9-plan §5 D43）：
//   · 历史 = GET /api/events/recent?limit=300（尾部 300 条，倒序）
//   · 实时 = SSE /api/events 的 'kernel-event' 事件（routes.js 桥：
//     events.jsonl 落盘成功即广播），追加到顶部，上限 300 条
// 摘要口径：kind 徽标 + 时间 + 文本（空文本显示 ref / 占位）。
// 隐私注意：text 可能含聊天正文——本页仅本地 UI 展示（用途即如此），
// 不打印、不入日志、不入 git。
// ============================================================
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { fetchRecentEvents } from '../lib/api'
import { connectKernelEvents, type SseState } from '../lib/kernelSse'
import { fmtClock, fmtTime } from '../lib/format'
import type { KernelEvent } from '../lib/types'

const LIMIT = 300

const eventsList = ref<KernelEvent[]>([])
const loading = ref(false)
const loadError = ref('')
const sseState = ref<SseState>('reconnecting')

const KIND_LABEL: Record<string, string> = {
  message_in: '收到消息',
  message_out: '发出消息',
  send_message: '发消息',
  send_sticker: '发表情',
  send_poke: '戳一戳',
  send_image: '发图片',
  get_recent_messages: '翻记录',
  mind_note: '记心绪',
  mind_settle: '放下心事',
  remember: '记原料',
  web_search: '联网搜索',
  web_fetch: '抓网页',
  finish: '收工',
}

function kindLabel(kind?: string): string {
  const k = String(kind || '')
  return KIND_LABEL[k] || (k || '事件')
}

/** 摘要：text 优先，其次 ref；两者都空 → 占位 */
function summaryOf(e: KernelEvent): string {
  const t = String(e.text ?? '').replace(/\s+/g, ' ').trim()
  if (t) return t.length > 120 ? `${t.slice(0, 120)}…` : t
  const ref = String(e.ref ?? '').trim()
  return ref || '（无内容）'
}

const dedupeKey = (e: KernelEvent): string =>
  `${e.ts ?? 0}|${e.kind ?? ''}|${e.ref ?? ''}|${e.text ?? ''}`

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const r = await fetchRecentEvents(LIMIT)
    eventsList.value = r.events
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

let teardown: (() => void) | undefined

onMounted(() => {
  void load()
  teardown = connectKernelEvents(
    (event) => {
      // 实时追加到顶部；与历史里可能已存在的同一条去重（SSE 与快照竞态）
      const key = dedupeKey(event)
      if (eventsList.value.some((e) => dedupeKey(e) === key)) return
      eventsList.value = [event, ...eventsList.value].slice(0, LIMIT)
    },
    (state) => { sseState.value = state },
  )
})
onUnmounted(() => {
  teardown?.()
  teardown = undefined
})

const liveLabel = computed(() =>
  sseState.value === 'connected' ? '实时已连接' : '实时重连中…',
)

/** 显示时间：今天的只显示时钟，更早的带日期 */
function displayTime(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = new Date()
  return d.toDateString() === now.toDateString() ? fmtClock(ts) : fmtTime(ts)
}

const impactDot = (e: KernelEvent): boolean =>
  typeof e.impact === 'number' && Math.abs(e.impact) > 0.01
</script>

<template>
  <div class="events-page">
    <div class="page-head">
      <p class="head-note" :class="{ err: loadError }">
        <template v-if="loadError">加载失败：{{ loadError }}</template>
        <template v-else-if="loading">读取中…</template>
        <template v-else>最近 {{ eventsList.length }} 条 · {{ liveLabel }}</template>
      </p>
      <div class="head-actions">
        <span class="live-dot" :class="{ on: sseState === 'connected' }" aria-hidden="true"></span>
        <button class="btn" :disabled="loading" @click="load">刷新</button>
      </div>
    </div>

    <section class="card">
      <ul class="event-list">
        <li v-for="(e, i) in eventsList" :key="`${e.ts ?? 0}-${i}`" class="event-item">
          <span class="ev-time">{{ displayTime(e.ts) }}</span>
          <span class="badge">{{ kindLabel(e.kind) }}</span>
          <span class="ev-source">{{ e.source || '—' }}</span>
          <span v-if="impactDot(e)" class="ev-impact" title="impact≠0" aria-hidden="true"></span>
          <span class="ev-summary" :class="{ muted: !String(e.text ?? '').trim() }">{{ summaryOf(e) }}</span>
        </li>
        <li v-if="!eventsList.length && !loading" class="event-item empty">还没有事件（events.jsonl 为空或不可读）</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.events-page {
  /* S2 设计稿五：列表页随容器（原 760 cap 删——P1-5） */
  max-width: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.head-note {
  margin: 0;
  color: var(--ink-2);
  font-size: 12px;
}

.head-note.err {
  color: var(--accent);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

/* 实时指示点：连上=陶橙常亮，断=灰 */
.live-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--line-strong);
}

.live-dot.on {
  background: var(--accent);
}

.card {
  padding: var(--space-1) var(--space-2);
}

.event-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  padding: 7px 0;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}

.event-item:last-child {
  border-bottom: none;
}

.ev-time {
  flex: none;
  width: 118px;
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 11px;
}

.ev-source {
  flex: none;
  width: 44px;
  color: var(--ink-2);
  font-size: 11px;
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ev-impact {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--warm);
  align-self: center;
}

.ev-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ev-summary.muted {
  color: var(--ink-2);
}

.event-item.empty {
  color: var(--ink-2);
  justify-content: center;
  padding: var(--space-3) 0;
}
</style>
