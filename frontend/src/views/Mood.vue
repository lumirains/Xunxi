<script setup lang="ts">
// ============================================================
// 15b 心绪时间线（phase9-plan §5 D43）：
//   · 当前 = GET /api/person/state 的 mind（mood 数值轴 + 心绪文本 +
//     preoccupations 挂心事）；数值可视化用 --warm（§1 唯一暖色豁免位）
//   · 历史 = GET /api/person/cards 的 mood 字段按日期倒序（卡片即每天的
//     巩固产物，mood 是她当天的心绪一句话）
// ============================================================
import { computed, onMounted, ref } from 'vue'
import { fetchCards, fetchPersonState } from '../lib/api'
import { fmtTime } from '../lib/format'
import type { MemoryCard, MindState } from '../lib/types'

const mind = ref<MindState | null>(null)
const cards = ref<MemoryCard[]>([])
const loading = ref(false)
const loadError = ref('')

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const [state, cardData] = await Promise.all([fetchPersonState(), fetchCards()])
    mind.value = state.mind ?? null
    cards.value = cardData.cards   // /api/person/cards 已按日期倒序（routes.js）
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

// ---- （2026-11-21 数值清理）valence/arousal/energy 数值条已移除——
// 数值轴不进提示词即丢弃（所有者裁定），本页只呈现文字：心绪一句话、挂心事、历史时间线。

const moodText = computed(() => mind.value?.mood?.text?.trim() || '')

const preoccupations = computed(() => {
  const list = Array.isArray(mind.value?.preoccupations) ? [...mind.value!.preoccupations!] : []
  list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  return list
})

/** 心事还剩多久过期（72h TTL）；<1h 显示分钟 */
function remaining(expiresAt?: number): string {
  if (!Number.isFinite(Number(expiresAt))) return ''
  const ms = Number(expiresAt) - Date.now()
  if (ms <= 0) return '即将淡去'
  const h = ms / 3600_000
  return h >= 1 ? `还有 ${Math.floor(h)} 小时` : `还有 ${Math.max(1, Math.floor(ms / 60_000))} 分钟`
}

/** 历史时间线：有 mood 文本的卡（日期倒序已由后端保证，这里防御性再排一次） */
const moodTimeline = computed(() => {
  const list = cards.value.filter((c) => typeof c.mood === 'string' && c.mood.trim())
  list.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
  return list
})

onMounted(() => { void load() })
</script>

<template>
  <div class="mood-page">
    <div class="page-head">
      <p class="head-note" :class="{ err: loadError }">
        <template v-if="loadError">加载失败：{{ loadError }}</template>
        <template v-else-if="loading">读取中…</template>
        <template v-else>此刻 · {{ fmtTime(mind?.mood?.updatedAt) }}</template>
      </p>
      <button class="btn" :disabled="loading" @click="load">刷新</button>
    </div>

    <!-- 此刻 -->
    <section class="card block">
      <h2 class="section-title">此刻</h2>
      <p class="mood-now">
        <template v-if="moodText">{{ moodText }}</template>
        <span v-else class="empty">—（还没有心绪一句话）</span>
      </p>
    </section>

    <!-- 挂心事 -->
    <section class="card block">
      <h2 class="section-title">挂心事 · {{ preoccupations.length }}</h2>
      <ul v-if="preoccupations.length" class="worries">
        <li v-for="p in preoccupations" :key="p.id ?? p.text" class="worry">
          <span class="worry-text">{{ p.text }}</span>
          <span class="badge">{{ p.source || 'mind' }}</span>
          <span class="worry-ttl">{{ remaining(p.expiresAt) }}</span>
        </li>
      </ul>
      <p v-else class="empty">没有挂着的事</p>
    </section>

    <!-- 历史：卡片 mood 按日期倒序 -->
    <section class="card block">
      <h2 class="section-title">心绪时间线 · 记忆卡里的每一天</h2>
      <ul v-if="moodTimeline.length" class="timeline">
        <li v-for="c in moodTimeline" :key="c.date" class="tl-item">
          <span class="tl-date">{{ c.date }}</span>
          <span class="tl-mood">{{ c.mood }}</span>
          <span class="key-num tl-salience">{{ c.salience ?? '—' }}</span>
        </li>
      </ul>
      <p v-else class="empty">还没有带心绪记录的记忆卡</p>
    </section>
  </div>
</template>

<style scoped>
.mood-page {
  /* S2 设计稿五：阅读型页主列 1040（原 720——P1-5 大屏空白） */
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

.mood-now {
  margin: var(--space-2) 0 0;
  font-family: var(--font-serif);
  font-size: 17px;
  line-height: 1.9;
  color: var(--ink-strong);
}

/* （2026-11-21 数值清理）.axes/.axis-* 数值条样式已随数值可视化一并移除 */

.worries {
  margin-top: var(--space-2);
}

.worry {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  padding: 6px 0;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}

.worry:last-child {
  border-bottom: none;
}

.worry-text {
  flex: 1;
  min-width: 0;
}

.worry-ttl {
  color: var(--ink-2);
  font-size: 11px;
  font-family: var(--font-mono);
}

.timeline {
  margin-top: var(--space-1);
}

.tl-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 7px 0;
  border-bottom: 1px solid var(--line);
}

.tl-item:last-child {
  border-bottom: none;
}

.tl-date {
  flex: none;
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 12px;
}

.tl-mood {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}

.tl-salience {
  flex: none;
  font-size: 11px;
}

.empty {
  margin: var(--space-2) 0 0;
  color: var(--ink-2);
  font-size: 13px;
}
</style>
