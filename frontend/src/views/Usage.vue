<script setup lang="ts">
// ============================================================
// M3 用量页（phase9-plan §5 D44 + Q17）：
//   端点 100% 复用旧 UI（ui/app/04-archive-usage.js）：
//     GET /api/usage/stats?range=today|7|30|all   （USAGE_RANGES 旧 00-core.js L333）
//     GET /api/usage/breakdown?range&dim&key&by   （旧 L891）
//     GET /api/chats                              （行显示名，旧 chatNameOf 口径）
//   展示维度照旧：五张卡（估算成本/调用次数/搜索次数/输入 token/缓存命中率）
//   + 按天/按会话/按模型三张表 + 行点开交叉明细（峰谷拆分照旧）。
//
//   Q17 按动作分类（对话/巩固/主动）——数据可用性结论（本次逐行读过）：
//     · 用量行来自会话存档逐次调用展开（src/app.js L1884-1920），行字段只有
//       promptTokens/completionTokens/cachedTokens/at/model/vendor/chatKey/sessionId，
//       无动作 tag；
//     · 巩固（反思执行器 src/capabilities/reflection/executor.js L295）与日记
//       （reflection/diary.js L426-438）直接 import llm.chatCompletionFully 调模型，
//       完全不经会话存档 —— 这部分用量现有 /api/usage/* 里根本没有。
//     → 保守降级：本页展示现有维度，并在页内注明「按动作分类需后端补 tag」；
//       已列入 deferred（不硬造数据，D40 只增不改）。
// ============================================================
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { fetchChats, fetchUsageBreakdown, fetchUsageStats } from '../lib/api'
import { chatNameOf, formatChatTitle, fmtTok, fmtYuan } from '../lib/format'
import type { ChatMeta, UsageBreakdown, UsageGroupRow, UsageStats } from '../lib/types'

/** 时间范围按钮（旧 00-core.js USAGE_RANGES 原样） */
const USAGE_RANGES: Array<[string, string]> = [
  ['today', '今日'],
  ['7', '近 7 天'],
  ['30', '近 30 天'],
  ['all', '全部'],
]

const range = ref('7')
const stats = ref<UsageStats | null>(null)
const loading = ref(false)
const loadError = ref('')
let pollTimer: number | null = null

const chats = ref<ChatMeta[]>([])

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    stats.value = await fetchUsageStats(range.value)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadChats(): Promise<void> {
  try {
    chats.value = await fetchChats()
  } catch {
    /* 名单拿不到就用兜底标题（旧 UI chatNameOf 同款静默降级） */
  }
}

function switchRange(v: string): void {
  if (range.value === v) return
  range.value = v
  void load()
}

// ---- 五张卡（旧 updateUsagePage set() 口径逐格对照）----
const totals = computed<UsageGroupRow & { hasPeakModel?: boolean }>(() => stats.value?.totals ?? {})
const runsSub = computed(() => (stats.value?.mode === 'today' ? '今日用量' : stats.value?.rangeLabel || ''))
const searchCount = computed(() => Number(stats.value?.searchCount) || 0)
const searchSub = computed(() => {
  const nSearch = Number(stats.value?.toolCounts?.web_search) || 0
  const nFetch = Number(stats.value?.toolCounts?.web_fetch) || 0
  return searchCount.value ? `搜索 ${nSearch} · 抓网页 ${nFetch}` : '本区间没有联网'
})
const cacheRate = computed(() => `${((Number(totals.value.cacheHitRate) || 0) * 100).toFixed(1)}%`)

// ---- spark 迷你柱图（旧 renderSpark 口径：今日按小时，其余按天，裁掉前导空日）----
const sparks = computed<Record<string, Array<{ label: string; v: number }>>>(() => {
  const mode = stats.value?.mode
  const out: Record<string, Array<{ label: string; v: number }>> = {}

  let labels: string[] = []
  let series: Record<string, number[]> = {}
  if (mode === 'today' && (stats.value?.hours || []).length) {
    const hours = stats.value!.hours!
    labels = hours.map((h) => `${String(h.hour).padStart(2, '0')}:00`)
    series = {
      cost: hours.map((h) => Number(h.cost) || 0),
      runs: hours.map((h) => Number(h.runs) || 0),
      search: hours.map((h) => Number(h.searchCount) || 0),
      promptTokens: hours.map((h) => Number(h.promptTokens) || 0),
      cacheHitRate: hours.map((h) => Number(h.cacheHitRate) || 0),
    }
  } else {
    let list = [...(stats.value?.days ?? [])]
    if (mode === 'all') list = list.slice(-30)
    // 前导全 0 的日子裁掉（旧 L593-598）
    const dayEmpty = (d: { runs?: number; cost?: number; promptTokens?: number; searchCount?: number }): boolean =>
      !(Number(d.runs) || 0) && !(Number(d.cost) || 0) && !(Number(d.promptTokens) || 0) && !(Number(d.searchCount) || 0)
    while (list.length > 1 && dayEmpty(list[0])) list = list.slice(1)
    labels = list.map((d) => String(d.day || ''))
    series = {
      cost: list.map((d) => Number(d.cost) || 0),
      runs: list.map((d) => Number(d.runs) || 0),
      search: list.map((d) => Number(d.searchCount) || 0),
      promptTokens: list.map((d) => Number(d.promptTokens) || 0),
      cacheHitRate: list.map((d) => Number(d.cacheHitRate) || 0),
    }
    if (!list.length) {
      labels = [stats.value?.rangeLabel || '']
      series = {
        cost: [Number(totals.value.cost) || 0],
        runs: [Number(totals.value.runs) || 0],
        search: [searchCount.value],
        promptTokens: [Number(totals.value.promptTokens) || 0],
        cacheHitRate: [Number(totals.value.cacheHitRate) || 0],
      }
    }
  }
  for (const k of Object.keys(series)) {
    out[k] = labels.map((label, i) => ({ label, v: series[k][i] ?? 0 }))
  }
  return out
})

function sparkHeights(key: string): Array<{ h: number; hi: boolean; tip: string }> {
  const list = sparks.value[key] ?? []
  if (!list.length) return []
  const max = Math.max(...list.map((x) => x.v), 0)
  return list.map((x) => {
    const shown = Number.isInteger(x.v) ? x.v.toLocaleString('zh-CN') : x.v.toFixed(2)
    return {
      h: max > 0 ? Math.max(2, Math.round((x.v / max) * 100)) : 2,
      hi: max > 0 && x.v === max,
      tip: x.label ? `${x.label}：${shown}` : shown,
    }
  })
}

// ---- 按天 / 按会话 / 按模型（旧 fill() 口径；模型 >20 行折叠可展开）----
const daysVisible = computed(() => stats.value?.mode === 'days')
const COLLAPSE_AT = 20
const modelsExpanded = ref(false)
const modelsShown = computed<UsageGroupRow[]>(() => {
  const list = stats.value?.models ?? []
  return modelsExpanded.value ? list : list.slice(0, COLLAPSE_AT)
})
const modelsHidden = computed(() => (stats.value?.models ?? []).length - modelsShown.value.length)

// ---- 明细弹窗（旧 openUsageBreakdown：dim × by 二级维度 + 峰谷拆分）----
const bd = ref<{ dim: string; key: string; by: string } | null>(null)
const bdData = ref<UsageBreakdown | null>(null)
const bdLoading = ref(false)
const bdError = ref('')

const BD_TABS: Record<string, Array<[string, string]>> = {
  chat: [
    ['model', '各模型'],
    ['day', '各天'],
  ],
  model: [
    ['chat', '各会话'],
    ['day', '各天'],
  ],
  day: [
    ['model', '各模型'],
    ['chat', '各会话'],
  ],
}
const bdTabs = computed<Array<[string, string]>>(() => (bd.value ? BD_TABS[bd.value.dim] ?? [['model', '各模型']] : []))
const DIM_LABEL: Record<string, string> = { chat: '会话', model: '模型', day: '日期' }

function rowName(dim: string, key: string | undefined, r: UsageGroupRow): string {
  const k = String(key ?? '')
  if (dim === 'day') return k
  if (dim === 'model') return r.vendor ? `${r.vendor}：${r.model}` : String(r.model ?? r.key)
  return formatChatTitle(k, chatNameOf(k, chats.value))
}

async function openBreakdown(dim: string, key?: string): Promise<void> {
  bd.value = { dim, key: String(key ?? ''), by: (BD_TABS[dim] ?? [['model', '各模型']])[0][0] }
  bdData.value = null
  bdError.value = ''
  await loadBreakdown()
}

async function loadBreakdown(): Promise<void> {
  if (!bd.value) return
  bdLoading.value = true
  bdError.value = ''
  try {
    bdData.value = await fetchUsageBreakdown(range.value, bd.value.dim, bd.value.key, bd.value.by)
  } catch (e) {
    bdError.value = e instanceof Error ? e.message : String(e)
  } finally {
    bdLoading.value = false
  }
}

function switchBy(by: string): void {
  if (!bd.value || bd.value.by === by) return
  bd.value = { ...bd.value, by }
  void loadBreakdown()
}

function closeBreakdown(): void {
  bd.value = null
  bdData.value = null
}

// ---- 峰谷拆分（旧 peakSplitHtml 口径）----
const peak = computed(() => {
  const t = bdData.value?.totals
  if (!t?.hasPeakModel) return null
  if (!((Number(t.peakCost) || 0) > 0 || (Number(t.offPeakCost) || 0) > 0)) return null
  return {
    peakCost: Number(t.peakCost) || 0,
    offPeakCost: Number(t.offPeakCost) || 0,
    ratio: Number(t.peakRatio) || 0,
  }
})

function chatTitleOf(key?: string): string {
  const k = String(key ?? '')
  return formatChatTitle(k, chatNameOf(k, chats.value))
}

function displayName(r: UsageGroupRow): string {
  return r.vendor ? `${r.vendor}：${r.model ?? r.key}` : String(r.model ?? r.key)
}

onMounted(() => {
  void load()
  void loadChats()
  // 轮询 15s（旧 UI 轮询口径）：只更新数值不重建骨架
  pollTimer = window.setInterval(() => {
    void load()
  }, 15000)
})
onBeforeUnmount(() => {
  if (pollTimer) window.clearInterval(pollTimer)
})
</script>

<template>
  <div class="usage-page">
    <div class="page-head">
      <p class="head-note" :class="{ err: loadError }">
        <template v-if="loadError">用量加载失败：{{ loadError }}</template>
        <template v-else-if="loading">统计中…（冷启动要遍历会话存档，可能要等一会）</template>
        <template v-else>{{ stats?.rangeLabel || '—' }} · 成本按内置官方价表 + 自定义价估算</template>
      </p>
      <div class="range-btns">
        <button
          v-for="[v, label] in USAGE_RANGES"
          :key="v"
          class="btn"
          :class="{ 'btn-accent': range === v }"
          @click="switchRange(v)"
        >
          {{ label }}
        </button>
        <button class="btn" :disabled="loading" @click="load">刷新</button>
      </div>
    </div>

    <!-- Q17 结论注记：按动作分类的数据现状，不硬造 -->
    <p class="action-note">
      按动作分类（对话 / 巩固 / 主动）需后端补 tag：现有用量数据不带动作来源（会话存档用量行无
      tag；巩固与日记的模型调用不经会话存档）。本页先展示现有维度。
    </p>

    <!-- 五张卡（估算成本为主指标，accent 描边） -->
    <div class="cards">
      <section class="card ucard accent">
        <p class="uc-label">估算成本</p>
        <p class="uc-value key-num">{{ fmtYuan(Number(totals.cost) || 0) }}</p>
        <p class="uc-sub">{{ stats?.rangeLabel || '' }}</p>
        <div class="spark">
          <i v-for="(b, i) in sparkHeights('cost')" :key="i" :class="{ hi: b.hi }" :title="b.tip"><b :style="{ height: `${b.h}%` }"></b></i>
        </div>
      </section>
      <section class="card ucard">
        <p class="uc-label">调用次数</p>
        <p class="uc-value">{{ fmtTok(Number(totals.runs) || 0) }}</p>
        <p class="uc-sub">{{ runsSub }}</p>
        <div class="spark">
          <i v-for="(b, i) in sparkHeights('runs')" :key="i" :class="{ hi: b.hi }" :title="b.tip"><b :style="{ height: `${b.h}%` }"></b></i>
        </div>
      </section>
      <section class="card ucard">
        <p class="uc-label">搜索次数 <span class="uc-tag">不计入成本</span></p>
        <p class="uc-value">{{ fmtTok(searchCount) }}</p>
        <p class="uc-sub">{{ searchSub }}</p>
        <div class="spark">
          <i v-for="(b, i) in sparkHeights('search')" :key="i" :class="{ hi: b.hi }" :title="b.tip"><b :style="{ height: `${b.h}%` }"></b></i>
        </div>
      </section>
      <section class="card ucard">
        <p class="uc-label">输入 token</p>
        <p class="uc-value">{{ fmtTok(Number(totals.promptTokens) || 0) }}</p>
        <p class="uc-sub">输出 {{ fmtTok(Number(totals.completionTokens) || 0) }}</p>
        <div class="spark">
          <i v-for="(b, i) in sparkHeights('promptTokens')" :key="i" :class="{ hi: b.hi }" :title="b.tip"><b :style="{ height: `${b.h}%` }"></b></i>
        </div>
      </section>
      <section class="card ucard">
        <p class="uc-label">缓存命中率</p>
        <p class="uc-value">{{ cacheRate }}</p>
        <p class="uc-sub">命中 {{ fmtTok(Number(totals.cachedTokens) || 0) }}</p>
        <div class="spark">
          <i v-for="(b, i) in sparkHeights('cacheHitRate')" :key="i" :class="{ hi: b.hi }" :title="b.tip"><b :style="{ height: `${b.h}%` }"></b></i>
        </div>
      </section>
    </div>

    <!-- 按天（仅自然日区间显示；旧 UI mode==='days' 才显示） -->
    <section v-if="daysVisible" class="card block">
      <h2 class="section-title">按天</h2>
      <table class="utable">
        <thead>
          <tr><th>日期</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">缓存命中</th><th class="r">命中率</th><th class="r">成本</th></tr>
        </thead>
        <tbody>
          <tr v-if="!(stats?.days || []).length"><td colspan="7" class="muted">无</td></tr>
          <tr v-for="d in stats?.days || []" :key="d.day" class="clickable" @click="openBreakdown('day', d.day)">
            <td class="mono">{{ d.day }}</td>
            <td class="r">{{ d.runs }}</td>
            <td class="r">{{ fmtTok(d.promptTokens) }}</td>
            <td class="r">{{ fmtTok(d.completionTokens) }}</td>
            <td class="r">{{ fmtTok(d.cachedTokens) }}</td>
            <td class="r">{{ ((Number(d.cacheHitRate) || 0) * 100).toFixed(0) }}%</td>
            <td class="r">{{ fmtYuan(d.cost) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 按会话 -->
    <section class="card block">
      <h2 class="section-title">按会话</h2>
      <table class="utable">
        <thead>
          <tr><th>会话</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr>
        </thead>
        <tbody>
          <tr v-if="!(stats?.chats || []).length"><td colspan="6" class="muted">无</td></tr>
          <tr v-for="c in stats?.chats || []" :key="c.key" class="clickable" @click="openBreakdown('chat', c.key)">
            <td>{{ chatTitleOf(c.key) }}</td>
            <td class="r">{{ c.runs }}</td>
            <td class="r">{{ fmtTok(c.promptTokens) }}</td>
            <td class="r">{{ fmtTok(c.completionTokens) }}</td>
            <td class="r">{{ ((Number(c.cacheHitRate) || 0) * 100).toFixed(0) }}%</td>
            <td class="r">{{ fmtYuan(c.cost) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 按模型（>20 行折叠，旧 COLLAPSE_AT=20） -->
    <section class="card block">
      <h2 class="section-title">
        按模型
        <button v-if="modelsHidden > 0 || modelsExpanded" class="btn btn-sm" @click="modelsExpanded = !modelsExpanded">
          {{ modelsExpanded ? '收起' : `展开全部（还有 ${modelsHidden} 行）` }}
        </button>
      </h2>
      <table class="utable">
        <thead>
          <tr><th>模型（渠道：模型 id）</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr>
        </thead>
        <tbody>
          <tr v-if="!modelsShown.length"><td colspan="6" class="muted">无</td></tr>
          <tr v-for="m in modelsShown" :key="m.key" class="clickable" @click="openBreakdown('model', m.key)">
            <td>{{ displayName(m) }}</td>
            <td class="r">{{ m.runs }}</td>
            <td class="r">{{ fmtTok(m.promptTokens) }}</td>
            <td class="r">{{ fmtTok(m.completionTokens) }}</td>
            <td class="r">{{ ((Number(m.cacheHitRate) || 0) * 100).toFixed(0) }}%</td>
            <td class="r">{{ fmtYuan(m.cost) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 明细弹窗（dim × by 二级维度 + 峰谷拆分，旧 openUsageBreakdown） -->
    <div v-if="bd" class="bd-mask" @click.self="closeBreakdown">
      <div class="card bd-panel">
        <div class="bd-head">
          <h3>明细：{{ DIM_LABEL[bd.dim] }} {{ bd.dim === 'chat' ? chatTitleOf(bd.key) : bd.key }}</h3>
          <div class="bd-tabs">
            <button
              v-for="[v, label] in bdTabs"
              :key="v"
              class="btn btn-sm"
              :class="{ 'btn-accent': bd.by === v }"
              @click="switchBy(v)"
            >
              {{ label }}
            </button>
            <button class="btn btn-sm" @click="closeBreakdown">关闭</button>
          </div>
        </div>

        <div v-if="peak" class="peak">
          <span class="badge">峰谷拆分</span>
          <span class="peak-row">峰时 {{ fmtYuan(peak.peakCost) }}</span>
          <span class="bar peak-bar"><span class="bar-fill" :style="{ width: `${(peak.ratio * 100).toFixed(1)}%` }"></span></span>
          <span class="peak-pct">{{ (peak.ratio * 100).toFixed(0) }}% token</span>
          <span class="peak-row">闲时 {{ fmtYuan(peak.offPeakCost) }}</span>
          <span class="peak-pct">{{ ((1 - peak.ratio) * 100).toFixed(0) }}% token</span>
        </div>

        <table class="utable">
          <thead>
            <tr><th>{{ DIM_LABEL[bd.by] || '项目' }}</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr>
          </thead>
          <tbody>
            <tr v-if="bdLoading"><td colspan="6" class="muted">加载中…</td></tr>
            <tr v-else-if="bdError"><td colspan="6" class="muted">加载失败：{{ bdError }}</td></tr>
            <tr v-else-if="!(bdData?.rows || []).length"><td colspan="6" class="muted">无数据</td></tr>
            <template v-else>
              <tr v-for="(x, i) in bdData?.rows || []" :key="i">
                <td>{{ rowName(bd.by, x.key, x) }}</td>
                <td class="r">{{ x.runs }}</td>
                <td class="r">{{ fmtTok(x.promptTokens) }}</td>
                <td class="r">{{ fmtTok(x.completionTokens) }}</td>
                <td class="r">{{ ((Number(x.cacheHitRate) || 0) * 100).toFixed(0) }}%</td>
                <td class="r">{{ fmtYuan(x.cost) }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.usage-page {
  /* S2 设计稿五：工具型页主列 1200 */
  max-width: 1200px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.head-note {
  margin: 0;
  color: var(--ink-2);
  font-size: 12px;
}

.head-note.err {
  color: var(--accent);
}

.range-btns {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.action-note {
  margin: 0;
  padding: 6px 10px;
  border: 1px dashed var(--line-strong);
  border-radius: 4px;
  color: var(--ink-2);
  font-size: 12px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-1);
}

.ucard {
  padding: 10px 12px;
}

.ucard.accent {
  border-color: var(--accent);
}

.uc-label {
  margin: 0;
  color: var(--ink-2);
  font-size: 11px;
  letter-spacing: 0.08em;
}

.uc-tag {
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 10px;
}

.uc-value {
  margin: 4px 0 0;
  font-family: var(--font-mono);
  font-size: 20px;
  line-height: 1.3;
}

.uc-sub {
  margin: 2px 0 0;
  color: var(--ink-2);
  font-size: 11px;
}

.spark {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 28px;
  margin-top: 6px;
}

.spark i {
  flex: 1;
  min-width: 2px;
  height: 100%;
  display: flex;
  align-items: flex-end;
}

.spark b {
  display: block;
  width: 100%;
  min-height: 2px;
  background: var(--line-strong);
}

.spark i.hi b {
  background: var(--accent);
}

.block {
  padding: var(--space-2);
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.btn-sm {
  padding: 1px 8px;
  font-size: 11px;
}

.utable {
  width: 100%;
  margin-top: var(--space-2);
  border-collapse: collapse;
  font-size: 12px;
}

.utable th {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line-strong);
  color: var(--ink-2);
  font-weight: normal;
  font-size: 11px;
  letter-spacing: 0.15em;
}

.utable td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}

.utable .r {
  text-align: right;
  font-family: var(--font-mono);
  font-size: 11px;
}

.clickable {
  cursor: pointer;
}

.clickable:hover td {
  color: var(--accent);
}

.muted {
  color: var(--ink-2);
}

.mono {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-2);
  white-space: nowrap;
}

.bd-mask {
  position: fixed;
  inset: 0;
  background: rgba(47, 46, 43, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
}

.bd-panel {
  width: min(760px, 92vw);
  max-height: 80vh;
  overflow: auto;
  padding: var(--space-2);
}

.bd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.bd-head h3 {
  font-size: 15px;
}

.bd-tabs {
  display: flex;
  gap: 6px;
}

.peak {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: var(--space-2) 0 0;
  font-size: 12px;
  color: var(--ink-2);
  flex-wrap: wrap;
}

.peak-bar {
  flex: 0 1 160px;
}

.peak-pct {
  font-family: var(--font-mono);
  font-size: 11px;
}

@media (max-width: 1200px) {
  .cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 820px) {
  .cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 520px) {
  .cards {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
