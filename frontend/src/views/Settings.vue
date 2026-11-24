<script setup lang="ts">
// ============================================================
// M3.5 设置全量化（night-plan §6.5 分区 1-9 全量）：模型 API / 搜索服务 /
//   记忆整理 / 人设（上半）+ 聊天白名单 / 聊天设置 / 桌面端 /
//   工具与技能（下半）—— 端点与字段口径 100% 照抄旧 UI
//   （_archive-20261108/ui/app/06-settings-render.js 1607 行 + 07-settings-events.js
//   + 08-modals.js saveConfig L1214-1494），不要发明。
//   保存语义 100% 复用旧 UI：
//     · GET  /api/config 读（sanitizeConfig 脱敏：apiKey 删除 → hasApiKey 布尔；
//       脱敏视图展开回传安全——缺失键 deepMerge 保留服务端现值，hasXxx 由
//       后端 stripDerivedFlags 剔除）
//     · POST /api/config 深合并 patch（旧 saveConfig 同款；后端无 PUT，
//       旧 UI 全部保存即 POST——只传本页编辑的键，不回传整份配置）
//     · 提供商 Key：POST /api/providers/set-key（旧 08-modals.js L461）；
//       直连模式才把 api.apiKey 放进 config patch
//     · 技能开关走 POST /api/skills/:id {enabled}（生命周期在后端）
//   交互差异（M3 既有模式，记 drift）：新页按分区显式保存按钮，非旧 UI 的
//   600ms 防抖自动保存；载荷形状与端点不变。
// ============================================================
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  addPersonaTemplate,
  addProvider,
  addProviderModels,
  deletePersonaTemplate,
  deleteProvider,
  deleteProviderModel,
  deleteSearchProvider,
  fetchConfig,
  fetchDirectApiKey,
  fetchModelPrices,
  fetchPersonaTemplates,
  fetchProviderKey,
  fetchProviderModels,
  fetchProviders,
  fetchSearchKey,
  fetchSearchProviders,
  fetchSkills,
  fetchTools,
  fetchVisionResults,
  fetchVoiceStatus,
  ensureVoiceEngines,
  reloadSkillsList,
  renameProvider,
  saveConfigPatch,
  saveSearchProvider,
  setProviderKey,
  setSkillEnabled,
  testSearchProvider,
} from '../lib/api'
import type {
  AppConfig,
  ModelPriceRow,
  PersonaTemplate,
  ProviderEntry,
  SearchProviderEntry,
  SkillsPayload,
  ToolEntry,
  VoiceStatusSnapshot,
} from '../lib/types'
import { describeEnsureResult } from '../lib/voiceEngines'
import { setTheme, theme, type ThemeName } from '../design/theme'

const cfg = ref<AppConfig | null>(null)
const skillsPayload = ref<SkillsPayload | null>(null)
const providers = ref<ProviderEntry[]>([])
const templates = ref<PersonaTemplate[]>([])
const officialPrices = ref<ModelPriceRow[]>([])
const visionResults = ref<Record<string, { verdict?: string; source?: string; note?: string }>>({})
const loading = ref(false)
const loadError = ref('')
const notes = ref<Record<string, string>>({})
const saving = ref<Record<string, boolean>>({})

// ---- 分区 1 · 模型 API 表单态 ----
const selProviderId = ref('')
const selModel = ref('')
const baseUrl = ref('')
const apiKeyInput = ref('')
const visionOn = ref(true)
const videoOn = ref(false)
const videoMode = ref('auto')
const visionModel = ref('')
const videoModel = ref('')
const temperature = ref(0.8)
const maxRounds = ref(12)
const maxTokens = ref(2048)
const thinkingSel = ref('')
const fallbackRows = ref<Array<{ model: string; provider: string }>>([{ model: '', provider: '' }])
const useOfficialPrice = ref(true)
const priceIn = ref(0)
const priceOut = ref(0)
const priceCached = ref(0)
const priceEdits = ref<Record<string, { in?: number; out?: number; cached?: number }>>({})

// ---- 分区 2 · 搜索服务表单态 ----
const wsEnabled = ref(true)
const wsProvider = ref('bing')
const wsSearchUrl = ref('https://cn.bing.com/search')
const dsKeyInput = ref('')
const dsModel = ref('deepseek-v4-flash')
const zhipuKeyInput = ref('')
const zhipuEngine = ref('search_std')
const bochaKeyInput = ref('')
const baiduKeyInput = ref('')
const metasoKeyInput = ref('')
const customKeyInput = ref('')
const newSp = reactive({ name: '', type: 'openai', baseUrl: '', apiKey: '', model: '' })
const searchProviders = ref<SearchProviderEntry[]>([])
const searchTestHint = ref('')

// ---- 分区 3 · 记忆整理表单态 ----
const memConsolidate = ref(true)
const memUseChat = ref(true)
const memProvider = ref('')
const memModel = ref('')
const memInterval = ref(21600000)
const writerMode = ref('model')
// W4 · embedding 注入全键（memory.embedding；缺省值与 DEFAULT_CONFIG 同值）
const embEnabled = ref(false)
const embProvider = ref('')
const embModel = ref('')
const embQueryInstruction = ref('')
const embGateMode = ref<'always' | 'strict'>('always')
const embFuseLexical = ref(1)
const embFuseVector = ref(1)
const embFuseRow = ref(1)
const embFuseGist = ref(1)
const embFuseFact = ref(1)
const embVectorFloor = ref(0.45)
const embRowFloor = ref(0.45)
const embLexicalFloor = ref(2)
// P14/P16：日程注入模式 + 跨轮思考；lifeEnabled = 生活模块本体开关（modules.life.enabled）
const lifePromptMode = ref('off')
const lifeEnabled = ref(true)
const transitionEnabled = ref(true)
const transitionTtlMin = ref(90)
const transitionMaxChars = ref(500)

// ---- 分区 4 · 人设表单态 ----
const botName = ref('')
const ownerLabel = ref('对方')
const selfNickname = ref('')
const roleText = ref('')
const customRules = ref('')
const sysPromptOverride = ref('')
const personaPickId = ref('')
/** 人设热改（2026-11-21）：当前编辑文本的来源模板 id（custom_<i> 时保存即回写该模板）；
 *  选模板时显式记录，编辑文本不丢链接；load/hydrate 时按文本匹配兜底。 */
const personaSourceId = ref('')
/** 系统提示词只读查看器（/api/prompt-preview 实际渲染结果，仅查看不保存） */
const sysPromptPreview = ref('')
const sysPromptLoading = ref(false)
async function loadSystemPrompt(): Promise<void> {
  sysPromptLoading.value = true
  try {
    const res = await fetch('/api/prompt-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { systemPrompt?: string }
    sysPromptPreview.value = String(data.systemPrompt ?? '')
  } catch (err) {
    sysPromptPreview.value = ''
    setNote('all', `系统提示词预览失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    sysPromptLoading.value = false
  }
}
const personaAddOpen = ref(false)
const personaAddName = ref('')
const personaAddText = ref('')
const personaAddRules = ref('')

// ---- 分区 5 · 聊天白名单表单态（旧 renderAllowSection L686；清债夜1 起
//      纯文本编辑——「选择好友」选择器随其好友列表端点退役下线）----

// ---- 分区 6 · 聊天设置表单态（旧 renderChatSection L766 sc-* 字段 + sticker 卡）----
const wakeDelayMs = ref(2000)
const drainDelayMs = ref(1200)
const maxConcurrentRuns = ref(2)
const sessionRetryAttempts = ref(2)
const sendMinGapMs = ref(1000)
const sendMaxGapMs = ref(3000)
const sendMaxPerMinute = ref(80)
const sendMaxPerHour = ref(500)
const historyCount = ref(80)
const promptAnchorEnabled = ref(true)
const promptAnchorMaxExtra = ref(5)
const stickerEnabled = ref(true)
const stickerEncourage = ref(1)
const stickerPromptMax = ref(10)

// ---- 分区 7 · 桌面端表单态（旧 renderDesktopSection L862；server.port 只读展示）----
const serverAutoStart = ref(false)
const serverCloseToTray = ref(true)
const serverPort = ref(0)
const uiShowVision = ref(true)
const uiRefreshMs = ref(15000)

// ---- 自定义头像（2026-11-21）：data/avatar.<ext>，POST/DELETE /api/person/avatar ----
const avatarTs = ref(0)
const avatarUploading = ref(false)
const avatarInput = ref<HTMLInputElement | null>(null)
const avatarSrc = computed(() => (avatarTs.value ? `/api/avatar?v=${avatarTs.value}` : '/icons/avatar-128.png'))
async function loadAvatarTs(): Promise<void> {
  try {
    const res = await fetch('/api/person/state', { headers: { Accept: 'application/json' } })
    if (res.ok) avatarTs.value = Number((await res.json() as { avatarTs?: number }).avatarTs ?? 0)
  } catch { /* 保持现状 */ }
}
async function uploadAvatar(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''   // 允许连选同一文件重传
  if (!file) return
  avatarUploading.value = true
  notes.value.avatar = ''
  try {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/person/avatar', { method: 'POST', body: fd })
    const data = await res.json() as { ok?: boolean; ts?: number; error?: string }
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    avatarTs.value = Number(data.ts ?? 0)
    notes.value.avatar = '头像已更新 ✓'
  } catch (err) {
    notes.value.avatar = `失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    avatarUploading.value = false
  }
}
async function resetAvatar(): Promise<void> {
  avatarUploading.value = true
  notes.value.avatar = ''
  try {
    const res = await fetch('/api/person/avatar', { method: 'DELETE' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    avatarTs.value = 0
    notes.value.avatar = '已恢复默认头像 ✓'
  } catch (err) {
    notes.value.avatar = `失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    avatarUploading.value = false
  }
}

// ---- 分区 8 · 语音电话表单态（T3 V2 前端，night-plan §2-T3 / spec §2.6：
//      四开关=voice.enabled / voice.call.enabled / voice.engine.manage /
//      voice.engine.gpuAllow；W1 起另配 TTS/ASR 快捷开关（voice.tts.enabled /
//      voice.asr.enabled，顶部即时保存+引擎联动）；W3 大扩充（night-plan-polish
//      §2-W3.1）：asr/tts 全键（含 W2 dialect/apiKey/model 等）+ call 全参数 +
//      engine.{manage,gpuAllow} 全部暴露，每项一句说明+数值范围提示，
//      apiKey 密码框（GET /api/config 脱敏→hasApiKey 布尔，空值不回传=服务端现值
//      不被覆盖；「清除」按钮显式发 apiKey:''）。语速类参数不暴露（speed_factor
//      禁调是所有者拍板，TTS_FROZEN 一字不动）----
const voiceEnabled = ref(false)
const voiceCallEnabled = ref(false)
const voiceEngineManage = ref('auto')
const voiceGpuAllow = ref(true)
/** W1 快捷开关（缺省 true=兼容现役；false=零调用） */
const voiceTtsEnabled = ref(true)
const voiceAsrEnabled = ref(true)
// W3 · ASR 组（engine 可填引擎名或方言名；dialect '' =跟随 engine 名派生）
const asrEngine = ref('off')
const asrDialect = ref('')
const asrBaseUrl = ref('')
const asrApiKey = ref('')
const asrHasApiKey = ref(false)
const asrModel = ref('')
const asrLanguage = ref('zh')
const asrTimeoutMs = ref(15000)
// W3 · TTS 组
const ttsEngine = ref('off')
const ttsDialect = ref('')
const ttsBaseUrl = ref('')
const ttsApiKey = ref('')
const ttsHasApiKey = ref(false)
const ttsModel = ref('')
const ttsVoiceId = ref('stella')
const ttsRefVoice = ref('')
const ttsFilterMarkdown = ref(true)
const ttsFormat = ref('ogg')
const ttsSampleRate = ref(24000)
const ttsBitrateKbps = ref(24)
const ttsTimeoutMs = ref(5000)
// W3 · 通话参数组（call.* 全参数）
const callSilenceMs = ref(300)
const callMinUtteranceMs = ref(300)
const callMaxUtteranceMs = ref(60000)
const callFirstSentenceMaxChars = ref(15)
const callMaxSentences = ref(4)
const callPromptBudget = ref(3000)
const callHistoryTurns = ref(8)
const callRecallMinSeconds = ref(120)
const callRecall = ref(true)
const callKeepAudio = ref(false)
const callDndStart = ref('23:30')
const callDndEnd = ref('08:00')
// W3 · 信息区状态卡（GET /api/voice/status 只读快照；「立即探测」= probe=1）
const voiceStatus = ref<VoiceStatusSnapshot | null>(null)

// ---- 分区 9 · 工具与技能表单态（旧 renderToolsSection L1449 + /api/skills 开关）----
const toolList = ref<ToolEntry[]>([])
const toolsEnabled = ref(true)
const toolsCatEnabled = ref<Record<string, boolean>>({})
const toolsOverride = ref<Record<string, boolean>>({})
const expandedCats = ref<Record<string, boolean>>({ messaging: true })
/** 分类清单与 tool-registry 的 CATEGORY_META 同源（旧 renderToolsSection 注释：8 类） */
const TOOL_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: 'messaging', label: '💬 消息发送' },
  { id: 'sticker', label: '😀 表情管理' },
  { id: 'query', label: '🔍 消息查询' },
  { id: 'memory', label: '🧠 记忆系统' },
  { id: 'web', label: '🌐 联网搜索' },
  { id: 'knowledge', label: '📚 知识库' },
  { id: 'media', label: '🎞️ 媒体理解' },
  { id: 'system', label: '⚙️ 系统反馈' },
]
/** 所属技能失活的工具整组不显示（旧 renderToolsSection skillActive 过滤同款） */
const inactiveSkillIds = computed(() => {
  const set = new Set<string>()
  for (const s of skillsPayload.value?.skills || []) {
    const id = String(s.id || '')
    if (id && s.loaded !== false && s.active !== true) set.add(id)
  }
  return set
})
const toolsByCategory = computed(() => {
  const by: Record<string, ToolEntry[]> = {}
  for (const t of toolList.value) {
    const cat = String(t.category || 'system')
    // 技能失活 → 该技能注册的工具整组隐藏（与提示词口径一致，旧 UI 同款过滤）
    if (t.skillId && inactiveSkillIds.value.has(t.skillId)) continue
    if (!by[cat]) by[cat] = []
    by[cat].push(t)
  }
  return by
})
const hasInactiveTools = computed(() =>
  toolList.value.some((t) => t.skillId && inactiveSkillIds.value.has(t.skillId)),
)
/** 单工具开关当前显示态（overrides 显式值 > 工具默认值 > true） */
const toolChecked = (t: ToolEntry): boolean => {
  const v = toolsOverride.value[String(t.id || '')]
  if (typeof v === 'boolean') return v
  return t.defaultEnabled !== false
}
/** 单工具开关的依赖禁用（requiresVision/requiresSearch 未满足 → 禁用，旧 UI 同款） */
const toolDepDisabled = (t: ToolEntry): boolean => {
  const c = cfg.value
  if (t.requiresVision && c?.api?.vision === false) return true
  if (t.requiresSearch && c?.webSearch?.enabled === false) return true
  return false
}

/** 显示已存 Key（旧 mc-apikey-toggle 口径：provider 模式走 /api/providers/key，直连走 /api/api-key；仅本机放行） */
async function revealApiKey(): Promise<void> {
  await run('api', async () => {
    const pid = selProviderId.value.trim()
    apiKeyInput.value = pid ? await fetchProviderKey(pid) : await fetchDirectApiKey()
    setNote('api', '已读取明文（仅本机可见）')
  })
}

/** 清除已存 Key（旧 mc-apikey-clear L456-470 口径：provider → set-key ''；直连 → api.apiKey '' patch） */
async function clearApiKey(): Promise<void> {
  await run('api', async () => {
    const pid = selProviderId.value.trim()
    if (pid) await setProviderKey(pid, '')
    else await saveConfigPatch({ api: { apiKey: '' } })
    const c = await fetchConfig()
    cfg.value = c
    apiKeyInput.value = ''
    setNote('api', 'API Key 已清除 ✓')
  })
}

// ---- 模型管理（目录维护）态 ----
const manageOpen = ref(false)
const managePid = ref('')
const manageName = ref('')
const manageKeyInput = ref('')
const manageShowKey = ref(false)
const manualModelId = ref('')
const manualModelName = ref('')
const fetchedModels = ref<string[]>([])
const fetchedPicked = ref<Record<string, boolean>>({})
const addProvOpen = ref(false)
const addProvBaseUrl = ref('')
const addProvApiKey = ref('')
const addProvRows = ref<Array<{ id: string; name: string }>>([{ id: '', name: '' }])

// 提供商显示名：切到哪个提供商，就把它的名字回填到输入框
watch(
  [managePid, providers],
  () => {
    const p = providers.value.find((x) => x.id === managePid.value)
    manageName.value = String(p?.displayName || '')
  },
  { immediate: true },
)

// ---- M3 既有：白名单输入（分区 5 增强版见下方 saveAllow）----

const providerId = computed(() => String(cfg.value?.api?.provider ?? '').trim())
const hasApiKey = computed(() => cfg.value?.api?.hasApiKey === true || cfg.value?.api?.hasKey === true)

// （parseList 已随 2026-11-21 聊天白名单分区删除一并移除。）

/** matchPriceTable（src/model-prices.js L617 前端同款：精确 → 去前缀 → 最长前缀） */
function matchPriceTable(modelId: string, table: ModelPriceRow[]): (ModelPriceRow & { matched?: string }) | null {
  const raw = String(modelId || '').trim()
  if (!raw) return null
  const id = raw.toLowerCase()
  const list = table || []
  const exact = list.find((x) => String(x.id).toLowerCase() === id)
  if (exact) return { ...exact, matched: exact.id }
  if (id.includes('/')) {
    const bare = id.split('/').pop() || ''
    const hit = list.find((x) => String(x.id).toLowerCase() === bare)
    if (hit) return { ...hit, matched: hit.id }
  }
  let best: ModelPriceRow | null = null
  for (const x of list) {
    const xid = String(x.id).toLowerCase()
    if (id.startsWith(xid) && (!best || xid.length > String(best.id).length)) best = x
  }
  return best ? { ...best, matched: best.id } : null
}

/** 当前模型单价卡片（旧 05-memory-settings.js refreshModelPriceCard 同一套规则） */
const priceCard = computed(() => {
  const api = cfg.value?.api || {}
  const model = String(selModel.value || '').trim()
  if (!model) return { locked: true, in: 0, out: 0, cached: 0, note: '先在上方选择一个模型，才能查看/设定它的单价。' }
  const customEntry = (api.modelPrices || {})[model]
  const hasCustom = !!(customEntry && (Number(customEntry.in) || Number(customEntry.out)))
  if (hasCustom) {
    return {
      locked: true,
      in: Number(customEntry.in) || 0,
      out: Number(customEntry.out) || 0,
      cached: customEntry.cached == null ? Number(customEntry.in) || 0 : Number(customEntry.cached) || 0,
      note: '正在使用你为该模型设定的单价（优先于官方价格表）。要改请在下方批量编辑里修改或清除。',
    }
  }
  if (useOfficialPrice.value) {
    const official = matchPriceTable(model, officialPrices.value)
    if (official) {
      return {
        locked: true,
        in: official.in ?? 0,
        out: official.out ?? 0,
        cached: official.cached == null ? official.in ?? 0 : official.cached ?? 0,
        note: `内置官方价格表已匹配到「${official.matched || official.id}」。开关开启时只读 —— 要自定义请关闭上方开关。`,
      }
    }
    return { locked: true, in: 0, out: 0, cached: 0, note: '官方价格表未收录该模型；关闭开关后可自填单价。' }
  }
  return {
    locked: false,
    in: Number(api.priceInputPerM) || 0,
    out: Number(api.priceOutputPerM) || 0,
    cached: Number(api.priceCachedPerM) || Number(api.priceInputPerM) || 0,
    note: '已关闭官方价格表，可在此填写该模型的单价（也可在批量编辑里为多个模型分别设定）。',
  }
})

/** 当前模型视觉判定（旧 visionBadge 口径的提示行版） */
const visionHint = computed(() => {
  const r = visionResults.value[`${providerId.value || ''}|||${String(selModel.value || '').trim()}`]
  if (!r) return ''
  if (r.verdict === 'vision') return '✅ 当前模型支持图片输入'
  if (r.verdict === 'no-vision') return '🚫 当前模型不支持图片输入'
  return ''
})

const curProvider = computed(() => providers.value.find((p) => p.id === selProviderId.value))
const curProviderModels = computed(() => curProvider.value?.models || [])

/** 模型切换下拉：当前值不在目录里也保留一行，避免切过去后显示空白。 */
const modelSwitchOptions = computed(() => {
  const list = [...curProviderModels.value]
  const cur = String(selModel.value || '').trim()
  if (cur && !list.includes(cur)) list.unshift(cur)
  return list
})

/** 备选模型行下拉的选项：按提供商分组（provider|||model 编码，存回 {model, provider}） */
const fallbackOptions = computed(() => {
  const opts: Array<{ value: string; label: string; group: string }> = []
  for (const p of providers.value) {
    for (const m of p.models || []) {
      opts.push({ value: `${p.id}|||${m}`, label: (p.modelNames || {})[m] || m, group: p.displayName || p.id || '' })
    }
  }
  return opts
})

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const [c, sk, prov, tpl, prices, vision, sp, tools] = await Promise.all([
      fetchConfig(),
      fetchSkills(),
      fetchProviders().catch(() => [] as ProviderEntry[]),
      fetchPersonaTemplates().catch(() => [] as PersonaTemplate[]),
      fetchModelPrices().catch(() => ({ prices: [] as ModelPriceRow[] })),
      fetchVisionResults().catch(() => ({})),
      fetchSearchProviders().catch(() => [] as SearchProviderEntry[]),
      fetchTools().catch(() => [] as ToolEntry[]),
    ])
    cfg.value = c
    skillsPayload.value = sk
    providers.value = prov
    templates.value = tpl
    officialPrices.value = prices.prices || []
    visionResults.value = vision
    searchProviders.value = sp
    toolList.value = tools
    hydrateFromConfig()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

/** GET 回填表单（保存成功后也走这里，口径 = 渲染值来自 state.config） */
function hydrateFromConfig(): void {
  const c = cfg.value
  if (!c) return
  const api = c.api || {}
  selProviderId.value = String(api.provider ?? '')
  selModel.value = String(api.model ?? '')
  baseUrl.value = String(api.baseUrl ?? '')
  apiKeyInput.value = ''
  visionOn.value = api.vision !== false
  videoOn.value = api.video === true
  videoMode.value = String(api.videoMode || 'auto')
  visionModel.value = String(api.visionModel ?? '')
  videoModel.value = String(api.videoModel ?? '')
  temperature.value = Number(api.temperature ?? 0.8)
  maxRounds.value = Number(api.maxRounds ?? 12)
  maxTokens.value = Number(api.maxTokens ?? 2048)
  const eff = String(api.thinkingEffort || '')
  const mode = String(api.thinkingMode || 'auto')
  thinkingSel.value = mode === 'off' ? 'off' : eff || (mode === 'on' ? 'on-noeffort' : '')
  const fb = Array.isArray(api.fallbackModels) ? api.fallbackModels : []
  fallbackRows.value = fb.map((f) => ({ model: String(f.model || ''), provider: String(f.provider || '') }))
  if (fallbackRows.value.length === 0) fallbackRows.value = [{ model: '', provider: '' }]
  useOfficialPrice.value = api.useOfficialPrice !== false
  priceIn.value = priceCard.value.in
  priceOut.value = priceCard.value.out
  priceCached.value = priceCard.value.cached
  priceEdits.value = {}
  for (const [k, v] of Object.entries(api.modelPrices || {})) priceEdits.value[k] = { in: v.in, out: v.out, cached: v.cached }
  ensurePriceEdits()

  const ws = c.webSearch || {}
  wsEnabled.value = ws.enabled !== false
  wsProvider.value = String(ws.provider || 'bing')
  wsSearchUrl.value = String(ws.searchUrl || 'https://cn.bing.com/search')
  dsKeyInput.value = ''
  dsModel.value = String(ws.deepseek?.model || 'deepseek-v4-flash')
  zhipuKeyInput.value = ''
  zhipuEngine.value = String(ws.zhipu?.engine || 'search_std')
  bochaKeyInput.value = ''
  baiduKeyInput.value = ''
  metasoKeyInput.value = ''
  customKeyInput.value = ''
  newSp.name = ''
  newSp.type = 'openai'
  newSp.baseUrl = ''
  newSp.apiKey = ''
  newSp.model = ''
  searchTestHint.value = ''

  const mem = c.memory || {}
  memConsolidate.value = mem.consolidateEnabled !== false
  memUseChat.value = mem.useChatModel !== false
  memProvider.value = String(mem.provider ?? '')
  memModel.value = String(mem.model ?? '')
  memInterval.value = Number(mem.consolidateMinIntervalMs ?? 21600000)
  writerMode.value = String(mem.writer?.mode ?? 'model')
  // W4 · embedding 全键回填（gateMode 非法值按后端同款 fail-closed 口径落 always）
  const emb = mem.embedding || {}
  embEnabled.value = emb.enabled === true
  embProvider.value = String(emb.provider ?? '')
  embModel.value = String(emb.model ?? '')
  embQueryInstruction.value = String(emb.queryInstruction ?? '')
  embGateMode.value = String(emb.gateMode ?? 'always') === 'strict' ? 'strict' : 'always'
  const fw = emb.fuseWeights || {}
  embFuseLexical.value = Number.isFinite(Number(fw.lexical)) ? Number(fw.lexical) : 1
  embFuseVector.value = Number.isFinite(Number(fw.vector)) ? Number(fw.vector) : 1
  embFuseRow.value = Number.isFinite(Number(fw.row)) ? Number(fw.row) : 1
  embFuseGist.value = Number.isFinite(Number(fw.gist)) ? Number(fw.gist) : 1
  embFuseFact.value = Number.isFinite(Number(fw.fact)) ? Number(fw.fact) : 1
  embVectorFloor.value = Number.isFinite(Number(emb.vectorFloor)) ? Number(emb.vectorFloor) : 0.45
  embRowFloor.value = Number.isFinite(Number(emb.rowFloor)) ? Number(emb.rowFloor) : 0.45
  embLexicalFloor.value = Number.isFinite(Number(emb.lexicalFloor)) ? Number(emb.lexicalFloor) : 2
  lifePromptMode.value = String(c.life?.promptMode ?? 'off') === 'prose' ? 'prose' : 'off'
  // 缺省 true（plugin-loader 判定口径：无键 = manifest 缺省启用；false 才是显式关闭）
  lifeEnabled.value = c.modules?.life?.enabled !== false
  const trans = c.transition || {}
  transitionEnabled.value = trans.enabled !== false
  transitionTtlMin.value = Number.isFinite(Number(trans.ttlMin)) ? Number(trans.ttlMin) : 90
  transitionMaxChars.value = Number.isFinite(Number(trans.maxChars)) ? Number(trans.maxChars) : 500

  const per = c.persona || {}
  botName.value = String(per.botName ?? '')
  ownerLabel.value = String(per.ownerLabel ?? '对方')
  selfNickname.value = String(per.selfNickname ?? '')
  roleText.value = String(per.roleText ?? '')
  customRules.value = String(per.customRules ?? '')
  sysPromptOverride.value = String(per.systemPromptOverride ?? '')
  personaPickId.value = templates.value.find((t) => t.text === roleText.value)?.id || ''
  personaAddOpen.value = false

  manageOpen.value = false
  managePid.value = selProviderId.value || providers.value[0]?.id || ''
  manageKeyInput.value = ''
  manageShowKey.value = false
  manualModelId.value = ''
  manualModelName.value = ''
  fetchedModels.value = []
  fetchedPicked.value = {}
  addProvOpen.value = false


  wakeDelayMs.value = Number(c.wakeDelayMs ?? 2000)
  drainDelayMs.value = Number(c.drainDelayMs ?? 1200)
  maxConcurrentRuns.value = Number(c.maxConcurrentRuns ?? 2)
  sessionRetryAttempts.value = Number(c.sessionRetryAttempts ?? 2)
  sendMinGapMs.value = Number(c.send?.minGapMs ?? 1000)
  sendMaxGapMs.value = Number(c.send?.maxGapMs ?? 3000)
  sendMaxPerMinute.value = Number(c.send?.maxPerMinute ?? 80)
  sendMaxPerHour.value = Number(c.send?.maxPerHour ?? 500)
  historyCount.value = Number(c.store?.historyCount ?? 80)
  promptAnchorEnabled.value = c.store?.promptAnchor?.enabled !== false
  promptAnchorMaxExtra.value = Number(c.store?.promptAnchor?.maxExtraRead ?? 5)
  stickerEnabled.value = c.sticker?.enabled === true
  stickerEncourage.value = Number(c.sticker?.encourage ?? 1)
  stickerPromptMax.value = Number(c.sticker?.promptMaxStickers ?? 10)

  serverAutoStart.value = c.server?.autoStart === true
  serverCloseToTray.value = c.server?.closeToTray !== false
  serverPort.value = Number(c.server?.port ?? 0)
  uiShowVision.value = c.ui?.showVision !== false
  uiRefreshMs.value = Number(c.ui?.refreshMs ?? 15000)

  // T3 语音电话（voice 容器 spec §2.6；缺省口径照 config.js:427-497）
  // W3：asr/tts 全键+call 全参数回填统一走 applyVoiceForm（分区 8 脚本区定义）。
  // dialect 缺省 undefined → ''（下拉"跟随 engine 名"）；apiKey 脱敏（GET 无此键
  // →hasApiKey 布尔），密码框恒空、不回填明文。
  applyVoiceForm(c.voice)

  const tools = c.tools || {}
  toolsEnabled.value = tools.enabled !== false
  const catOn: Record<string, boolean> = {}
  for (const cat of TOOL_CATEGORIES) catOn[cat.id] = tools.categories?.[cat.id] !== false
  toolsCatEnabled.value = catOn
  toolsOverride.value = { ...(tools.overrides || {}) }
}

function setNote(key: string, text: string): void {
  notes.value[key] = text
}

/** 目录全量模型（批量价格编辑的行集合，去重） */
const catalogModels = computed(() => [...new Set(providers.value.flatMap((p) => p.models || []))])

/** 批量价格编辑：给目录里每个模型补空条目（v-model 需要目标对象存在） */
function ensurePriceEdits(): void {
  for (const m of catalogModels.value) {
    if (!priceEdits.value[m]) priceEdits.value[m] = {}
  }
}

/** 单价输入随卡片联动（旧 refreshModelPriceCard：开关/模型一变就按来源重填） */
watch([selModel, useOfficialPrice], () => {
  priceIn.value = priceCard.value.in
  priceOut.value = priceCard.value.out
  priceCached.value = priceCard.value.cached
})

/** 批量价格编辑的「清除」= 清空该行三格（保存时空行 = 删除该条目，旧弹窗同语义） */
function clearPriceEdit(m: string): void {
  priceEdits.value[m] = {}
}

/** 批量自定义价格保存（旧 openBatchPriceModal bp-save 同款：__replace__ 整体替换，空行 = 删除） */
async function saveBatchPrices(): Promise<void> {
  await run('batchprice', async () => {
    const next: Record<string, { in: number; out: number; cached: number }> = {}
    for (const [m, v] of Object.entries(priceEdits.value)) {
      const i = v?.in
      const o = v?.out
      const ca = v?.cached
      if (i == null && o == null && ca == null) continue
      next[m] = { in: i ?? 0, out: o ?? 0, cached: ca ?? (i ?? 0) }
    }
    const r = await saveConfigPatch({ api: { modelPrices: { __replace__: next } } })
    if (r.config) cfg.value = r.config
    setNote('batchprice', `已保存 ${Object.keys(next).length} 个模型的自定义单价 ✓`)
  })
}

async function run(key: string, fn: () => Promise<void>): Promise<void> {
  saving.value[key] = true
  setNote(key, '')
  try {
    await fn()
  } catch (e) {
    setNote(key, `失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    saving.value[key] = false
  }
}

// ============================================================
// 统一保存（2026-11-21 所有者：全页一个「保存全部」按钮）——
// 各分区只负责把自己的表单态收进同一份 deepMerge patch，一次 POST 落盘；
// 分区即时动作（Key 显式清除/提供商管理/批量价格/技能开关/引擎快捷开关/头像）
// 保持原位原语义不动。人设热改：来源模板为自定义时，编辑后的正文随保存回写模板。
// ============================================================
async function saveAll(): Promise<void> {
  await run('all', async () => {
    const c = cfg.value
    const merged: Record<string, unknown> = {}

    // ── 分区 1 · 模型 API ──（provider Key 走专用端点，不进 config patch）
    const key = apiKeyInput.value.trim()
    if (key && selProviderId.value.trim()) {
      await setProviderKey(selProviderId.value.trim(), key)
    }
    const effort = thinkingSel.value
    const effortValid = ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
    const prevMode = String(c?.api?.thinkingMode || 'auto')
    let thinkingMode: string
    if (effort === 'off') thinkingMode = 'off'
    else if (effortValid) thinkingMode = 'on'
    else if (effort === 'on-noeffort') thinkingMode = 'on'
    else if (prevMode === 'on') thinkingMode = 'on'
    else thinkingMode = 'auto'
    merged.api = {
      baseUrl: baseUrl.value.trim(),
      model: selModel.value.trim(),
      provider: selProviderId.value.trim(),
      vision: visionOn.value,
      video: videoOn.value,
      videoMode: videoMode.value,
      visionModel: visionModel.value.trim(),
      videoModel: videoModel.value.trim(),
      temperature: Math.min(2, Math.max(0, Number(temperature.value) || 0.8)),
      maxRounds: Math.min(40, Math.max(1, Number(maxRounds.value) || 12)),
      maxTokens: Math.min(32000, Math.max(0, Number(maxTokens.value) || 0)),
      thinkingMode,
      thinkingEffort: effortValid ? effort : '',
      useOfficialPrice: useOfficialPrice.value,
      fallbackModels: fallbackRows.value
        .map((r) => ({ model: String(r.model || '').trim(), provider: String(r.provider || '').trim() }))
        .filter((r) => r.model),
    }
    // 价格（原 'api' 分支口径）：解锁态才写单价；锁定态不写（防显示值误存全局兜底）
    const curModel = selModel.value.trim()
    const customEntry = (c?.api?.modelPrices || {})[curModel]
    const hasCustom = !!(customEntry && (Number(customEntry.in) || Number(customEntry.out)))
    const locked = useOfficialPrice.value || hasCustom
    if (!locked && curModel) {
      const nextMap = { ...(c?.api?.modelPrices || {}) }
      const i = Number(priceIn.value) || 0
      const o = Number(priceOut.value) || 0
      const ca = Number(priceCached.value) || 0
      if (i || o || ca) nextMap[curModel] = { in: i, out: o, cached: ca || i }
      else delete nextMap[curModel]
      merged.api = { ...(merged.api as Record<string, unknown>), modelPrices: { __replace__: nextMap }, priceInputPerM: i, priceOutputPerM: o, priceCachedPerM: ca }
    }

    // ── 分区 2 · 搜索服务 ──
    const ws = c?.webSearch || {}
    const keyOf = (v: string): Record<string, string> => {
      const k = v.trim()
      return k && k !== '******' ? { apiKey: k } : {}
    }
    merged.webSearch = {
      ...ws,
      enabled: wsEnabled.value,
      provider: wsProvider.value,
      searchUrl: wsSearchUrl.value.trim() || 'https://cn.bing.com/search',
      deepseek: { ...(ws.deepseek || {}), ...keyOf(dsKeyInput.value), model: dsModel.value.trim() || 'deepseek-v4-flash' },
      zhipu: { ...(ws.zhipu || {}), ...keyOf(zhipuKeyInput.value), engine: zhipuEngine.value },
      bocha: { ...(ws.bocha || {}), ...keyOf(bochaKeyInput.value) },
      baidu: { ...(ws.baidu || {}), ...keyOf(baiduKeyInput.value) },
      metaso: { ...(ws.metaso || {}), ...keyOf(metasoKeyInput.value) },
      providers: (ws.providers || []).map((entry0) => {
        const entry = entry0 as SearchProviderEntry
        if (wsProvider.value !== `custom:${entry.id}`) return entry
        const entered = customKeyInput.value.trim()
        if (entered && entered !== '******') return { ...entry, apiKey: entered }
        return entry
      }),
    }

    // ── 分区 3 · 心智机制 ──
    merged.memory = {
      ...(c?.memory || {}),
      writer: { mode: writerMode.value },
      consolidateEnabled: memConsolidate.value,
      useChatModel: memUseChat.value,
      provider: memProvider.value.trim(),
      model: memModel.value.trim(),
      consolidateMinIntervalMs: Number(memInterval.value) || 21600000,
      embedding: {
        ...(c?.memory?.embedding || {}),
        enabled: embEnabled.value,
        provider: embProvider.value.trim(),
        model: embModel.value.trim(),
        queryInstruction: embQueryInstruction.value,
        gateMode: embGateMode.value,
        fuseWeights: {
          lexical: Number.isFinite(Number(embFuseLexical.value)) ? Number(embFuseLexical.value) : 1,
          vector: Number.isFinite(Number(embFuseVector.value)) ? Number(embFuseVector.value) : 1,
          row: Number.isFinite(Number(embFuseRow.value)) ? Number(embFuseRow.value) : 1,
          gist: Number.isFinite(Number(embFuseGist.value)) ? Number(embFuseGist.value) : 1,
          fact: Number.isFinite(Number(embFuseFact.value)) ? Number(embFuseFact.value) : 1,
        },
        vectorFloor: Number.isFinite(Number(embVectorFloor.value)) ? Number(embVectorFloor.value) : 0.45,
        rowFloor: Number.isFinite(Number(embRowFloor.value)) ? Number(embRowFloor.value) : 0.45,
        lexicalFloor: Number.isFinite(Number(embLexicalFloor.value)) ? Number(embLexicalFloor.value) : 2,
      },
    }
    merged.modules = { ...(c?.modules || {}), life: { ...((c?.modules?.life) || {}), enabled: lifeEnabled.value } }
    merged.life = { ...(c?.life || {}), promptMode: lifePromptMode.value === 'prose' ? 'prose' : 'off' }
    merged.transition = {
      ...(c?.transition || {}),
      enabled: transitionEnabled.value,
      ttlMin: Number.isFinite(Number(transitionTtlMin.value)) ? Number(transitionTtlMin.value) : 90,
      maxChars: Number.isFinite(Number(transitionMaxChars.value)) ? Number(transitionMaxChars.value) : 500,
    }

    // ── 分区 4 · 人设（含热改回写：自定义来源模板随保存同步正文/附加规则） ──
    merged.persona = {
      botName: botName.value.trim() || '汐',
      ownerLabel: ownerLabel.value.trim() || '对方',
      selfNickname: selfNickname.value.trim(),
      roleText: roleText.value,
      customRules: customRules.value,
      systemPromptOverride: sysPromptOverride.value,
    }
    if (personaSourceId.value.startsWith('custom_')) {
      const idx = Number(personaSourceId.value.slice('custom_'.length))
      const list = ((c?.customPersonas || []) as Array<Record<string, unknown>>).map((p0) => ({ ...p0 }))
      if (Number.isInteger(idx) && list[idx]) {
        list[idx] = { ...list[idx], text: roleText.value, customRules: customRules.value }
        merged.customPersonas = list
      }
    }

    // ── 分区 6 · 聊天设置 ──
    merged.wakeDelayMs = Number(wakeDelayMs.value) || 2000
    merged.drainDelayMs = Number(drainDelayMs.value) || 1200
    merged.maxConcurrentRuns = Math.min(8, Math.max(1, Number(maxConcurrentRuns.value) || 2))
    merged.sessionRetryAttempts = Math.min(5, Math.max(0, Number(sessionRetryAttempts.value) || 0))
    merged.send = {
      ...(c?.send || {}),
      minGapMs: Number(sendMinGapMs.value) || 1000,
      maxGapMs: Number(sendMaxGapMs.value) || 3000,
      maxPerMinute: Number(sendMaxPerMinute.value) || 80,
      maxPerHour: Number(sendMaxPerHour.value) || 500,
    }
    merged.store = {
      historyCount: Number(historyCount.value) || 80,
      promptAnchor: {
        enabled: promptAnchorEnabled.value === true,
        maxExtraRead: Math.max(0, Number(promptAnchorMaxExtra.value) || 5),
      },
    }
    merged.sticker = {
      ...(c?.sticker || {}),
      enabled: stickerEnabled.value === true,
      encourage: Math.min(3, Math.max(0, Number(stickerEncourage.value) || 0)),
      promptMaxStickers: Math.min(50, Math.max(1, Number(stickerPromptMax.value) || 10)),
    }

    // ── 分区 7 · 桌面端 ──
    merged.server = { autoStart: serverAutoStart.value === true, closeToTray: serverCloseToTray.value !== false }
    merged.ui = { showVision: uiShowVision.value !== false, refreshMs: Number(uiRefreshMs.value) || 15000 }

    // ── 分区 8 · 语音电话（apiKey 非空才提交，空 = 不动服务端现值） ──
    const asrPatch: Record<string, unknown> = {
      enabled: voiceAsrEnabled.value !== false,
      engine: asrEngine.value.trim() || 'off',
      dialect: asrDialect.value.trim(),
      baseUrl: asrBaseUrl.value.trim(),
      model: asrModel.value.trim(),
      language: asrLanguage.value.trim() || 'zh',
      timeoutMs: numOr(asrTimeoutMs.value, 15000, 1000),
    }
    if (asrApiKey.value.trim()) asrPatch.apiKey = asrApiKey.value.trim()
    const ttsPatch: Record<string, unknown> = {
      enabled: voiceTtsEnabled.value !== false,
      engine: ttsEngine.value.trim() || 'off',
      dialect: ttsDialect.value.trim(),
      baseUrl: ttsBaseUrl.value.trim(),
      model: ttsModel.value.trim(),
      voiceId: ttsVoiceId.value.trim() || 'stella',
      refVoice: ttsRefVoice.value.trim(),
      filterMarkdown: ttsFilterMarkdown.value !== false,
      format: ['ogg', 'wav', 'pcm'].includes(ttsFormat.value) ? ttsFormat.value : 'ogg',
      sampleRate: numOr(ttsSampleRate.value, 24000, 8000),
      bitrateKbps: numOr(ttsBitrateKbps.value, 24, 8),
      timeoutMs: numOr(ttsTimeoutMs.value, 5000, 1000),
    }
    if (ttsApiKey.value.trim()) ttsPatch.apiKey = ttsApiKey.value.trim()
    merged.voice = {
      enabled: voiceEnabled.value === true,
      engine: { manage: voiceEngineManage.value === 'manual' ? 'manual' : 'auto', gpuAllow: voiceGpuAllow.value !== false },
      asr: asrPatch,
      tts: ttsPatch,
      call: {
        enabled: voiceCallEnabled.value === true,
        silenceMs: numOr(callSilenceMs.value, 300, 100),
        minUtteranceMs: numOr(callMinUtteranceMs.value, 300, 100),
        maxUtteranceMs: numOr(callMaxUtteranceMs.value, 60000, 1000),
        firstSentenceMaxChars: numOr(callFirstSentenceMaxChars.value, 15, 1),
        maxSentences: numOr(callMaxSentences.value, 4, 1),
        promptBudget: numOr(callPromptBudget.value, 3000, 0),
        historyTurns: numOr(callHistoryTurns.value, 8, 0),
        recallMinSeconds: numOr(callRecallMinSeconds.value, 120, 0),
        recall: callRecall.value !== false,
        keepAudio: callKeepAudio.value === true,
        dnd: { start: callDndStart.value.trim() || '23:30', end: callDndEnd.value.trim() || '08:00' },
      },
    }

    const r = await saveConfigPatch(merged)
    if (r.config) cfg.value = r.config
    apiKeyInput.value = ''
    // 分区回填（原各 saveX 的 hydrate 步骤合并）
    writerMode.value = String(r.config?.memory?.writer?.mode ?? writerMode.value)
    hydratePersonaFrom(r.config as AppConfig)
    hydrateFromConfig()
    serverAutoStart.value = r.config?.server?.autoStart === true
    serverCloseToTray.value = r.config?.server?.closeToTray !== false
    uiShowVision.value = r.config?.ui?.showVision !== false
    uiRefreshMs.value = Number(r.config?.ui?.refreshMs ?? 15000)
    applyVoiceForm(r.config?.voice)
    await reloadSearchProviders()
    dsKeyInput.value = ''
    zhipuKeyInput.value = ''
    bochaKeyInput.value = ''
    baiduKeyInput.value = ''
    metasoKeyInput.value = ''
    customKeyInput.value = ''
    void refreshVoiceStatus(false)
    setNote('all', '已保存 ✓')
  })
}

// ============================================================
// 分区 1 · 模型 API（载荷照旧 saveConfig 'api' 分支 + 'chat' 分支的 sc-* 字段
//   + openModelConfigModal mc-save 的 vision 组字段）
// ============================================================
/** 目录选择：选提供商 → baseUrl 自动跟随该提供商端点（旧 openModelPicker L593 口径） */
function onProviderPicked(): void {
  const p = providers.value.find((x) => x.id === selProviderId.value)
  if (p?.baseURL) baseUrl.value = String(p.baseURL)
  const models = p?.models || []
  if (models.length && !models.includes(selModel.value)) selModel.value = models[0]
}

// ---- 模型管理（目录维护；载荷照 openModelManageModal/openProviderAddModal/openManualAddModelModal） ----
async function showManageKey(): Promise<void> {
  const pid = managePid.value
  if (!pid) return
  try {
    manageKeyInput.value = await fetchProviderKey(pid)
    manageShowKey.value = true
  } catch (e) {
    setNote('manage', `读取密钥失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function hideManageKey(): void {
  manageShowKey.value = false
  manageKeyInput.value = ''
}

async function clearManageKey(): Promise<void> {
  const pid = managePid.value
  if (!pid) return
  await run('manage', async () => {
    await setProviderKey(pid, '')
    await refreshAfterCatalogChange()
    manageKeyInput.value = ''
    manageShowKey.value = false
    setNote('manage', 'API Key 已清除 ✓')
  })
}

/** 目录改动后：重拉 providers + config（旧 loadSettings→render 的刷新顺序） */
async function refreshAfterCatalogChange(): Promise<void> {
  providers.value = await fetchProviders().catch(() => [])
  const c = await fetchConfig()
  cfg.value = c
  ensurePriceEdits()
  const api = c.api || {}
  selProviderId.value = String(api.provider ?? '')
  selModel.value = String(api.model ?? '')
  baseUrl.value = String(api.baseUrl ?? '')
  if (!providers.value.find((p) => p.id === managePid.value)) {
    managePid.value = providers.value[0]?.id || ''
  }
}

async function saveProviderName(): Promise<void> {
  const pid = managePid.value
  if (!pid) return
  await run('manage', async () => {
    await renameProvider(pid, manageName.value.trim())
    await refreshAfterCatalogChange()
    setNote('manage', '已保存显示名 ✓')
  })
}

async function saveManualModel(): Promise<void> {
  const pid = managePid.value
  const id = manualModelId.value.trim()
  if (!pid || !id) return
  await run('manage', async () => {
    await addProviderModels(pid, [{ id, name: manualModelName.value.trim() || id }])
    manualModelId.value = ''
    manualModelName.value = ''
    await refreshAfterCatalogChange()
    setNote('manage', `已添加模型 ${id} ✓`)
  })
}

async function pullModels(): Promise<void> {
  const pid = managePid.value
  const p = providers.value.find((x) => x.id === pid)
  if (!pid || !p?.baseURL) return
  await run('manage', async () => {
    const r = await fetchProviderModels(String(p.baseURL), { providerId: pid })
    fetchedModels.value = r.models || []
    fetchedPicked.value = {}
    setNote('manage', fetchedModels.value.length ? `拉取到 ${fetchedModels.value.length} 个模型，勾选后加入列表` : '端点没有返回模型（可手动添加）')
  })
}

async function addPulledModels(): Promise<void> {
  const pid = managePid.value
  if (!pid) return
  const picked = fetchedModels.value.filter((m) => fetchedPicked.value[m])
  if (!picked.length) return
  await run('manage', async () => {
    await addProviderModels(pid, picked.map((m) => ({ id: m, name: m })))
    fetchedModels.value = []
    fetchedPicked.value = {}
    await refreshAfterCatalogChange()
    setNote('manage', `已加入 ${picked.length} 个模型 ✓`)
  })
}

async function removeModel(pid: string, modelId: string): Promise<void> {
  await run('manage', async () => {
    await deleteProviderModel(pid, modelId)
    await refreshAfterCatalogChange()
    setNote('manage', `已删除模型 ${modelId} ✓`)
  })
}

function addProvRow(): void {
  addProvRows.value.push({ id: '', name: '' })
}

function removeProvRow(i: number): void {
  if (addProvRows.value.length <= 1) return
  addProvRows.value.splice(i, 1)
}

async function saveNewProvider(): Promise<void> {
  const baseUrlV = addProvBaseUrl.value.trim()
  const apiKeyV = addProvApiKey.value.trim()
  const models = addProvRows.value
    .map((r) => ({ id: r.id.trim(), name: r.name.trim() || r.id.trim() }))
    .filter((m) => m.id)
  if (!baseUrlV) return setNote('manage', '请填写 Base URL')
  if (!apiKeyV) return setNote('manage', '请填写 API Key（提供商必须带密钥才能测试连通性）')
  if (!models.length) return setNote('manage', '请至少添加一个模型（或拉取后勾选）')
  await run('manage', async () => {
    await addProvider(baseUrlV, apiKeyV, models)
    addProvOpen.value = false
    addProvBaseUrl.value = ''
    addProvApiKey.value = ''
    addProvRows.value = [{ id: '', name: '' }]
    await refreshAfterCatalogChange()
    setNote('manage', '提供商已添加 ✓')
  })
}

async function removeProvider(): Promise<void> {
  const pid = managePid.value
  if (!pid) return
  await run('manage', async () => {
    await deleteProvider(pid)
    managePid.value = ''
    await refreshAfterCatalogChange()
    setNote('manage', '提供商已删除（若删除的是当前主提供商，请重新选择模型）')
  })
}

// ============================================================
// 分区 2 · 搜索服务（载荷照旧 saveConfig 'search' 分支 + 自定义服务专用端点）
// ============================================================
const BUILTIN_SEARCH_FIELDS: Record<string, string> = {
  deepseek: 'deepseek',
  zhipu: 'zhipu',
  bocha: 'bocha',
  baidu: 'baidu',
  metaso: 'metaso',
}

/** 当前选中的自定义搜索服务条目（provider 形如 custom:<id>） */
const selCustomProvider = computed(() => {
  if (!wsProvider.value.startsWith('custom:')) return null
  const id = wsProvider.value.slice('custom:'.length)
  return (cfg.value?.webSearch?.providers || []).find((p) => String(p.id) === id) || null
})

async function reloadSearchProviders(): Promise<void> {
  searchProviders.value = await fetchSearchProviders().catch(() => [])
}

/** 显示已存 Key（明文只经专用端点；仅本机放行） */
async function revealSearchKey(kind: string): Promise<void> {
  const field = kind === 'custom' ? wsProvider.value : kind
  await run('search', async () => {
    const r = await fetchSearchKey(field)
    const v = String(r.apiKey || '')
    if (kind === 'deepseek') dsKeyInput.value = v
    else if (kind === 'zhipu') zhipuKeyInput.value = v
    else if (kind === 'bocha') bochaKeyInput.value = v
    else if (kind === 'baidu') baiduKeyInput.value = v
    else if (kind === 'metaso') metasoKeyInput.value = v
    else if (kind === 'custom') customKeyInput.value = v
    setNote('search', '已读取明文（仅本机可见）')
  })
}

/** 清除 Key（旧语义：留空保存 = 不变，必须点清除；内置走 config patch，自定义走 search-providers 空串） */
async function clearSearchKey(kind: string): Promise<void> {
  await run('search', async () => {
    if (kind === 'custom') {
      const cp = selCustomProvider.value
      if (!cp) throw new Error('找不到这个自定义搜索服务')
      await saveSearchProvider({
        name: cp.name, type: cp.type, baseUrl: String(cp.baseUrl || ''),
        model: cp.model, apiKey: '', count: cp.count, timeoutMs: cp.timeoutMs,
      })
    } else {
      const field = BUILTIN_SEARCH_FIELDS[kind]
      if (!field) throw new Error(`未知搜索服务：${kind}`)
      await saveConfigPatch({ webSearch: { [field]: { apiKey: '' } } })
    }
    if (kind === 'deepseek') dsKeyInput.value = ''
    else if (kind === 'zhipu') zhipuKeyInput.value = ''
    else if (kind === 'bocha') bochaKeyInput.value = ''
    else if (kind === 'baidu') baiduKeyInput.value = ''
    else if (kind === 'metaso') metasoKeyInput.value = ''
    else if (kind === 'custom') customKeyInput.value = ''
    const c = await fetchConfig()
    cfg.value = c
    await reloadSearchProviders()
    setNote('search', 'API Key 已清除 ✓')
  })
}

async function testCurrentSearchProvider(): Promise<void> {
  if (!wsProvider.value.startsWith('custom:')) {
    searchTestHint.value = '请先选择一个自定义搜索服务'
    return
  }
  searchTestHint.value = '测试中…'
  try {
    const r = await testSearchProvider(wsProvider.value)
    const res = r.result || {}
    searchTestHint.value = res.ok
      ? `✓ 可用（${res.count} 条结果，${res.latencyMs}ms）${res.sample ? `：${res.sample.slice(0, 30)}` : ''}`
      : `✗ ${res.note || '不可用'}`
  } catch (e) {
    searchTestHint.value = `测试失败：${e instanceof Error ? e.message : String(e)}`
  }
}

async function deleteCurrentSearchProvider(): Promise<void> {
  if (!wsProvider.value.startsWith('custom:')) return
  await run('search', async () => {
    await deleteSearchProvider(wsProvider.value.slice('custom:'.length))
    wsProvider.value = 'bing'
    const c = await fetchConfig()
    cfg.value = c
    await reloadSearchProviders()
    setNote('search', '已删除该自定义搜索服务 ✓')
  })
}

async function addSearchProvider(): Promise<void> {
  const baseUrlV = newSp.baseUrl.trim()
  if (!baseUrlV) {
    setNote('addsp', '请先填接口地址')
    return
  }
  await run('addsp', async () => {
    const r = await saveSearchProvider({
      name: newSp.name.trim(),
      type: newSp.type || 'openai',
      baseUrl: baseUrlV,
      apiKey: newSp.apiKey.trim(),
      model: newSp.model.trim(),
    })
    if (!r.provider?.id) throw new Error('添加失败：后端未返回 provider id')
    // 添加后直接选中它（旧 add-search-provider-btn 同款两连击）
    await saveConfigPatch({ webSearch: { provider: `custom:${r.provider.id}` } })
    const c = await fetchConfig()
    cfg.value = c
    wsProvider.value = `custom:${r.provider.id}`
    await reloadSearchProviders()
    newSp.name = ''
    newSp.type = 'openai'
    newSp.baseUrl = ''
    newSp.apiKey = ''
    newSp.model = ''
    setNote('addsp', '已添加并选中 ✓')
  })
}

// ============================================================
// 分区 3 · 记忆整理（载荷照旧 saveConfig 'memory' 分支；writer.mode 并入同一 patch；
//   W4 起 embedding 全键并入同一 patch——spread 服务端现值再覆盖本表单键，
//   rowFloor/dateCollapse 等未收集键保持现值不丢）
// ============================================================
// ============================================================
// 分区 4 · 人设（载荷照旧 saveConfig 'persona' 分支）
// ============================================================
function pickPersonaTemplate(): void {
  const tpl = templates.value.find((t) => t.id === personaPickId.value)
  if (!tpl) return
  roleText.value = String(tpl.text || '')
  customRules.value = String(tpl.customRules || '')
  personaSourceId.value = personaPickId.value   // 热改回写目标（自定义模板才生效）
}

const curPersonaTemplate = computed(() => templates.value.find((t) => t.text === roleText.value) || null)

async function savePersonaAdd(): Promise<void> {
  const name = personaAddName.value.trim()
  const text = personaAddText.value.trim()
  if (!name || !text) {
    setNote('persona', '人设名称和角色设定都不能为空')
    return
  }
  await run('persona', async () => {
    await addPersonaTemplate(name, text, personaAddRules.value.trim())
    templates.value = await fetchPersonaTemplates()
    personaAddName.value = ''
    personaAddText.value = ''
    personaAddRules.value = ''
    personaAddOpen.value = false
    setNote('persona', '自定义人设已添加 ✓')
  })
}

async function removeCurPersona(): Promise<void> {
  const tpl = curPersonaTemplate.value
  if (!tpl?.id || !tpl.id.startsWith('custom_')) return
  await run('persona', async () => {
    await deletePersonaTemplate(tpl.id as string)
    templates.value = await fetchPersonaTemplates()
    // 回填默认人设（旧 07-settings-events.js L852-856 口径：第一个内置模板）
    const firstBuiltin = templates.value.find((t) => t.builtin)
    roleText.value = String(firstBuiltin?.text || '')
    customRules.value = ''
    personaPickId.value = ''
    setNote('persona', '已删除该自定义人设，角色设定已回填默认 ✓')
  })
}

function hydratePersonaFrom(c: AppConfig | undefined): void {
  if (!c) return
  const per = c.persona || {}
  botName.value = String(per.botName ?? '')
  ownerLabel.value = String(per.ownerLabel ?? '对方')
  selfNickname.value = String(per.selfNickname ?? '')
  roleText.value = String(per.roleText ?? '')
  customRules.value = String(per.customRules ?? '')
  sysPromptOverride.value = String(per.systemPromptOverride ?? '')
  const matched = templates.value.find((t) => t.text === roleText.value)?.id || ''
  personaPickId.value = matched
  personaSourceId.value = matched   // 文本匹配兜底（无显式选择时）
}

// ============================================================
// （分区 5 聊天白名单已随 2026-11-21 所有者指令删除，allow/deny 配置键保留）
// ============================================================
// 分区 6 · 聊天设置（载荷照旧 saveConfig 'chat' 分支 L1388-1433 的 sc-* 字段
//   + sticker 组；temperature/maxRounds/maxTokens/思考强度已在分区 1，不重复收集。
//   store.historyCount / store.promptAnchor 为本页新增——旧 UI 无编辑器
//   （2026-10-31 精简随群聊卡片下线），按任务点名补齐，同一 POST 深合并。
//   清债夜1 核验：store.contextTier/keywords/randomPercent/contextSliderPos/
//   unifiedTier/groupSliderPos/groupPeakPos/peakSchedule/commandMute 死键
//   前端零控件零引用（键本体由后端清债夜2 删除））
// ============================================================
// ============================================================
// 分区 7 · 桌面端（载荷照旧 saveConfig 'desktop' 分支 L1435-1452：
//   server {autoStart, closeToTray} + ui {showVision, refreshMs}。
//   server.port 只读展示（端口由 QQ_AGENT_PORT/PROFILE 在启动期决定，改配置不换运行端口）；
//   ui.theme 不在此处写：S-1 已定主题只存本机（localStorage），与「主题」卡口径一致
//   ——旧 UI 的 desktop 分支会把主题一并写后端，本页保持 S-1 决策（记 drift））
// ============================================================
// ============================================================
// 分区 8 · 语音电话（T3 V2 前端 + W3 大扩充，night-plan §2-T3 / spec §2.6 /
// night-plan-polish §2-W3.1-2）：voice 全键 deepMerge patch——
//   enabled / engine.{manage,gpuAllow} / asr.* / tts.* / call.*（含 dnd）。
// 保存语义沿用「只传本分区键」；apiKey 仅在密码框非空时提交——GET /api/config
// 脱敏后前端拿不到明文，若把空串回传 deepMerge 会把服务端真 Key 覆盖成 ''
// （sanitizeConfig 注释同款教训）；hasApiKey 布尔只作占位提示，清除走
// clearVoiceApiKey 显式发 apiKey:''。保存后按返回 config 回填并刷新状态卡
// （无参快照——不触发探针，卡上数据仍以上次探测为准）。
// ============================================================

/** 数值输入归一（空/非法回落缺省；min 兜底防 0/负值写进 config） */
function numOr(v: number, dflt: number, min = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, n) : dflt
}

/** 语音分区表单回填（load 与保存/清 key 后共用；密钥框恒清空） */
function applyVoiceForm(vc: AppConfig['voice']): void {
  voiceEnabled.value = vc?.enabled === true
  voiceCallEnabled.value = vc?.call?.enabled === true
  voiceEngineManage.value = String(vc?.engine?.manage || 'auto')
  voiceGpuAllow.value = vc?.engine?.gpuAllow !== false
  voiceTtsEnabled.value = vc?.tts?.enabled !== false
  voiceAsrEnabled.value = vc?.asr?.enabled !== false
  const va = vc?.asr || {}
  asrEngine.value = String(va.engine ?? 'off')
  asrDialect.value = String(va.dialect ?? '')
  asrBaseUrl.value = String(va.baseUrl ?? '')
  asrApiKey.value = ''
  asrHasApiKey.value = va.hasApiKey === true
  asrModel.value = String(va.model ?? '')
  asrLanguage.value = String(va.language ?? 'zh')
  asrTimeoutMs.value = Number(va.timeoutMs ?? 15000)
  const vt = vc?.tts || {}
  ttsEngine.value = String(vt.engine ?? 'off')
  ttsDialect.value = String(vt.dialect ?? '')
  ttsBaseUrl.value = String(vt.baseUrl ?? '')
  ttsApiKey.value = ''
  ttsHasApiKey.value = vt.hasApiKey === true
  ttsModel.value = String(vt.model ?? '')
  ttsVoiceId.value = String(vt.voiceId ?? 'stella')
  ttsRefVoice.value = String(vt.refVoice ?? '')
  ttsFilterMarkdown.value = vt.filterMarkdown !== false
  ttsFormat.value = String(vt.format ?? 'ogg')
  ttsSampleRate.value = Number(vt.sampleRate ?? 24000)
  ttsBitrateKbps.value = Number(vt.bitrateKbps ?? 24)
  ttsTimeoutMs.value = Number(vt.timeoutMs ?? 5000)
  const cc = vc?.call || {}
  callSilenceMs.value = Number(cc.silenceMs ?? 300)
  callMinUtteranceMs.value = Number(cc.minUtteranceMs ?? 300)
  callMaxUtteranceMs.value = Number(cc.maxUtteranceMs ?? 60000)
  callFirstSentenceMaxChars.value = Number(cc.firstSentenceMaxChars ?? 15)
  callMaxSentences.value = Number(cc.maxSentences ?? 4)
  callPromptBudget.value = Number(cc.promptBudget ?? 3000)
  callHistoryTurns.value = Number(cc.historyTurns ?? 8)
  callRecallMinSeconds.value = Number(cc.recallMinSeconds ?? 120)
  callRecall.value = cc.recall !== false
  callKeepAudio.value = cc.keepAudio === true
  callDndStart.value = String(cc.dnd?.start ?? '23:30')
  callDndEnd.value = String(cc.dnd?.end ?? '08:00')
}

/** 清除引擎 apiKey（显式发 apiKey:''——与「输入新值覆盖」互补；同款语义见
 *  routes.js 搜索 provider 的 apiKey 注释块） */
async function clearVoiceApiKey(kind: 'asr' | 'tts'): Promise<void> {
  const label = kind === 'tts' ? 'TTS' : 'ASR'
  await run('voice', async () => {
    const r = await saveConfigPatch({ voice: { [kind]: { apiKey: '' } } })
    if (r.config) cfg.value = r.config
    applyVoiceForm(r.config?.voice)
    setNote('voice', `${label} apiKey 已清除`)
    void refreshVoiceStatus(false)
  })
}

// ── W3 信息区状态卡（GET /api/voice/status 只读快照）────────────────────────
/** 手动拉起本地引擎（2026-11-20）：与 W1 开关共用 /api/voice/ensure，但不再要求
 *  「关→开」才触发；重开应用后配置仍为 enabled 时点一下即可。**不改任何配置**。 */
async function launchVoiceEngines(): Promise<void> {
  await run('voiceLaunch', async () => {
    const er = await ensureVoiceEngines()
    const s = describeEnsureResult(er?.result)
    setNote('voice', s.text)
    void refreshVoiceStatus(false)
  })
}

/** 拉状态卡：probe=true 触发即时探针（只探测不拉起，结果徽标行播报）；
 *  false 读服务端缓存快照（本进程未探测过=灰点"未探测"）。 */
async function refreshVoiceStatus(probe = false): Promise<void> {
  await run(probe ? 'voiceProbe' : 'voiceStatus', async () => {
    const st = await fetchVoiceStatus(probe)
    voiceStatus.value = st
    if (probe) {
      const a = st.engines?.asr
      const t = st.engines?.tts
      setNote('voice', `探测完成：ASR ${a?.running ? `✓ 在线（${a.lastProbeMs ?? 0}ms）` : `✗ ${a?.reason || '不可达'}`}；` +
        `TTS ${t?.running ? `✓ 在线（${t.lastProbeMs ?? 0}ms）` : `✗ ${t?.reason || '不可达'}`}`)
    }
  })
}

/** 探针时刻 → HH:MM:SS（at 缺失=—） */
function fmtProbeAt(at?: number | null): string {
  if (!at) return '—'
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 自拉进程已运行时长（startedAt → 12s / 3m05s / 1h02m） */
function fmtProcUptime(startedAt?: number): string {
  if (!startedAt) return '—'
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m${String(sec % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** 双引擎状态行（绿点=running===true；灰点=不可达或本进程未探测过） */
const voiceEnginesView = computed(() => {
  const eng = voiceStatus.value?.engines ?? {}
  const mk = (kind: 'asr' | 'tts', label: string) => {
    const e = eng[kind]
    const running = e?.running
    const state = running === true ? '在线' : running === false ? '不可达' : '未探测'
    const parts = [`${e?.engine ?? 'off'}`, `方言 ${e?.dialect || '—'}`, e?.configured ? '已配置' : '未配置', state]
    if (e?.lastProbeMs != null) parts.push(`探针 ${e.lastProbeMs}ms @${fmtProbeAt(e.lastProbeAt)}`)
    if (kind === 'tts' && e?.breakerOpen) parts.push('⚠️ 熔断中')
    return { kind, label, on: running === true, main: parts.join(' · ') }
  }
  return [mk('asr', 'ASR 识别'), mk('tts', 'TTS 合成')]
})

/** 状态卡副行（进程表/上次耗时/embedding/语音条开关态） */
const voiceStatusExtras = computed(() => {
  const st = voiceStatus.value
  if (!st) return []
  const out: string[] = []
  const procs = st.processes ?? []
  out.push(`App 自拉进程 ${procs.length} 个` +
    (procs.length ? `：${procs.map((p) => `${p.kind || '?'}#${p.pid} 已跑 ${fmtProcUptime(p.startedAt)}`).join('、')}` : '（外部手启引擎不在此列）'))
  const s = st.timings?.lastSynth
  out.push(`上次合成：${s ? `${s.ms}ms ${s.ok ? '✓' : '✗'} @${fmtProbeAt(s.at)}` : '—（本进程未试过）'}`)
  const tr = st.timings?.lastTranscribe
  out.push(`上次转写：${tr ? `${tr.ms}ms ${tr.ok ? '✓' : '✗'} @${fmtProbeAt(tr.at)}` : '—（本进程未试过）'}`)
  out.push(`embedding：${st.embedding?.enabled ? `开（${st.embedding.model || '模型未填'}）` : '关'}`)
  out.push(`消息语音条：${st.messageVoiceBars ? '开' : '关'}${st.ttsFailStreak ? ` · TTS 失败连击 ${st.ttsFailStreak}` : ''}`)
  return out
})

/** W1 快捷开关（night-plan-polish §2-W1.3）：voice.tts.enabled / voice.asr.enabled
 *  即时 POST /api/config 单键 deepMerge patch（与「保存语音设置」的
 *  voice.enabled/engine/call 载荷互不覆盖，asr/tts 其余高级键零扰动）；
 *  开 → POST /api/voice/ensure 联动 engine-manager 拉起+预热，结果 toast
 *  （notes.voice 徽标行）；关 → 零调用（闸门 null，通话/语音条立即降级纯文字）。 */
async function toggleVoiceEngine(kind: 'tts' | 'asr'): Promise<void> {
  const label = kind === 'tts' ? '语音回复 TTS' : '语音识别 ASR'
  await run('voice', async () => {
    const on = kind === 'tts' ? voiceTtsEnabled.value : voiceAsrEnabled.value
    const r = await saveConfigPatch({ voice: { [kind]: { enabled: on } } })
    if (r.config) cfg.value = r.config
    voiceTtsEnabled.value = r.config?.voice?.tts?.enabled !== false
    voiceAsrEnabled.value = r.config?.voice?.asr?.enabled !== false
    if (!on) {
      setNote('voice', `${label}已关闭：零调用（语音条/通话她侧立即降级纯文字）`)
      return
    }
    const er = await ensureVoiceEngines()
    const st = er?.result?.[kind]
    if (!st) {
      setNote('voice', `${label}已开启（引擎联动无返回）`)
      return
    }
    if (!st.configured) {
      setNote('voice', `${label}已开启；引擎未配置（engine/baseUrl 维持 config.json 手工口径）`)
      return
    }
    if (st.ok) {
      const warm = er?.result?.warmup
      const warmTxt = kind === 'tts'
        ? (warm?.ok ? `；预热 ${warm.ms ?? 0}ms ✓` : '；预热未完成（不碍使用，首句稍慢）')
        : ''
      setNote('voice', `${label}已开启：引擎${st.spawned ? '已拉起并就绪' : '已在运行'}${warmTxt}`)
    } else {
      setNote('voice', `${label}已开启，但引擎未能就绪：${st.reason ?? '未知原因'}`)
    }
  })
}

// ============================================================
// 分区 9 · 工具与技能（工具开关载荷照旧 saveConfig 'tools' 分支 L1471-1474 +
//   07-settings-events.js L196-260：全局/分类/单工具开关；
//   全部启用/恢复默认的 categories 用 __replace__ 整体替换清残留——
//   overrides 同样用 __replace__（旧 UI 只对 categories 用了，overrides 漏了，
//   deepMerge 下 {} 清不掉已有键，本页修正并记 drift）；技能开关复用
//   POST /api/skills/:id {enabled}；刷新走 POST /api/skills/reload）
// ============================================================
async function saveTools(patchTools: Record<string, unknown>, note = '已保存 ✓'): Promise<void> {
  await run('tools', async () => {
    const r = await saveConfigPatch({ tools: patchTools })
    if (r.config) cfg.value = r.config
    const tools = r.config?.tools || {}
    toolsEnabled.value = tools.enabled !== false
    const catOn: Record<string, boolean> = {}
    for (const cat of TOOL_CATEGORIES) catOn[cat.id] = tools.categories?.[cat.id] !== false
    toolsCatEnabled.value = catOn
    toolsOverride.value = { ...(tools.overrides || {}) }
    setNote('tools', note)
  })
}

function toggleTool(t: ToolEntry, checked: boolean): void {
  const id = String(t.id || '')
  if (!id) return
  void saveTools({ overrides: { [id]: checked } })
}

function toggleToolGlobal(): void {
  void saveTools({ enabled: toolsEnabled.value === true })
}

function toggleToolCategory(cat: string, checked: boolean): void {
  void saveTools({ categories: { [cat]: checked } })
}

async function toolsEnableAll(): Promise<void> {
  await saveTools(
    { enabled: true, overrides: { __replace__: {} }, categories: { __replace__: {} } },
    '已全部启用 ✓',
  )
}

async function toolsDisableAll(): Promise<void> {
  await saveTools({ enabled: false }, '已全部禁用 ✓')
}

async function toolsReset(): Promise<void> {
  await saveTools(
    { enabled: true, overrides: { __replace__: {} }, categories: { __replace__: {} } },
    '已恢复默认 ✓',
  )
}

/** 技能开关（立即生效落盘，生命周期在后端；与工具开关的关键区别照旧 UI 注释口径） */
async function toggleSkill(id: string, enabled: boolean): Promise<void> {
  const key = `skill:${id}`
  await run(key, async () => {
    await setSkillEnabled(id, enabled)
    skillsPayload.value = await fetchSkills()
  })
}

/** 技能/插件重扫（旧 rescanSkills 同款：reload 后补拉一次带 uninstalled 的列表） */
async function rescanSkills(): Promise<void> {
  await run('skills-rescan', async () => {
    skillsPayload.value = await reloadSkillsList()
    toolList.value = await fetchTools().catch(() => toolList.value)
    setNote('skills-rescan', '已重扫磁盘 ✓')
  })
}

/** 技能展示状态（注册表条目优先；未安装残留用配置 enabled 缺省） */
const skillRows = computed<Array<{
  id: string
  name: string
  description: string
  kindLabel: string
  installed: boolean
  enabled: boolean
  active: boolean
  reason: string
  loadError: string
}>>(() => {
  const rows: Array<{
    id: string
    name: string
    description: string
    kindLabel: string
    installed: boolean
    enabled: boolean
    active: boolean
    reason: string
    loadError: string
  }> = []
  for (const s of skillsPayload.value?.skills || []) {
    const id = String(s.id || '')
    if (!id) continue
    rows.push({
      id,
      name: String(s.name || id),
      description: String(s.description || ''),
      kindLabel: s.kind === 'plugin' ? '插件' : s.kind === 'skill' ? '技能' : '',
      installed: true,
      enabled: s.enabled === true,
      active: s.active === true,
      reason: String(s.reason || ''),
      loadError: String(s.loadError || ''),
    })
  }
  for (const u of skillsPayload.value?.uninstalled || []) {
    rows.push({
      id: String(u.id || ''),
      name: String(u.id || ''),
      description: '已配置但未安装（目录已删除的配置残留）',
      kindLabel: '',
      installed: false,
      enabled: u.enabled !== false,
      active: false,
      reason: '',
      loadError: '',
    })
  }
  return rows
})

function pickTheme(t: ThemeName): void {
  setTheme(t)
}

// ============================================================
// S2 设计稿五（2026-11-18）：左缘分区锚点导航 + 每分区保存状态徽标
// ============================================================
/** 九分区锚点表（与页面分区顺序一致；页面 section 挂同名 id；T3 起含语音电话）。
 *  key = 该分区主保存操作的 notes/saving 键（子操作键不入徽标）。 */
const SECTIONS = [
  { id: 'sec-api', label: '模型 API', key: 'api' },
  { id: 'sec-search', label: '搜索服务', key: 'search' },
  { id: 'sec-memory', label: '心智机制', key: 'memory' },
  { id: 'sec-persona', label: '人设', key: 'persona' },
  { id: 'sec-chat', label: '聊天设置', key: 'chat' },
  { id: 'sec-desktop', label: '桌面端', key: 'desktop' },
  { id: 'sec-voice', label: '语音电话', key: 'voice' },
  { id: 'sec-tools', label: '工具与技能', key: 'tools' },
] as const

/** 锚点跳转：滚动容器是 AppLayout 的 .page（overflow:auto），scrollIntoView 就近生效 */
function jumpToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** 保存状态徽标四态：未保存（本页尚未保存过）/ 保存中 / 已保存 / 保存失败。
 *  从既有 notes/saving 口径派生（run() 保存先清 notes、失败写「失败：…」、
 *  成功写「… ✓」——失败判定含 失败/✗/⚠）。不做全量表单 dirty diff（改动面
 *  最小化，登记 handoff §10-14）。 */
type SaveState = 'unsaved' | 'saving' | 'saved' | 'failed'
function saveStateOf(key: string): SaveState {
  if (saving.value[key]) return 'saving'
  const n = String(notes.value[key] ?? '')
  if (n.includes('失败') || n.includes('✗') || n.includes('⚠')) return 'failed'
  if (n.includes('✓')) return 'saved'
  return 'unsaved'
}

const SAVE_BADGE_TEXT: Record<SaveState, string> = {
  unsaved: '未保存',
  saving: '保存中…',
  saved: '已保存',
  failed: '保存失败',
}

onMounted(() => {
  void load()
  void refreshVoiceStatus(false)   // W3 状态卡首拉（缓存快照，不触发探针）
  void loadAvatarTs()              // 自定义头像时间戳（右栏/通话页头像同源）
})
</script>

<template>
  <div class="set-page">
    <div class="page-head">
      <p class="head-note" :class="{ err: loadError }">
        <template v-if="loadError">加载失败：{{ loadError }}</template>
        <template v-else-if="loading">读取中…</template>
        <template v-else>设置 · 左缘目录可跳转 · 改完点右侧「保存全部」</template>
      </p>
      <div class="head-actions">
        <button class="btn btn-accent" :disabled="saving.all" @click="saveAll">保存全部</button>
        <span class="save-badge" :class="saveStateOf('all')">{{ SAVE_BADGE_TEXT[saveStateOf('all')] }}</span>
        <span v-if="notes.all" class="hint-text">{{ notes.all }}</span>
        <button class="btn" :disabled="loading" @click="load">重新读取</button>
      </div>
    </div>

    <!-- S2 设计稿五：左缘分区锚点导航（sticky 目录，点击滚动；窄窗隐藏） -->
    <div class="set-body">
      <nav class="sec-nav" aria-label="设置分区目录">
        <button
          v-for="s in SECTIONS"
          :key="s.id"
          type="button"
          class="sec-link"
          @click="jumpToSection(s.id)"
        >
          {{ s.label }}
        </button>
      </nav>

      <div class="set-sections">

    <!-- ═══ 分区 1 · 模型 API ═══ -->
    <section id="sec-api" class="card block">
      <h2 class="section-title">模型 API</h2>
      <div class="fields">
        <label class="field">
          <span>提供商（多提供商目录）</span>
          <select v-model="selProviderId" @change="onProviderPicked">
            <option value="">（不用目录 · 直连下方 Base URL）</option>
            <option v-if="providerId && !providers.some((p) => p.id === providerId)" :value="providerId">
              {{ providerId }}（不在目录）
            </option>
            <option v-for="p in providers" :key="p.id" :value="p.id">
              {{ p.displayName || p.id }}{{ p.hasKey ? ' · 已存 Key' : '' }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>模型 id（目录模型可下拉选，也可手填）</span>
          <div class="model-row">
            <input v-model="selModel" type="text" list="provider-model-list" placeholder="留空 = 未选模型" />
            <select v-model="selModel" class="model-switch" :disabled="!modelSwitchOptions.length" title="切换当前提供商已保存的模型">
              <option value="" disabled>切换模型…</option>
              <option v-for="m in modelSwitchOptions" :key="m" :value="m">{{ (curProvider?.modelNames || {})[m] || m }}</option>
            </select>
          </div>
          <datalist id="provider-model-list">
            <option v-for="m in curProviderModels" :key="m" :value="m">{{ (curProvider?.modelNames || {})[m] || m }}</option>
          </datalist>
        </label>
        <label class="field">
          <span>Base URL</span>
          <input v-model="baseUrl" type="text" placeholder="例如 https://api.deepseek.com/v1 或自建网关" />
        </label>
        <label class="field">
          <span>API Key{{ hasApiKey ? '（已保存，不显示）' : '（未保存）' }}</span>
          <input
            v-model="apiKeyInput"
            type="password"
            autocomplete="new-password"
            :placeholder="hasApiKey ? '输入新 Key 可替换；留空保持不变' : '输入 API Key'"
          />
          <div class="actions">
            <button class="btn btn-sm" @click="revealApiKey">显示已存 Key</button>
            <button class="btn btn-sm btn-danger" @click="clearApiKey">清除密钥</button>
            <span class="hint">留空保存 = 保持已存 Key 不变；真清除必须点「清除密钥」。</span>
          </div>
        </label>
        <p v-if="curProvider" class="hint">
          当前提供商：{{ curProvider.displayName || curProvider.id }} @ {{ curProvider.baseURL }} ·
          {{ curProvider.hasKey ? '已保存 API Key（不显示）' : '未保存 API Key' }}
        </p>
        <p v-if="visionHint" class="hint">{{ visionHint }}</p>

        <div class="row-2">
          <label class="check-row">
            <input v-model="visionOn" type="checkbox" />
            <span>图片输入（关闭则移除看图工具）</span>
          </label>
          <label class="check-row">
            <input v-model="videoOn" type="checkbox" />
            <span>视频输入（GIF 转视频发给模型）</span>
          </label>
        </div>
        <div class="row-2">
          <label class="field">
            <span>图片输入专用模型（留空用主模型）</span>
            <input v-model="visionModel" type="text" placeholder="留空 = 用主模型" />
          </label>
          <label class="field">
            <span>视频输入专用模型（留空用主模型）</span>
            <input v-model="videoModel" type="text" placeholder="留空 = 用主模型" />
          </label>
        </div>
        <label class="field">
          <span>视频理解方式</span>
          <select v-model="videoMode">
            <option value="auto">自动：配了视频专用模型就原生读视频，否则抽帧</option>
            <option value="native">原生：把视频直接交给全模态模型（需模型支持）</option>
            <option value="frames">抽帧：把视频变成若干张图片（任何视觉模型都能用）</option>
            <option value="off">关闭：只读时长/分辨率等元信息</option>
          </select>
        </label>

        <div class="row-2">
          <label class="field">
            <span>温度</span>
            <input v-model.number="temperature" type="number" step="0.1" min="0" max="2" />
          </label>
          <label class="field">
            <span>单次运行最大工具轮数</span>
            <input v-model.number="maxRounds" type="number" min="1" max="40" />
          </label>
        </div>
        <label class="field">
          <span>单次回复最大 token（0 = 不限）</span>
          <input v-model.number="maxTokens" type="number" min="0" max="32000" />
        </label>
        <label class="field">
          <span>思考强度</span>
          <select v-model="thinkingSel">
            <option value="off">关（不思考，明确关闭）</option>
            <option value="">默认（跟随模型/网关）</option>
            <option value="on-noeffort">开（明确开启，不指定强度）</option>
            <option value="low">低（快、省 token）</option>
            <option value="medium">中</option>
            <option value="high">高（慢、细致）</option>
            <option value="xhigh">超高（更慢、更深入）</option>
            <option value="max">拉满（最强推理）</option>
          </select>
          <p class="hint">内置落成各厂商思考参数（off~max 六档）；渠道不支持高档时向下就近映射。</p>
        </label>

        <div class="sub-block">
          <h3 class="sub-title">备选模型（故障自动降级 · 主模型失败后按顺序重试 · 留空不启用）</h3>
          <div v-for="(row, i) in fallbackRows" :key="i" class="fb-row">
            <select v-model="row.provider" class="fb-provider">
              <option value="">（提供商留空 = 沿用主模型）</option>
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.displayName || p.id }}</option>
            </select>
            <select v-model="row.model" class="fb-model">
              <option value="">（空行 = 不启用）</option>
              <template v-if="row.provider">
                <option v-for="m in (providers.find((p) => p.id === row.provider)?.models || [])" :key="m" :value="m">
                  {{ (providers.find((p) => p.id === row.provider)?.modelNames || {})[m] || m }}
                </option>
              </template>
              <template v-else>
                <option v-for="o in fallbackOptions" :key="o.value" :value="o.value.split('|||')[1]">
                  {{ o.group }} · {{ o.label }}
                </option>
              </template>
            </select>
            <button class="btn btn-sm btn-danger" :disabled="fallbackRows.length <= 1" @click="fallbackRows.splice(i, 1)">删除</button>
          </div>
          <div class="actions">
            <button class="btn" @click="fallbackRows.push({ model: '', provider: '' })">＋ 添加备选模型</button>
            <span class="hint">选中模型行会自动带上所属提供商（备选可跨渠道）。</span>
          </div>
        </div>

        <div class="sub-block">
          <h3 class="sub-title">成本核算</h3>
          <label class="check-row">
            <input v-model="useOfficialPrice" type="checkbox" />
            <span>用内置官方价格表估算（按模型 id 自动匹配；走中转站请关掉）</span>
          </label>
          <p class="pc-model">当前模型单价：<b>{{ selModel || '（未选择模型）' }}</b></p>
          <div class="row-3">
            <label class="field">
              <span>输入（元/百万）</span>
              <input v-model.number="priceIn" type="number" step="0.01" min="0" :disabled="priceCard.locked" />
            </label>
            <label class="field">
              <span>输出（元/百万）</span>
              <input v-model.number="priceOut" type="number" step="0.01" min="0" :disabled="priceCard.locked" />
            </label>
            <label class="field">
              <span>缓存命中（元/百万）</span>
              <input v-model.number="priceCached" type="number" step="0.01" min="0" :disabled="priceCard.locked" />
            </label>
          </div>
          <p v-if="priceCard.note" class="hint">{{ priceCard.note }}</p>
          <details class="fold">
            <summary>批量自定义价格编辑（目录全量模型；留空 = 不自定义，走官方表/兜底）</summary>
            <table class="price-table">
              <thead>
                <tr><th>模型</th><th>输入</th><th>输出</th><th>缓存命中</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="m in catalogModels" :key="m">
                  <td class="mono">{{ m }}</td>
                  <td><input v-model.number="priceEdits[m]!.in" type="number" step="0.01" min="0" :placeholder="String(matchPriceTable(m, officialPrices)?.in ?? 0)" /></td>
                  <td><input v-model.number="priceEdits[m]!.out" type="number" step="0.01" min="0" :placeholder="String(matchPriceTable(m, officialPrices)?.out ?? 0)" /></td>
                  <td><input v-model.number="priceEdits[m]!.cached" type="number" step="0.01" min="0" :placeholder="String(matchPriceTable(m, officialPrices)?.cached ?? 0)" /></td>
                  <td><button class="btn btn-sm" title="清除该模型的自定义价" @click="clearPriceEdit(m)">清除</button></td>
                </tr>
              </tbody>
            </table>
            <p class="hint">占位符为官方价参考；修改只写入你的配置（api.modelPrices），不会改动官方价格表。整行留空保存 = 删除该条目（回落官方表）。</p>
            <div class="actions">
              <button class="btn btn-accent btn-sm" :disabled="saving.batchprice" @click="saveBatchPrices">保存批量单价</button>
              <span v-if="notes.batchprice" class="hint-text">{{ notes.batchprice }}</span>
            </div>
          </details>
        </div>

        <details class="fold">
          <summary>模型管理（提供商目录增删 / 模型增删 / 每家 Key）</summary>
          <div class="mg-toolbar">
            <select v-model="managePid" class="mg-pid">
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.displayName || p.id }}</option>
            </select>
            <button class="btn btn-sm" @click="addProvOpen = !addProvOpen">＋ 添加提供商</button>
            <button class="btn btn-sm btn-danger" @click="removeProvider">删除提供商</button>
          </div>
          <div v-if="addProvOpen" class="mg-form">
            <label class="field"><span>Base URL</span>
              <input v-model="addProvBaseUrl" type="text" placeholder="例如 https://api.deepseek.com/v1" /></label>
            <label class="field"><span>API Key</span>
              <input v-model="addProvApiKey" type="password" autocomplete="new-password" placeholder="sk-..." /></label>
            <div class="field"><span>模型 id（至少一个；也可先添加再拉取）</span>
              <div v-for="(row, i) in addProvRows" :key="i" class="fb-row">
                <input v-model="row.id" type="text" placeholder="如 glm-5.3-flash" class="fb-provider" />
                <input v-model="row.name" type="text" placeholder="显示名（可选）" class="fb-model" />
                <button class="btn btn-sm btn-danger" :disabled="addProvRows.length <= 1" @click="removeProvRow(i)">删除</button>
              </div>
              <div class="actions"><button class="btn btn-sm" @click="addProvRow">＋ 添加一行</button></div>
            </div>
            <div class="actions"><button class="btn btn-accent btn-sm" :disabled="saving.manage" @click="saveNewProvider">添加提供商</button></div>
          </div>
          <div v-if="curProvider" class="mg-form">
            <p class="hint">选中：{{ curProvider.displayName || curProvider.id }} @ {{ curProvider.baseURL }}</p>
            <div class="field"><span>显示名（用来区分本机两个地址）</span>
              <div class="fb-row">
                <input v-model="manageName" type="text" placeholder="例如：本机 1234 / 本机 7864" class="fb-model" />
                <button class="btn btn-sm" :disabled="saving.manage" @click="saveProviderName">保存名称</button>
              </div>
            </div>
            <div class="field"><span>该提供商 API Key{{ curProvider.hasKey ? '（已保存）' : '（未保存）' }}</span>
              <div class="fb-row">
                <input v-model="manageKeyInput" :type="manageShowKey ? 'text' : 'password'" :placeholder="curProvider.hasKey ? '******' : '（未保存）'" autocomplete="new-password" class="fb-model" />
                <button class="btn btn-sm" @click="manageShowKey ? hideManageKey() : showManageKey()">{{ manageShowKey ? '隐藏' : '显示' }}</button>
                <button class="btn btn-sm btn-danger" :disabled="!curProvider.hasKey" @click="clearManageKey">清除密钥</button>
              </div>
            </div>
            <div class="actions">
              <button class="btn btn-sm" :disabled="saving.manage" @click="pullModels">拉取模型列表</button>
              <span class="hint">模型（{{ (curProvider.models || []).length }} 个）：</span>
            </div>
            <div class="mg-models">
              <div v-for="m in curProvider.models" :key="m" class="mg-model-row">
                <span class="mono">{{ m }}</span>
                <span class="hint">{{ (curProvider.modelNames || {})[m] && (curProvider.modelNames || {})[m] !== m ? (curProvider.modelNames || {})[m] : '' }}</span>
                <button class="btn btn-sm btn-danger" @click="removeModel(curProvider!.id as string, m)">删除</button>
              </div>
              <p v-if="!(curProvider.models || []).length" class="hint">该提供商下没有模型：手动添加或拉取。</p>
            </div>
            <div class="fb-row">
              <input v-model="manualModelId" type="text" placeholder="手动添加模型 id（如 deepseek-chat）" class="fb-provider" />
              <input v-model="manualModelName" type="text" placeholder="显示名（可选）" class="fb-model" />
              <button class="btn btn-sm" :disabled="saving.manage || !manualModelId.trim()" @click="saveManualModel">添加</button>
            </div>
            <div v-if="fetchedModels.length" class="mg-form">
              <span class="field-label">勾选要加入列表的模型：</span>
              <label v-for="m in fetchedModels" :key="m" class="check-row">
                <input v-model="fetchedPicked[m]" type="checkbox" />
                <span class="mono">{{ m }}</span>
              </label>
              <div class="actions">
                <button class="btn btn-accent btn-sm" :disabled="saving.manage" @click="addPulledModels">加入勾选项</button>
              </div>
            </div>
          </div>
          <p v-else class="hint">还没有提供商：先「＋ 添加提供商」，或直接用上方 Base URL + API Key 直连。</p>
          <span v-if="notes.manage" class="hint-text">{{ notes.manage }}</span>
        </details>

        <!-- （分区保存按钮已收拢为页头「保存全部」· 2026-11-21） -->
      </div>
    </section>

    <!-- ═══ 分区 2 · 搜索服务 ═══ -->
    <section id="sec-search" class="card block">
      <h2 class="section-title">搜索服务</h2>
      <div class="fields">
        <label class="check-row">
          <input v-model="wsEnabled" type="checkbox" />
          <span>联网搜索：启用 web_search / web_fetch 工具</span>
        </label>
        <label class="field">
          <span>搜索提供方</span>
          <select v-model="wsProvider">
            <option value="bing">Bing 网页解析（无需 API Key）</option>
            <option value="deepseek">DeepSeek 原生搜索</option>
            <option value="zhipu">智谱 Web Search</option>
            <option value="bocha">博查 AI Search</option>
            <option value="baidu">百度千帆 AI Search</option>
            <option value="metaso">秘塔 AI 搜索</option>
            <option v-for="p in searchProviders" :key="p.id" :value="`custom:${p.id}`">
              {{ p.name || p.baseUrl }}（自定义 · {{ p.type === 'bing' ? '网页解析' : 'JSON 接口' }}）
            </option>
          </select>
          <p v-if="selCustomProvider" class="hint">
            当前：{{ selCustomProvider.name || selCustomProvider.baseUrl }} ·
            {{ selCustomProvider.hasApiKey ? '已保存 API Key（不显示）' : '未保存 API Key' }}
          </p>
        </label>

        <div v-if="wsProvider === 'bing'" class="field">
          <label class="field"><span>搜索地址（高级：可替换为兼容 Bing 结果格式的引擎）</span>
            <input v-model="wsSearchUrl" type="text" /></label>
        </div>

        <div v-if="wsProvider === 'deepseek'" class="row-2">
          <label class="field">
            <span>DeepSeek 搜索 API Key（留空用环境变量 DEEPSEEK_API_KEY）</span>
            <input v-model="dsKeyInput" type="password" autocomplete="new-password" placeholder="输入新 Key 可替换；留空保持不变" />
          </label>
          <label class="field"><span>模型</span>
            <input v-model="dsModel" type="text" /></label>
        </div>
        <div v-if="wsProvider === 'deepseek'" class="actions">
          <button class="btn btn-sm" @click="revealSearchKey('deepseek')">显示已存 Key</button>
          <button class="btn btn-sm btn-danger" @click="clearSearchKey('deepseek')">清除密钥</button>
        </div>

        <div v-if="wsProvider === 'zhipu'" class="row-2">
          <label class="field">
            <span>智谱 API Key（留空用环境变量 ZHIPU_API_KEY）</span>
            <input v-model="zhipuKeyInput" type="password" autocomplete="new-password" placeholder="输入新 Key 可替换；留空保持不变" />
          </label>
          <label class="field"><span>搜索引擎</span>
            <select v-model="zhipuEngine">
              <option value="search_std">基础版 ¥0.01/次</option>
              <option value="search_pro">高级版 ¥0.03/次</option>
              <option value="search_pro_sogou">搜狗版 ¥0.05/次</option>
              <option value="search_pro_quark">夸克版 ¥0.05/次</option>
            </select></label>
        </div>
        <div v-if="wsProvider === 'zhipu'" class="actions">
          <button class="btn btn-sm" @click="revealSearchKey('zhipu')">显示已存 Key</button>
          <button class="btn btn-sm btn-danger" @click="clearSearchKey('zhipu')">清除密钥</button>
        </div>

        <template v-if="wsProvider === 'bocha'">
          <label class="field">
            <span>博查 API Key</span>
            <input v-model="bochaKeyInput" type="password" autocomplete="new-password" placeholder="输入新 Key 可替换；留空保持不变" />
          </label>
          <div class="actions">
            <button class="btn btn-sm" @click="revealSearchKey('bocha')">显示已存 Key</button>
            <button class="btn btn-sm btn-danger" @click="clearSearchKey('bocha')">清除密钥</button>
          </div>
        </template>

        <template v-if="wsProvider === 'baidu'">
          <label class="field">
            <span>百度千帆 API Key（留空用环境变量 BAIDU_SEARCH_API_KEY）</span>
            <input v-model="baiduKeyInput" type="password" autocomplete="new-password" placeholder="输入新 Key 可替换；留空保持不变" />
          </label>
          <div class="actions">
            <button class="btn btn-sm" @click="revealSearchKey('baidu')">显示已存 Key</button>
            <button class="btn btn-sm btn-danger" @click="clearSearchKey('baidu')">清除密钥</button>
          </div>
        </template>

        <template v-if="wsProvider === 'metaso'">
          <label class="field">
            <span>秘塔 API Key（可选，留空用官方免费额度 / 环境变量 METASO_API_KEY）</span>
            <input v-model="metasoKeyInput" type="password" autocomplete="new-password" placeholder="输入新 Key 可替换；留空保持不变" />
          </label>
          <div class="actions">
            <button class="btn btn-sm" @click="revealSearchKey('metaso')">显示已存 Key</button>
            <button class="btn btn-sm btn-danger" @click="clearSearchKey('metaso')">清除密钥</button>
          </div>
        </template>

        <div v-if="selCustomProvider" class="sub-block">
          <h3 class="sub-title">管理这个自定义搜索服务</h3>
          <label class="field">
            <span>API Key{{ selCustomProvider.hasApiKey ? '（已保存，可查看/替换/清除）' : '（未保存；多数自建服务留空即可）' }}</span>
            <input v-model="customKeyInput" type="password" autocomplete="new-password" placeholder="输入新 Key 可替换；留空保持不变" />
          </label>
          <div class="actions">
            <button class="btn btn-sm" @click="revealSearchKey('custom')">显示</button>
            <button class="btn btn-sm btn-danger" @click="clearSearchKey('custom')">清除密钥</button>
            <button class="btn btn-sm" @click="testCurrentSearchProvider">测试这个搜索服务</button>
            <button class="btn btn-sm btn-danger" @click="deleteCurrentSearchProvider">删除这个搜索服务</button>
            <span v-if="searchTestHint" class="hint-text">{{ searchTestHint }}</span>
          </div>
        </div>

        <div class="sub-block">
          <h3 class="sub-title">添加自定义搜索服务</h3>
          <div class="row-2">
            <label class="field"><span>名称（自己辨认用）</span>
              <input v-model="newSp.name" type="text" placeholder="例如：自建 SearXNG" /></label>
            <label class="field"><span>类型</span>
              <select v-model="newSp.type">
                <option value="openai">JSON 搜索接口（POST）</option>
                <option value="bing">网页解析（Bing 结果格式）</option>
              </select></label>
          </div>
          <label class="field"><span>接口地址 / 搜索页地址</span>
            <input v-model="newSp.baseUrl" type="text" placeholder="JSON 类型：https://your-search.example.com/search；网页类型：https://your-searx.example.com/search" /></label>
          <div class="row-2">
            <label class="field"><span>API Key（可选）</span>
              <input v-model="newSp.apiKey" type="password" autocomplete="new-password" placeholder="多数自建服务留空即可" /></label>
            <label class="field"><span>模型名（可选）</span>
              <input v-model="newSp.model" type="text" placeholder="Responses API 风格才需要" /></label>
          </div>
          <div class="actions">
            <button class="btn" :disabled="saving.addsp" @click="addSearchProvider">＋ 添加并选中</button>
            <span v-if="notes.addsp" class="hint-text">{{ notes.addsp }}</span>
          </div>
        </div>

        <!-- （分区保存按钮已收拢为页头「保存全部」） -->
        <p class="hint">Key 保存语义：输入框留空 = 保持已存 Key 不变；真清除必须点「清除密钥」。</p>
      </div>
    </section>

    <!-- ═══ 分区 3 · 记忆整理 ═══ -->
    <section id="sec-memory" class="card block">
      <h2 class="section-title">心智机制（记忆 / 召回 / 生活 / 跨轮思考）</h2>
      <div class="fields">
        <label class="check-row">
          <input v-model="memConsolidate" type="checkbox" />
          <span>启用记忆自动整理</span>
        </label>
        <label class="check-row">
          <input v-model="memUseChat" type="checkbox" />
          <span>使用与聊天机器人相同的模型</span>
        </label>
        <div v-if="!memUseChat" class="row-2">
          <label class="field">
            <span>记忆整理提供商</span>
            <select v-model="memProvider">
              <option value="">（未选择）</option>
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.displayName || p.id }}</option>
            </select>
          </label>
          <label class="field">
            <span>记忆整理模型</span>
            <select v-model="memModel">
              <option value="">（未选择）</option>
              <option v-for="m in (providers.find((p) => p.id === memProvider)?.models || [])" :key="m" :value="m">
                {{ (providers.find((p) => p.id === memProvider)?.modelNames || {})[m] || m }}
              </option>
            </select>
          </label>
        </div>
        <label class="field">
          <span>整理冷却时间（毫秒）</span>
          <input v-model.number="memInterval" type="number" min="1800000" step="600000" />
          <p class="hint">条数超过阈值且距上次整理超过该冷却时间后，才会在运行结束后后台整理。默认 6 小时（21600000 毫秒）。</p>
        </label>
        <label class="field">
          <span>记忆整理的模型来源</span>
          <select v-model="writerMode">
            <option value="fixture">开发模式 · 不调真实模型（零成本）</option>
            <option value="model">真实模型 · 走聊天 API（整理时产生用量与成本）</option>
          </select>
        </label>
        <h3 class="sub-title">向量召回</h3>
        <label class="check-row">
          <input v-model="embEnabled" type="checkbox" />
          <span>启用向量召回</span>
        </label>
        <p class="hint">开启后每轮对话预取向量命中，命中即注入【近期回忆】（带「仅供参考」标注）；关闭 = 零调用。</p>
        <div class="row-2">
          <label class="field">
            <span>嵌入服务 id</span>
            <input v-model="embProvider" type="text" placeholder="如 custom_mvgbzl9p8rb0（模型服务里的条目）" />
          </label>
          <label class="field">
            <span>嵌入模型</span>
            <input v-model="embModel" type="text" placeholder="如 text-embedding-qwen3-embedding-0.6b" />
          </label>
        </div>
        <p class="hint">服务 id 留空 = 嵌入调用直 null，绝不回落主聊天模型；换嵌入模型后需重建向量索引。</p>
        <details class="fold">
          <summary>向量调参（融合权重 / 召回阈值 · 一般不用动）</summary>
          <label class="field">
            <span>query 侧指令前缀</span>
            <textarea v-model="embQueryInstruction" rows="3"></textarea>
            <p class="hint">只作用 query 侧（document 侧必须原文）；由嵌入调用方在应用侧拼接。</p>
          </label>
          <label class="field">
            <span>注入闸门模式</span>
            <select v-model="embGateMode">
              <option value="always">always · 命中即注入（缺省）</option>
              <option value="strict">strict · 旧三闸门（冷启动/线索词/人名命中才注入）</option>
            </select>
          </label>
          <div class="row-2">
            <label class="field">
              <span>融合路权重 lexical / vector</span>
              <div class="row-2">
                <input v-model.number="embFuseLexical" type="number" min="0" step="0.5" />
                <input v-model.number="embFuseVector" type="number" min="0" step="0.5" />
              </div>
            </label>
            <label class="field">
              <span>row / gist / fact 权重</span>
              <div class="row-3">
                <input v-model.number="embFuseRow" type="number" min="0" step="0.5" />
                <input v-model.number="embFuseGist" type="number" min="0" step="0.5" />
                <input v-model.number="embFuseFact" type="number" min="0" step="0.5" />
              </div>
            </label>
          </div>
          <p class="hint">RRF 融合五路权重（0=关闭该路）；row 缺省独立，gist/fact 缺省回落 vector。</p>
          <label class="field">
            <span>向量相关度下限</span>
            <input v-model.number="embVectorFloor" type="number" min="0" max="1" step="0.05" />
            <p class="hint">cosine 低于该值的向量行不入候选（缺省 0.45；换嵌入模型需重测）。</p>
          </label>
          <div class="row-2">
            <label class="field">
              <span>行级向量下限</span>
              <input v-model.number="embRowFloor" type="number" min="0" max="1" step="0.05" />
            </label>
            <label class="field">
              <span>词法最低分</span>
              <input v-model.number="embLexicalFloor" type="number" min="0" step="0.5" />
              <p class="hint">词法召回的最低重叠分（缺省 2；越大越少提旧事）。</p>
            </label>
          </div>
        </details>

        <div class="sub-block">
          <h3 class="sub-title">她的生活与跨轮思考</h3>
          <label class="check-row">
            <input v-model="lifeEnabled" type="checkbox" />
            <span>启用她的生活（关闭 = 不生成日程，右栏今日段显示"未开启"）</span>
          </label>
          <label class="field">
            <span>聊天侧日程注入</span>
            <select v-model="lifePromptMode">
              <option value="off">不注入（推荐）</option>
              <option value="prose">注入今日日程散文</option>
            </select>
            <p class="hint">只决定聊天提示词里是否出现【今日日程】；日程本身的生成由上面的开关控制。</p>
          </label>
          <label class="check-row">
            <input v-model="transitionEnabled" type="checkbox" />
            <span>跨轮思考注入</span>
          </label>
          <p class="hint">读取上一条已结束会话的【深度思考】注入本轮；超时或超长不注入。</p>
          <details class="fold">
            <summary>跨轮思考调参（有效期 / 长度上限）</summary>
            <div class="row-2">
              <label class="field"><span>有效期（分钟）</span><input v-model.number="transitionTtlMin" type="number" min="5" step="5" /></label>
              <label class="field"><span>注入上限（字）</span><input v-model.number="transitionMaxChars" type="number" min="120" step="50" /></label>
            </div>
          </details>
        </div>

        <!-- （分区保存按钮已收拢为页头「保存全部」） -->
      </div>
    </section>

    <!-- ═══ 分区 4 · 人设 ═══ -->
    <section id="sec-persona" class="card block">
      <h2 class="section-title">人设</h2>
      <div class="fields">
        <!-- （统一人设开关与分会话人设展示已随 2026-11-21 所有者指令删除——
             单用户自用无分会话配置；遗留配置键已随 2026-11-22 清理移除。） -->

        <label class="field">
          <span>选择人设（内置 + 自定义模板）</span>
          <select v-model="personaPickId" @change="pickPersonaTemplate">
            <option value="">（不套模板 · 直接编辑下方文本）</option>
            <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}{{ t.builtin ? '（内置）' : '（自定义）' }}</option>
          </select>
          <p class="hint">选了自定义模板后直接改下方文本，保存 = 写回该模板本身（热改：下次加载同一模板就是改过的版本）；内置模板不回写。</p>
          <div class="actions">
            <button class="btn btn-sm" @click="personaAddOpen = !personaAddOpen">＋ 添加人设</button>
            <button
              v-if="curPersonaTemplate?.id?.startsWith('custom_')"
              class="btn btn-sm btn-danger"
              :disabled="saving.persona"
              @click="removeCurPersona"
            >
              删除当前自定义人设
            </button>
          </div>
        </label>

        <div v-if="personaAddOpen" class="sub-block">
          <h3 class="sub-title">添加自定义人设</h3>
          <label class="field"><span>名称</span>
            <input v-model="personaAddName" type="text" placeholder="例如：温柔学姐" /></label>
          <label class="field"><span>角色设定</span>
            <textarea v-model="personaAddText" class="ta-mid" placeholder="例如：你是那个爱吐槽、说话很短的蓝色小鱼……"></textarea></label>
          <label class="field"><span>管理员附加规则（可选）</span>
            <textarea v-model="personaAddRules" class="ta-mid"></textarea></label>
          <div class="actions">
            <button class="btn btn-accent btn-sm" :disabled="saving.persona" @click="savePersonaAdd">保存模板</button>
          </div>
        </div>

        <div class="row-2">
          <label class="field"><span>TA 的名字（右栏 / 通话 / PWA 顶栏都用它指代）</span>
            <input v-model="botName" type="text" placeholder="汐" /></label>
          <label class="field"><span>昵称展示名（可选）</span>
            <input v-model="selfNickname" type="text" /></label>
        </div>
        <label class="field">
          <span>对方称呼（ownerLabel · 提示词里怎么称呼主人）</span>
          <input v-model="ownerLabel" type="text" placeholder="对方" />
          <p class="hint">
            默认“对方”。单用户不需要区分多个人；未来多平台可写 `对方({surface})`，web 会渲染成“对方(web)”。
            这里不写死任何个人名字，开源时保持默认即可。
          </p>
        </label>
        <label class="field">
          <span>角色设定（大文本 · 全高编辑）</span>
          <textarea v-model="roleText" class="ta-role" placeholder="例如：你是那个爱吐槽、说话很短的蓝色小鱼……"></textarea>
        </label>
        <label class="field">
          <span>管理员附加规则（可选，追加到系统提示）</span>
          <textarea v-model="customRules" class="ta-mid"></textarea>
        </label>
        <label class="field">
          <span>系统提示词覆盖（高级 · 可选）</span>
          <textarea v-model="sysPromptOverride" class="ta-mid" placeholder="留空 = 使用内置默认系统提示词。填写后将整体替换默认行为准则（工具协议仍由核心追加）。"></textarea>
          <p class="hint">
            ⚠️ 高级功能：填写后会整体替换内置的行为准则；工具协议由核心追加，不会随覆盖消失。
            可用占位符：{botName} {roleText}。留空则完全不影响现有行为。
          </p>
        </label>

        <details class="fold">
          <summary>查看当前系统提示词（只读 · 实际生效的组装结果）</summary>
          <div class="actions">
            <button class="btn btn-sm" :disabled="sysPromptLoading" @click="loadSystemPrompt">
              {{ sysPromptLoading ? '生成中…' : '重新生成' }}
            </button>
            <span class="hint">系统提示词（行为准则+工具协议）的完整组装结果；角色设定/记忆/已读属于对话输入侧，不在其中。修改走上方「角色设定」或「系统提示词覆盖」，此处仅查看。</span>
          </div>
          <pre v-if="sysPromptPreview" class="sys-prompt-view">{{ sysPromptPreview }}</pre>
          <p v-else class="hint">点「重新生成」拉取当前渲染结果。</p>
        </details>

        <!-- （分会话独立人设展示已随 2026-11-21 所有者指令删除。） -->

        <!-- （分区保存按钮已收拢为页头「保存全部」） -->
      </div>
    </section>

    <!-- ═══ 分区 5 · 聊天白名单 ═══ -->
    <!-- ═══ （聊天白名单分区已随 2026-11-21 所有者指令删除——单用户自用无多对象过滤需求；allow/deny 配置键保留，仅 UI 退场） ═══ -->

    <!-- ═══ 分区 6 · 聊天设置 ═══ -->
    <section id="sec-chat" class="card block">
      <h2 class="section-title">聊天设置</h2>
      <div class="fields">
        <details class="fold">
          <summary>处理节奏与并发（一般不用动）</summary>
          <div class="row-2">
            <label class="field">
              <span>防抖聚批窗口（毫秒）</span>
              <input v-model.number="wakeDelayMs" type="number" min="0" />
            </label>
            <label class="field">
              <span>批次间隔（毫秒）</span>
              <input v-model.number="drainDelayMs" type="number" min="0" />
            </label>
          </div>
          <div class="row-2">
            <label class="field">
              <span>同时处理几个会话</span>
              <input v-model.number="maxConcurrentRuns" type="number" min="1" max="8" />
            </label>
            <label class="field">
              <span>失败自动重试次数</span>
              <input v-model.number="sessionRetryAttempts" type="number" min="0" max="5" />
              <p class="hint">0 = 关闭。已发出过消息的会话绝不自动重试。</p>
            </label>
          </div>
        </details>
        <div class="row-2">
          <label class="field">
            <span>相邻消息最小间隔（毫秒）</span>
            <input v-model.number="sendMinGapMs" type="number" min="200" />
          </label>
          <label class="field">
            <span>相邻消息最大间隔（毫秒）</span>
            <input v-model.number="sendMaxGapMs" type="number" min="500" />
          </label>
        </div>
        <div class="row-2">
          <label class="field">
            <span>每分钟最多发送</span>
            <input v-model.number="sendMaxPerMinute" type="number" min="1" />
          </label>
          <label class="field">
            <span>每小时最多发送</span>
            <input v-model.number="sendMaxPerHour" type="number" min="1" />
          </label>
        </div>

        <div class="sub-block">
          <h3 class="sub-title">上下文与提示词锚点</h3>
          <label class="field">
            <span>响应时随【已读信息】带多少条历史</span>
            <input v-model.number="historyCount" type="number" min="1" />
            <p class="hint">所有会话统一条数；调大更连贯但更耗 token。</p>
          </label>
          <details class="fold">
            <summary>提示词锚点（前缀缓存 · 一般不用动）</summary>
            <label class="check-row">
              <input v-model="promptAnchorEnabled" type="checkbox" />
              <span>启用提示词锚点（连续触发时复用上一轮前缀，只追加新条目，省 token）</span>
            </label>
            <label class="field">
              <span>锚点最多额外追加几条已读</span>
              <input v-model.number="promptAnchorMaxExtra" type="number" min="0" />
              <p class="hint">超过该条数就整体重置回标准窗口（无限追加反而更贵）。</p>
            </label>
          </details>
        </div>

        <div class="sub-block">
          <h3 class="sub-title">表情包</h3>
          <label class="check-row">
            <input v-model="stickerEnabled" type="checkbox" />
            <span>启用表情包（收藏表情同步 + 发送工具）</span>
          </label>
          <label class="field">
            <span>发表情包的积极程度</span>
            <select v-model.number="stickerEncourage">
              <option :value="0">0 · 不鼓励（只在很贴切时偶尔用）</option>
              <option :value="1">1 · 偶尔（合适时配一张）</option>
              <option :value="2">2 · 较积极（优先考虑配图）</option>
              <option :value="3">3 · 很积极（表情包爱好者）</option>
            </select>
            <p class="hint">这是「引导」不是「强制」，模型仍会自行判断什么时机合适。</p>
          </label>
          <label class="field">
            <span>提示词里列举的表情包数量（1~50）</span>
            <input v-model.number="stickerPromptMax" type="number" min="1" max="50" />
            <p class="hint">列得越多模型选择越丰富，但 token 成本也越高。</p>
          </label>
        </div>

        <!-- （分区保存按钮已收拢为页头「保存全部」） -->
        <p class="hint">温度 / 工具轮数 / 最大 token / 思考强度在「模型 API」分区保存。</p>
      </div>
    </section>

    <!-- ═══ 分区 7 · 桌面端 ═══ -->
    <section id="sec-desktop" class="card block">
      <h2 class="section-title">桌面端</h2>
      <div class="fields">
        <label class="check-row">
          <input v-model="serverAutoStart" type="checkbox" />
          <span>开机自启（仅桌面端生效）</span>
        </label>
        <label class="check-row">
          <input v-model="serverCloseToTray" type="checkbox" />
          <span>点关闭时最小化到托盘</span>
        </label>
        <label class="field">
          <span>服务端口（只读 · 由 QQ_AGENT_PORT / 多实例 PROFILE 在启动期决定）</span>
          <input :value="serverPort || ''" type="text" readonly />
          <p class="hint">改端口需改启动环境变量后重启应用；此处仅展示当前配置值。</p>
        </label>
        <div class="sub-block">
          <h3 class="sub-title">界面</h3>
          <div class="field">
            <span>她的头像（右栏 / 通话页 / PWA 顶栏同源；未设置 = 内置圆徽章）</span>
            <div class="avatar-row">
              <img class="avatar-preview" :src="avatarSrc" alt="头像预览" width="64" height="64" />
              <div class="avatar-actions">
                <input ref="avatarInput" type="file" accept="image/*" class="visually-hidden-input" @change="uploadAvatar" />
                <button class="btn btn-sm" :disabled="avatarUploading" @click="avatarInput?.click()">
                  {{ avatarUploading ? '上传中…' : '上传头像' }}
                </button>
                <button v-if="avatarTs" class="btn btn-sm btn-danger" :disabled="avatarUploading" @click="resetAvatar">恢复默认</button>
                <span class="hint">png / jpg / webp / gif，≤5MB；显示时按圆裁切。</span>
              </div>
            </div>
            <span v-if="notes.avatar" class="hint-text">{{ notes.avatar }}</span>
          </div>
          <label class="check-row">
            <input v-model="uiShowVision" type="checkbox" />
            <span>模型目录显示「支持图片输入/不支持图片输入」徽标</span>
          </label>
          <label class="field">
            <span>界面刷新间隔（毫秒）</span>
            <input v-model.number="uiRefreshMs" type="number" min="1000" step="1000" />
          </label>
          <p class="hint">主题切换在本页底部「主题」卡（只存本机）。她的名字在「人设」分区（botName）。</p>
        </div>
        <!-- （分区保存按钮已收拢为页头「保存全部」） -->
      </div>
    </section>

    <!-- ═══ 分区 8 · 语音电话（T3 V2 前端 + W3 大扩充：可设项区=voice 全键 +
         信息区=状态卡/立即探测）═══ -->
    <section id="sec-voice" class="card block">
      <h2 class="section-title">语音电话</h2>
      <div class="fields">
        <!-- W1 快捷开关（顶部两组，保留原位）：即时保存 + 本地引擎联动（开=拉起+预热，结果见下方徽标行） -->
        <label class="check-row">
          <input v-model="voiceEnabled" type="checkbox" />
          <span>启用语音能力（关闭 = 语音完全停用，零调用）</span>
        </label>
        <label class="check-row">
          <input v-model="voiceCallEnabled" type="checkbox" />
          <span>启用通话模式（关闭 = 对话页不显示电话入口）</span>
        </label>
        <label class="check-row">
          <input v-model="voiceTtsEnabled" type="checkbox" @change="toggleVoiceEngine('tts')" />
          <span>语音回复 TTS · 即时保存（开启 = 拉起本地引擎并预热）</span>
        </label>
        <label class="check-row">
          <input v-model="voiceAsrEnabled" type="checkbox" @change="toggleVoiceEngine('asr')" />
          <span>语音识别 ASR · 即时保存（开启 = 拉起本地识别引擎）</span>
        </label>
        <details class="fold">
          <summary>引擎策略（运行方式 · 一般不用动）</summary>
          <label class="field">
            <span>引擎运行策略</span>
            <select v-model="voiceEngineManage">
              <option value="auto">auto · 呼叫中允许自动拉起/预热引擎</option>
              <option value="manual">manual · 只探测不拉起（引擎需手动启动）</option>
            </select>
          </label>
          <label class="check-row">
            <input v-model="voiceGpuAllow" type="checkbox" />
            <span>允许使用 GPU 引擎</span>
          </label>
        </details>

        <!-- W3 可设项区 · ASR 组 -->
        <p class="voice-group-head">ASR 语音识别</p>
        <label class="field">
          <span>引擎（off = 关；可填引擎名或方言名 gpu-local / deepseek-tools / openai-compat）</span>
          <input v-model="asrEngine" type="text" placeholder="off" />
        </label>
        <label class="field">
          <span>协议方言（留空 = 跟随引擎名派生）</span>
          <select v-model="asrDialect">
            <option value="">（跟随引擎名派生）</option>
            <option value="gpu-local">gpu-local · 本地 whisper.cpp</option>
            <option value="deepseek-tools">deepseek-tools · 云端（multipart）</option>
            <option value="openai-compat">openai-compat · 标准 /v1/audio/transcriptions</option>
          </select>
        </label>
        <label class="field">
          <span>接口地址（空 = 引擎不可用，绝不回落主聊天模型）</span>
          <input v-model="asrBaseUrl" type="text" placeholder="http://127.0.0.1:8178" />
        </label>
        <div class="field">
          <span>API Key（云端方言用，仅存本机配置；本地引擎可忽略）</span>
          <div class="api-key-row">
            <input
              v-model="asrApiKey"
              type="password"
              autocomplete="new-password"
              :placeholder="asrHasApiKey ? '已配置（输入新值覆盖，留空不动）' : '未配置（粘贴密钥，本地引擎可忽略）'"
            />
            <button v-if="asrHasApiKey" class="btn btn-sm" :disabled="saving.voice" @click="clearVoiceApiKey('asr')">清除</button>
          </div>
        </div>
        <div class="row-2">
          <label class="field">
            <span>模型名（本地引擎仅登记，云端方言随请求发送）</span>
            <input v-model="asrModel" type="text" placeholder="large-v3-turbo" />
          </label>
          <label class="field">
            <span>识别语言（缺省 zh）</span>
            <input v-model="asrLanguage" type="text" placeholder="zh" />
          </label>
        </div>
        <label class="field">
          <span>转写超时（毫秒）</span>
          <input v-model="asrTimeoutMs" type="number" min="1000" step="500" />
        </label>

        <!-- W3 可设项区 · TTS 组 -->
        <p class="voice-group-head">TTS 语音合成（合成参数为听感冻结组，语速不开放调整）</p>
        <label class="field">
          <span>引擎（off = 关；可填引擎名或方言名，同 ASR）</span>
          <input v-model="ttsEngine" type="text" placeholder="off" />
        </label>
        <label class="field">
          <span>协议方言（留空 = 跟随引擎名派生）</span>
          <select v-model="ttsDialect">
            <option value="">（跟随引擎名派生）</option>
            <option value="gpu-local">gpu-local · 本地 GPT-SoVITS</option>
            <option value="deepseek-tools">deepseek-tools · 云端（裸 PCM 流）</option>
            <option value="openai-compat">openai-compat · 标准 /v1/audio/speech</option>
          </select>
        </label>
        <label class="field">
          <span>接口地址（空 = 引擎不可用）</span>
          <input v-model="ttsBaseUrl" type="text" placeholder="http://127.0.0.1:9880" />
        </label>
        <div class="field">
          <span>API Key（云端方言用，仅存本机配置；本地引擎可忽略）</span>
          <div class="api-key-row">
            <input
              v-model="ttsApiKey"
              type="password"
              autocomplete="new-password"
              :placeholder="ttsHasApiKey ? '已配置（输入新值覆盖，留空不动）' : '未配置（粘贴密钥，本地引擎可忽略）'"
            />
            <button v-if="ttsHasApiKey" class="btn btn-sm" :disabled="saving.voice" @click="clearVoiceApiKey('tts')">清除</button>
          </div>
        </div>
        <div class="row-2">
          <label class="field">
            <span>模型名（仅 openai 兼容方言消费）</span>
            <input v-model="ttsModel" type="text" placeholder="（空 = 请求不带 model 字段）" />
          </label>
          <label class="field">
            <span>音色（deepseek 协议 stella / tide）</span>
            <input v-model="ttsVoiceId" type="text" placeholder="stella" />
          </label>
        </div>
        <details class="fold">
          <summary>合成与编码参数（一般不用动）</summary>
          <label class="field">
            <span>参考音频登记（仅登记不消费——本地合成参数是听感冻结整组，单独换参考音频会错位配对）</span>
            <input v-model="ttsRefVoice" type="text" placeholder="（仅登记）" />
          </label>
          <label class="check-row">
            <input v-model="ttsFilterMarkdown" type="checkbox" />
            <span>过滤 Markdown（服务端过滤代码块/表格/引用标记，缺省开）</span>
          </label>
          <label class="field">
            <span>编码档位</span>
            <select v-model="ttsFormat">
              <option value="ogg">ogg · Opus 落档定稿档（体积 21×）</option>
              <option value="wav">wav · 无损（仅排障用）</option>
              <option value="pcm">pcm · 仅流式方言有义</option>
            </select>
          </label>
          <div class="row-2">
            <label class="field">
              <span>PCM 采样率（Hz，缺省 24000 勿改）</span>
              <input v-model="ttsSampleRate" type="number" min="8000" step="1000" />
            </label>
            <label class="field">
              <span>Opus 码率（kbps，缺省 24 = 听感定稿值）</span>
              <input v-model="ttsBitrateKbps" type="number" min="8" max="64" step="4" />
            </label>
          </div>
          <label class="field">
            <span>合成超时（毫秒，缺省 5000；首调含编译预热 ≈6s 属预期）</span>
            <input v-model="ttsTimeoutMs" type="number" min="1000" step="500" />
          </label>
        </details>

        <!-- W3 可设项区 · 通话参数组（call.* 全参数） -->
        <p class="voice-group-head">通话参数（保存即时生效，下一通起读新值）</p>
        <details class="fold">
          <summary>通话手感调参（一般不用动）</summary>
          <label class="field">
            <span>尾点静音阈值（毫秒，缺省 300——句内自然停顿勿低于 300，防误切两半）</span>
            <input v-model="callSilenceMs" type="number" min="100" step="50" />
          </label>
          <div class="row-2">
            <label class="field">
              <span>最短发言（毫秒，缺省 300——短于此收音丢弃，滤杂音）</span>
              <input v-model="callMinUtteranceMs" type="number" min="100" step="50" />
            </label>
            <label class="field">
              <span>最长发言（毫秒，缺省 60000——超时强制截断）</span>
              <input v-model="callMaxUtteranceMs" type="number" min="1000" step="1000" />
            </label>
          </div>
          <div class="row-2">
            <label class="field">
              <span>首句字数上限（缺省 15——开场白短句优先）</span>
              <input v-model="callFirstSentenceMaxChars" type="number" min="1" step="1" />
            </label>
            <label class="field">
              <span>每轮句数上限（缺省 4）</span>
              <input v-model="callMaxSentences" type="number" min="1" step="1" />
            </label>
          </div>
          <div class="row-2">
            <label class="field">
              <span>通话提示词预算（字符，缺省 3000）</span>
              <input v-model="callPromptBudget" type="number" min="0" step="100" />
            </label>
            <label class="field">
              <span>通话历史轮数（缺省 8）</span>
              <input v-model="callHistoryTurns" type="number" min="0" step="1" />
            </label>
          </div>
          <label class="field">
            <span>回想冷却（秒，缺省 120——两通电话间最小间隔）</span>
            <input v-model="callRecallMinSeconds" type="number" min="0" step="10" />
          </label>
        </details>
        <label class="check-row">
          <input v-model="callRecall" type="checkbox" />
          <span>挂断回想（关闭 = 整通电话不落回想行）</span>
        </label>
        <label class="check-row">
          <input v-model="callKeepAudio" type="checkbox" />
          <span>通话音频存档（缺省关——开启后通话留档可回听）</span>
        </label>
        <div class="field">
          <span>免打扰时段（该时段她不主动来电）</span>
          <div class="api-key-row">
            <input v-model="callDndStart" type="text" placeholder="23:30" />
            <input v-model="callDndEnd" type="text" placeholder="08:00" />
          </div>
        </div>

        <!-- （分区保存按钮已收拢为页头「保存全部」） -->
        <p class="hint">所有设置即时生效，无需重启。API Key 仅存本机配置、不回显——输入新值覆盖、留空不动，「清除」显式置空。</p>

        <!-- W3 信息区 · 引擎状态卡（GET /api/voice/status 只读快照 + 立即探测） -->
        <div class="voice-status">
          <div class="voice-status-head">
            <span class="voice-status-title">引擎状态</span>
            <div class="voice-status-actions">
              <button class="btn btn-sm" :disabled="saving.voiceLaunch" @click="launchVoiceEngines">
                {{ saving.voiceLaunch ? '拉起中…' : '拉起本地引擎' }}
              </button>
              <button class="btn btn-sm" :disabled="saving.voiceProbe" @click="refreshVoiceStatus(true)">
                {{ saving.voiceProbe ? '探测中…' : '立即探测' }}
              </button>
            </div>
          </div>
          <p class="voice-status-extra">
            「拉起本地引擎」按 engine.manage 自动探测/拉起并预热 TTS（首次约 30-60 秒）；「立即探测」只探测、不拉起。
            重开应用后配置仍为开时，点「拉起」即可，不必再取消/重新勾选开关。
          </p>
          <template v-if="voiceStatus">
            <div v-for="row in voiceEnginesView" :key="row.kind" class="voice-status-row">
              <span class="dot" :class="row.on ? 'on' : 'off'"></span>
              <span class="voice-status-kind">{{ row.label }}</span>
              <span class="muted-inline">{{ row.main }}</span>
            </div>
            <p v-for="(line, i) in voiceStatusExtras" :key="i" class="voice-status-extra">{{ line }}</p>
          </template>
          <p v-else class="voice-status-extra">状态卡未加载（{{ saving.voiceStatus ? '读取中…' : '读取失败，点「立即探测」重试' }}）</p>
        </div>
      </div>
    </section>

    <!-- ═══ 分区 9 · 工具与技能 ═══ -->
    <section id="sec-tools" class="card block">
      <h2 class="section-title">工具与技能</h2>
      <div class="fields">
        <p class="hint" :class="{ 'tools-warn': toolsEnabled === false }">
          打开开关启用机器人可调用的工具。关闭后模型将无法使用该功能。
          {{ toolsEnabled === false ? '⚠️ 全局开关已关闭，所有工具均不可用' : '' }}
        </p>
        <label class="check-row">
          <input v-model="toolsEnabled" type="checkbox" @change="toggleToolGlobal" />
          <span>启用工具系统（关闭后机器人只能看不能做任何操作）</span>
        </label>
        <div class="actions">
          <button class="btn btn-sm" :disabled="saving.tools" @click="toolsEnableAll">全部启用</button>
          <button class="btn btn-sm" :disabled="saving.tools" @click="toolsDisableAll">全部禁用</button>
          <button class="btn btn-sm" :disabled="saving.tools" @click="toolsReset">恢复默认</button>
          <span class="save-badge" :class="saveStateOf('tools')">{{ SAVE_BADGE_TEXT[saveStateOf('tools')] }}</span>
          <span v-if="notes.tools" class="hint-text">{{ notes.tools }}</span>
        </div>

        <div v-for="cat in TOOL_CATEGORIES" :key="cat.id" class="tool-cat">
          <div class="tool-cat-head">
            <button class="btn btn-sm btn-ghost" @click="expandedCats[cat.id] = !expandedCats[cat.id]">
              {{ expandedCats[cat.id] ? '▼' : '▶' }} {{ cat.label }}
            </button>
            <label class="check-row">
              <input
                :checked="toolsCatEnabled[cat.id]"
                type="checkbox"
                @change="toggleToolCategory(cat.id, ($event.target as HTMLInputElement).checked)"
              />
              <span>本分类启用</span>
            </label>
            <span class="hint">{{ (toolsByCategory[cat.id] || []).length }} 个工具</span>
          </div>
          <div v-if="expandedCats[cat.id]" class="tool-list">
            <p v-if="!(toolsByCategory[cat.id] || []).length" class="hint">（该分类下没有可用工具）</p>
            <div
              v-for="t in toolsByCategory[cat.id]"
              :key="t.id"
              class="tool-row"
              :class="{ off: !toolChecked(t) }"
            >
              <label class="check-row tool-check">
                <input
                  :checked="toolChecked(t)"
                  type="checkbox"
                  :disabled="toolDepDisabled(t)"
                  @change="toggleTool(t, ($event.target as HTMLInputElement).checked)"
                />
                <span class="mono">{{ String(t.id || '').split(':').pop() }}</span>
                <span v-if="t.skillId" class="badge">skill</span>
              </label>
              <span class="hint tool-desc">{{ String(t.description || '（无说明）').split('。')[0] }}。</span>
              <span v-if="t.requiresVision" class="hint">需要视觉模型</span>
              <span v-if="t.requiresSearch" class="hint">需要搜索服务</span>
              <span v-if="toolDepDisabled(t)" class="hint tools-warn">依赖未满足</span>
            </div>
          </div>
        </div>
        <p v-if="hasInactiveTools" class="hint">
          所属技能已停用的工具整组隐藏（与提示词口径一致）。
        </p>

        <div class="sub-block">
          <h3 class="sub-title">技能 / 插件开关（启停即时生效，无需重启）</h3>
          <div class="actions">
            <button class="btn btn-sm" :disabled="saving['skills-rescan']" @click="rescanSkills">重扫磁盘</button>
            <span v-if="notes['skills-rescan']" class="hint-text">{{ notes['skills-rescan'] }}</span>
          </div>
          <p v-if="!skillRows.length" class="hint">（没有已注册的技能 / 插件）</p>
          <div v-for="s in skillRows" :key="s.id" class="subsys-row">
            <span class="dot" :class="s.enabled ? 'on' : 'off'"></span>
            <span class="subsys-label">{{ s.name }}<span class="mono">（{{ s.id }}）</span></span>
            <span v-if="s.kindLabel" class="badge">{{ s.kindLabel }}</span>
            <span class="muted-inline">{{ s.description }}</span>
            <span v-if="!s.installed" class="badge">未安装</span>
            <span v-if="s.loadError" class="hint tools-warn">加载失败</span>
            <template v-if="s.installed">
              <button
                class="btn btn-sm"
                :disabled="saving[`skill:${s.id}`]"
                @click="toggleSkill(s.id, !s.enabled)"
              >
                {{ s.enabled ? '关闭' : '开启' }}
              </button>
              <span v-if="notes[`skill:${s.id}`]" class="hint-text">{{ notes[`skill:${s.id}`] }}</span>
            </template>
          </div>
          <p v-if="skillsPayload?.summary" class="hint">
            共 {{ skillsPayload.summary.total ?? 0 }} 个 · 活跃 {{ skillsPayload.summary.active ?? 0 }} · 停用 {{ skillsPayload.summary.disabled ?? 0 }} · 加载失败 {{ skillsPayload.summary.broken ?? 0 }}
          </p>
        </div>
      </div>
    </section>

    <!-- ═══ 主题（D49）：与顶栏按钮共用同一状态；仅本机 localStorage，不走 /api/config ═══ -->
    <section class="card block">
      <h2 class="section-title">主题</h2>
      <div class="fields">
        <p class="hint">潮涨 = 亮色（默认，亚麻纸底 #F4EFE4） · 潮落 = 暗色（深蓝墨底 #141821，冷底暖点）· 只存本机（localStorage），与顶栏按钮同步</p>
        <div class="actions">
          <button class="btn" :class="{ 'btn-accent': theme === 'light' }" @click="pickTheme('light')">
            潮涨 · 亮
          </button>
          <button class="btn" :class="{ 'btn-accent': theme === 'dark' }" @click="pickTheme('dark')">
            潮落 · 暗
          </button>
          <span class="hint-text">当前：{{ theme === 'dark' ? '潮落（暗）' : '潮涨（亮）' }}</span>
        </div>
      </div>
    </section>

      </div><!-- /.set-sections -->
    </div><!-- /.set-body -->
  </div>
</template>

<style scoped>
.set-page {
  /* S2 设计稿五：工具型页主列 1200（原 760——P1-5 大屏空白） */
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
}

/* ---- S2 设计稿五：左缘分区锚点导航（sticky）+ 保存状态徽标 ---- */
.set-body {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.set-sections {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sec-nav {
  position: sticky;
  top: 0;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 92px;
  padding: var(--space-1) 0;
}

.sec-link {
  appearance: none;
  padding: 3px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-card);
  background: transparent;
  color: var(--ink-2);
  font-size: 11.5px;
  line-height: 1.5;
  letter-spacing: 0.04em;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease;
}

.sec-link:hover {
  border-color: var(--line-strong);
  color: var(--accent);
}

@media (max-width: 1100px) {
  .sec-nav {
    display: none;
  }
}

.save-badge {
  padding: 0 7px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  line-height: 20px;
  color: var(--mist-3);
  white-space: nowrap;
  user-select: none;
}

.save-badge.saving {
  color: var(--ink-2);
  animation: badge-pulse 1.2s infinite ease-in-out;
}

.save-badge.saved {
  border-color: var(--olive);
  color: var(--olive);
}

.save-badge.failed {
  border-color: #c0392b;
  color: #c0392b;
}

@keyframes badge-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
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

.fields {
  margin-top: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field > span,
.field-label {
  color: var(--ink-2);
  font-size: 12px;
}

.model-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.model-row input {
  flex: 1;
  min-width: 0;
}

.model-switch {
  max-width: 190px;
}

.field input[type='text'],
.field input[type='password'],
.field input[type='number'],
.field select,
.field textarea {
  font-family: var(--font-sans);
  font-size: 13px;
  padding: 5px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: var(--card);
  color: var(--ink);
}

.field textarea {
  resize: vertical;
  line-height: 1.7;
}

.field input:focus,
.field select:focus,
.field textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.field input:disabled {
  opacity: 0.55;
}

/* roleText 大字段：textarea 全高（night-plan §6.5 要求） */
.ta-role {
  min-height: 420px;
}

.ta-mid {
  min-height: 96px;
}

.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.row-3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 10px;
}

/* 窄窗 / 放大：并排字段改为单列，不再挤成三条细缝 */
@media (max-width: 760px) {
  .row-2,
  .row-3 {
    grid-template-columns: minmax(0, 1fr);
  }
}

.check-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.hint {
  margin: 0;
  color: var(--ink-2);
  font-size: 11px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.hint-text {
  color: var(--ink-2);
  font-size: 12px;
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.sub-block {
  border-top: 1px solid var(--line);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sub-title {
  font-size: 15px;
  color: var(--ink-2);
}

.subsys-rows {
  margin-top: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.subsys-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  flex-wrap: wrap;
}

.subsys-label {
  min-width: 180px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.dot.on {
  background: var(--accent);
}

.dot.off {
  background: var(--line-strong);
}

.muted-inline {
  color: var(--ink-2);
  font-size: 12px;
  flex: 1 1 auto;
}

/* ── 页头动作条（单保存按钮 · 2026-11-21） ────────────────────────────── */
.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* ── 系统提示词只读查看器 ────────────────────────────────────────────── */
.sys-prompt-view {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--paper);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 420px;
  overflow: auto;
}

/* ── W3 语音分区：组标题 / 密钥行 / 引擎状态卡 ─────────────────────────── */
.voice-group-head {
  margin: 10px 0 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
  border-top: 1px dashed var(--line-strong);
  padding-top: 10px;
}

.api-key-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.api-key-row input {
  flex: 1 1 auto;
  min-width: 0;
}

.voice-status {
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.voice-status-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.voice-status-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.voice-status-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
}

.voice-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.voice-status-kind {
  flex: none;
  font-weight: 600;
}

.voice-status-extra {
  margin: 0;
  font-size: 12px;
  color: var(--ink-2);
}

.btn-sm {
  padding: 1px 10px;
  font-size: 11px;
}

.btn-danger:hover:not(:disabled) {
  border-color: var(--warm);
  color: var(--warm);
}

/* 备选模型行 / 添加表单行 */
.fb-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.fb-provider {
  flex: 1 1 40%;
}

.fb-model {
  flex: 2 1 60%;
}

/* 折叠块 */
.fold {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px 10px;
}

.fold summary {
  cursor: pointer;
  color: var(--ink-2);
  font-size: 13px;
}

.fold[open] summary {
  margin-bottom: 8px;
}

/* 价格表 / 模型管理 */
.price-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.price-table th,
.price-table td {
  border-bottom: 1px solid var(--line);
  padding: 4px 6px;
  text-align: left;
}

.price-table input {
  width: 90px;
  font-family: var(--font-sans);
  font-size: 12px;
  padding: 3px 6px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: var(--card);
  color: var(--ink);
}

.pc-model {
  margin: 0;
  font-size: 13px;
}

.mg-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.mg-pid {
  flex: 1 1 200px;
  font-family: var(--font-sans);
  font-size: 13px;
  padding: 4px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: var(--card);
  color: var(--ink);
}

.mg-form {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mg-models {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mg-model-row {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}

.mg-model-row .hint {
  flex: 1 1 auto;
}

/* ── 分区 5-9 ── */

/* 工具分类折叠 */
.tool-cat {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 6px 10px;
}

.tool-cat-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.btn-ghost {
  border-color: transparent;
  background: transparent;
}

.tool-list {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tool-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  border-bottom: 1px dashed var(--line);
  padding-bottom: 4px;
}

.tool-row.off {
  opacity: 0.6;
}

.tool-check {
  min-width: 260px;
}

.tool-desc {
  flex: 1 1 auto;
}

.tools-warn {
  color: var(--warm);
}

/* ── 自定义头像（2026-11-21）：预览圆裁 + 上传/恢复默认 ─────────────────── */
.avatar-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 4px;
}

.avatar-preview {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  object-fit: cover;
  flex: none;
  border: 1px solid var(--line);
  box-shadow: var(--ring);
}

.avatar-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.visually-hidden-input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

</style>
