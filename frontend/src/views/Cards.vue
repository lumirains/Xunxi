<script setup lang="ts">
// ============================================================
// 15d 记忆卡片库 + 15e 巩固历史（并入卡片库，D43）：
//   · 顶部 staging 原料分区 = GET /api/person/staging（remember 追加的
//     当日暂存，remember 不调模型——原料 ≠ 记忆）。**只保留今天**：
//     后端 remember/stagingDays 会清掉非当天行（所有者 2026-11-18），
//     所以这里永远只渲染今天这一天，历史原料不展示、不存档。
//   · 巩固历史 = 各日记忆卡的紧凑总览（日期/来源/显著度/条数）：
//     卡片由 reflection 执行器经 memory.writeCard 落盘（executor.js L510），
//     按日一行即"哪天做过巩固"
//   · 卡片逐张 = GET /api/person/cards（已按日期倒序）：date/salience/
//     source 徽标/events/facts/promises/open_loops/mood
// 长期事实（active）在卡片之前列出作参照（口径同后端 facts({status:'active'})；
// 所有者 2026-11-18 要求：facts 属于"稳定知道的事"，先于逐日卡片被读到）。
// ============================================================
import { computed, onMounted, ref } from 'vue'
import { fetchCards, fetchStaging } from '../lib/api'
import { fmtClock } from '../lib/format'
import type { ActiveFact, MemoryCard, StagingEntry } from '../lib/types'

const cards = ref<MemoryCard[]>([])
// 近七天视图（2026-11-21 所有者：默认只展示近七天的卡，点「查看更多」展开全部）
const expanded = ref(false)
const sevenDaysAgoStr = computed(() => {
  const d = new Date(Date.now() - 7 * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})
const visibleCards = computed(() =>
  expanded.value ? cards.value : cards.value.filter((c) => String(c.date || '') >= sevenDaysAgoStr.value),
)
const hiddenCount = computed(() => cards.value.length - visibleCards.value.length)
const facts = ref<ActiveFact[]>([])
const stagingDays = ref<Array<{ day: string; entries: StagingEntry[] }>>([])
const loading = ref(false)
const loadError = ref('')

const FACT_KIND_LABEL: Record<string, string> = {
  address_name: '称呼',
  identity: '身份',
  job: '职业',
  like: '喜欢',
  dislike: '不喜欢',
  taboo: '忌讳',
  promise: '承诺',
  relationship: '关系',
  routine: '习惯',
  important_date: '重要日子',
}

function factKindLabel(kind?: string): string {
  const k = String(kind || '')
  return FACT_KIND_LABEL[k] || k || '事实'
}

const SOURCE_LABEL: Record<string, string> = {
  model: '模型巩固',
  fallback: '兜底',
  fixture: '样例',
  chat: '聊天',
  manual: '手工',
}

function sourceLabel(s?: string): string {
  const k = String(s || '')
  return SOURCE_LABEL[k] || (k || '未知来源')
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const [cardData, stagingData] = await Promise.all([fetchCards(), fetchStaging()])
    cards.value = cardData.cards
    facts.value = cardData.facts
    stagingDays.value = stagingData.days
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

const stagingTotal = computed(() => stagingDays.value.reduce((n, d) => n + d.entries.length, 0))
const factCount = (c: MemoryCard): number => (Array.isArray(c.facts) ? c.facts.length : 0)
const promiseCount = (c: MemoryCard): number => (Array.isArray(c.promises) ? c.promises.length : 0)
const loopCount = (c: MemoryCard): number => (Array.isArray(c.open_loops) ? c.open_loops.length : 0)

onMounted(() => { void load() })
</script>

<template>
  <div class="cards-page">
    <div class="page-head">
      <p class="head-note" :class="{ err: loadError }">
        <template v-if="loadError">加载失败：{{ loadError }}</template>
        <template v-else-if="loading">读取中…</template>
        <template v-else>卡片 {{ cards.length }} 张 · 长期事实 {{ facts.length }} 条 · 原料 {{ stagingTotal }} 条</template>
      </p>
      <button class="btn" :disabled="loading" @click="load">刷新</button>
    </div>

    <!-- staging 原料分区（顶部）：只有今天（后端已清非当天行） -->
    <section class="card block">
      <h2 class="section-title">原料 · staging（今天 remember 记下的候选）</h2>
      <template v-if="stagingDays.length">
        <div v-for="d in stagingDays" :key="d.day" class="staging-day">
          <p class="staging-day-head">
            <span class="mono">{{ d.day }}</span>
            <span class="count">{{ d.entries.length }} 条</span>
          </p>
          <ul v-if="d.entries.length" class="staging-list">
            <li v-for="(e, i) in d.entries" :key="i" class="staging-item">
              <span class="mono staging-time">{{ fmtClock(e.at) }}</span>
              <span class="badge">{{ e.source || 'chat' }}</span>
              <span class="staging-text">{{ e.text }}</span>
            </li>
          </ul>
          <p v-else class="empty-inline">（当天文件为空）</p>
        </div>
      </template>
      <p v-else class="empty">今天还没有原料（她还没调用 remember）</p>
    </section>

    <!-- 长期事实参照（所有者 2026-11-18：从页底上移到卡片之前——facts 是她"稳定知道的事"，
         应当先于逐日卡片被读到，而不是翻完所有卡才在最后遇见） -->
    <section class="card block">
      <h2 class="section-title">长期事实 · active（{{ facts.length }}）</h2>
      <ul v-if="facts.length" class="plain-list">
        <li v-for="f in facts" :key="f.key" class="fact-row">
          <span class="badge">{{ factKindLabel(f.kind) }}</span>
          <span class="badge">{{ f.subject === 'other' ? '他' : f.subject === 'self' ? '她' : '我们' }}</span>
          <span>{{ f.content }}</span>
        </li>
      </ul>
      <p v-else class="empty">还没有长期事实</p>
    </section>

    <!-- 巩固历史（15e，并入卡片库）：逐日总览 -->
    <section class="card block">
      <h2 class="section-title">巩固历史 · 逐日总览</h2>
      <table v-if="cards.length" class="overview-table">
        <thead>
          <tr><th>日期</th><th>来源</th><th>显著度</th><th>事件</th><th>事实</th><th>承诺</th><th>未闭环</th></tr>
        </thead>
        <tbody>
          <tr v-for="c in visibleCards" :key="c.date">
            <td class="mono">{{ c.date }}</td>
            <td><span class="badge">{{ sourceLabel(c.source) }}</span></td>
            <td class="key-num">{{ c.salience ?? '—' }}</td>
            <td class="mono">{{ (c.events ?? []).length }}</td>
            <td class="mono">{{ factCount(c) }}</td>
            <td class="mono">{{ promiseCount(c) }}</td>
            <td class="mono">{{ loopCount(c) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">还没有记忆卡</p>
    </section>

    <!-- 卡片逐张 -->
    <!-- 卡片（默认近七天 · 2026-11-21 所有者） -->
    <div class="cards-window-head">
      <button class="btn btn-sm" @click="expanded = !expanded">
        {{ expanded ? '收起，只看近七天' : `查看更多（还有 ${hiddenCount} 张更早的）` }}
      </button>
      <span class="hint">{{ expanded ? `全部 ${cards.length} 张` : `近七天 ${visibleCards.length} 张 / 共 ${cards.length} 张` }}</span>
    </div>
    <section v-for="c in visibleCards" :key="c.date" class="card block card-item">
      <div class="card-head">
        <h3 class="card-date">{{ c.date }}</h3>
        <span class="badge">{{ sourceLabel(c.source) }}</span>
        <span class="salience">显著度 <span class="key-num">{{ c.salience ?? '—' }}</span></span>
        <span v-if="c.range?.from != null && c.range?.to != null" class="range mono">消息 {{ c.range.from }}–{{ c.range.to }}</span>
      </div>

      <template v-if="(c.events ?? []).length">
        <p class="sub-label">事件</p>
        <ul class="plain-list">
          <li v-for="(ev, i) in c.events" :key="i">{{ ev }}</li>
        </ul>
      </template>

      <template v-if="(c.facts ?? []).length">
        <p class="sub-label">事实</p>
        <ul class="plain-list">
          <li v-for="(f, i) in c.facts" :key="i">
            <span class="badge">{{ factKindLabel(f.kind) }}</span>
            <span class="fact-content">{{ f.content }}</span>
          </li>
        </ul>
      </template>

      <template v-if="(c.promises ?? []).length">
        <p class="sub-label">承诺</p>
        <ul class="plain-list">
          <li v-for="(p, i) in c.promises" :key="i" class="promise-item">
            <span>{{ p.text }}</span>
            <span v-if="p.due" class="mono">期限 {{ p.due }}</span>
            <span class="badge" :class="{ 'badge-accent': p.status && p.status !== 'done' }">{{ p.status || 'pending' }}</span>
          </li>
        </ul>
      </template>

      <template v-if="(c.open_loops ?? []).length">
        <p class="sub-label">未闭环</p>
        <ul class="plain-list">
          <li v-for="(l, i) in c.open_loops" :key="i">{{ l }}</li>
        </ul>
      </template>

      <template v-if="c.mood">
        <p class="sub-label">心绪</p>
        <p class="card-mood">{{ c.mood }}</p>
      </template>

      <p v-if="!(c.events ?? []).length && !factCount(c) && !promiseCount(c) && !loopCount(c) && !c.mood" class="empty">
        （这张卡是空的）
      </p>
    </section>
  </div>
</template>

<style scoped>
.cards-page {
  /* S2 设计稿五：阅读型页主列 1040（原 760——P1-5 大屏空白） */
  max-width: 1040px;
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

.block {
  padding: var(--space-2);
}

.staging-day + .staging-day {
  margin-top: var(--space-2);
}

.staging-day-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0 0 4px;
}

.mono {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-2);
}

.count {
  color: var(--ink-2);
  font-size: 11px;
}

.staging-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  padding: 4px 0;
  font-size: 13px;
}

.staging-time {
  flex: none;
}

.staging-text {
  flex: 1;
  min-width: 0;
}

.overview-table {
  width: 100%;
  margin-top: var(--space-2);
  border-collapse: collapse;
  font-size: 12px;
}

.overview-table th {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line-strong);
  color: var(--ink-2);
  font-weight: normal;
  font-size: 11px;
  letter-spacing: 0.15em;
}

.overview-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}

.overview-table .mono {
  font-size: 11px;
}

.card-item + .card-item {
  margin-top: 0;
}

.card-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.card-date {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 20px; /* D48：标题 ≥20px（17px → 20px） */
  color: var(--ink-strong);
}

.salience {
  color: var(--ink-2);
  font-size: 12px;
}

.range {
  margin-left: auto;
}

.sub-label {
  margin: var(--space-2) 0 4px;
  color: var(--ink-2);
  font-size: 11px;
  letter-spacing: 0.25em;
}

.plain-list li {
  padding: 3px 0;
  font-size: 13px;
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}

.plain-list li::before {
  content: none;
}

.fact-content,
.plain-list li span:last-child {
  min-width: 0;
}

.promise-item span:first-child {
  flex: 1;
  min-width: 0;
}

.card-mood {
  margin: 0;
  padding: 6px 10px;
  border-left: 2px solid var(--warm);
  background: var(--paper);
  font-family: var(--font-serif);
  font-size: 13px;
  line-height: 1.9;
}

.fact-row span:last-child {
  flex: 1;
  min-width: 0;
}

.empty,
.empty-inline {
  margin: var(--space-2) 0 0;
  color: var(--ink-2);
  font-size: 13px;
}

.empty-inline {
  margin: 0;
  font-size: 12px;
}
/* 近七天窗口切换（2026-11-21） */
.cards-window-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: var(--space-2) 0;
}
</style>
