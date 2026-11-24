/* ============================================================
   会话页数据源 —— 端点与参数 100% 复用旧 UI（口径照抄）：
   - GET  /api/sessions?limit=1048576   旧 02-sse-sessions.js L179
   - GET  /api/sessions/:id             旧 02-sse-sessions.js L505
   - GET  /api/chats                    旧 04-archive-usage.js L6（取 chatName 供列表显示名）
   后端 routes 原样保留（D40），本文件零后端改动。
   ============================================================ */
import type {
  ActiveFact,
  ChatMeta,
  KernelEvent,
  MemoryCard,
  PersonState,
  SessionDetail,
  SessionSummary,
  StagingEntry,
} from './types'
import { requestLogin } from './consoleAuth'

/**
 * fetch 封装（旧 00-core.js L389-398 同口径：非 2xx 抛 payload.error / HTTP 状态）。
 *
 * E6（R2）：收 401 → 触发 App 级登录浮层（consoleAuth.requestLogin），用户输入
 * server.token → POST /api/auth/login（后端 Set-Cookie）→ 成功后**重试原请求一次**
 *（仅一次：重试仍 401 = 服务端令牌已换，直接抛错让页面显示，不再循环弹层；
 * 用户取消浮层 = 等待失败，抛同语义错误）。重试前提是 body 可重放——本文件
 * 全部调用点的 body 均为 JSON.stringify 字符串，满足。
 */
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res = await fetch(path, options)
  if (res.status === 401) {
    const granted = await requestLogin()
    if (!granted) throw new Error('未授权：控制台令牌登录已取消')
    res = await fetch(path, options) // 重试原请求一次（cookie 已就位）
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

/**
 * 会话列表一次全取：后端上限 1048576（约等于不限），
 * 分页渲染由前端 slice 控制（SESSION_PAGE，照旧 UI 口径）。
 */
export async function fetchSessions(): Promise<SessionSummary[]> {
  const data = await api<{ sessions: SessionSummary[] }>('/api/sessions?limit=1048576')
  return data.sessions || []
}

export async function fetchSession(id: string): Promise<SessionDetail> {
  return api<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`)
}

export async function fetchChats(): Promise<ChatMeta[]> {
  const data = await api<{ chats: ChatMeta[] }>('/api/chats')
  return data.chats || []
}

/* ============================================================
   M2 前额叶页群端点（D43）—— 后端只增端点（src/routes.js 尾段）：
   GET  /api/person/state             状态栏 + 自我/心绪/关系页数据源
   GET  /api/person/cards             卡片库（cards 倒序 + active facts）
   GET  /api/person/staging           staging 原料（各日文件，日期倒序）
   GET  /api/events/recent?limit=N    事件流历史（尾部 N 条，倒序）
   POST /api/person/self/narrative    narrative 编辑（D43 唯一写入口）
   ============================================================ */

export async function fetchPersonState(): Promise<PersonState> {
  return api<PersonState>('/api/person/state')
}

export async function fetchCards(): Promise<{ cards: MemoryCard[]; facts: ActiveFact[] }> {
  const data = await api<{ cards: MemoryCard[]; facts: ActiveFact[] }>('/api/person/cards')
  return { cards: data.cards || [], facts: data.facts || [] }
}

export async function fetchStaging(): Promise<{ days: Array<{ day: string; entries: StagingEntry[] }> }> {
  const data = await api<{ days: Array<{ day: string; entries: StagingEntry[] }> }>('/api/person/staging')
  return { days: data.days || [] }
}

export async function fetchRecentEvents(limit = 300): Promise<{ events: KernelEvent[] }> {
  const data = await api<{ events: KernelEvent[] }>(`/api/events/recent?limit=${limit}`)
  return { events: data.events || [] }
}
// （saveNarrative 已随 2026-11-21 self 面丢弃移除——端点/页面/模块全删。）

/* ============================================================
   M3 页群端点（D44）—— 端点与载荷口径 100% 复用旧 UI：
   - GET  /api/usage/stats?range=today|7|30|all   旧 04-archive-usage.js L767
   - GET  /api/usage/breakdown?range&dim&key&by   旧 04-archive-usage.js L891
   - GET  /api/status                             旧 UI 进程页 L60（Q2 摘
                                                  QQ 载体两组诊断字段）
   - GET  /api/logs?limit=120                     旧 UI 进程页 L20
   - POST /api/logs/level {level}                 旧 UI 进程页 L219
   - GET  /api/config                             旧 05-memory-settings / 08-modals
   - POST /api/config（深合并 patch；后端无 PUT，旧 UI 保存即 POST）
                                                  旧 08-modals.js L1237/L1379
   - POST /api/skills/:id {enabled}（子系统开关，带生命周期 activate/deactivate）
                                                  旧 07-settings-events.js L172
   - GET  /api/skills                             旧 06-settings-render.js L975
   （Q2 qq-exit Step 1：进程管理 ×2 组 + 空间只读 ×1 组共三组端点随 QQ
     载体摘除，routes.js 与本文件客户端函数同删；端点全名见 handoff §4 Q2。）
   ============================================================ */
import type {
  AppConfig,
  AppLogLine,
  SkillEntry,
  SkillsPayload,
  StatusPayload,
  UsageBreakdown,
  UsageStats,
  VoiceStatusSnapshot,
} from './types'

/** 用量统计（range 照旧 UI USAGE_RANGES：today / 7 / 30 / all） */
export async function fetchUsageStats(range: string): Promise<UsageStats> {
  return api<UsageStats>(`/api/usage/stats?range=${encodeURIComponent(range)}`)
}

/** 明细交叉表（dim/chat|model|day × by 二级维度） */
export async function fetchUsageBreakdown(range: string, dim: string, key: string, by: string): Promise<UsageBreakdown> {
  return api<UsageBreakdown>(
    `/api/usage/breakdown?range=${encodeURIComponent(range)}&dim=${encodeURIComponent(dim)}&key=${encodeURIComponent(key)}&by=${encodeURIComponent(by)}`,
  )
}

export async function fetchStatus(): Promise<StatusPayload> {
  return api<StatusPayload>('/api/status')
}

export async function fetchAppLogs(limit = 120): Promise<{ logs: AppLogLine[]; level: string }> {
  const data = await api<{ logs: AppLogLine[]; level: string }>(`/api/logs?limit=${limit}`)
  return { logs: data.logs || [], level: data.level || 'info' }
}

export async function setAppLogLevel(level: string): Promise<{ ok?: boolean; level?: string }> {
  return api('/api/logs/level', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }) })
}

export async function fetchConfig(): Promise<AppConfig> {
  return api<AppConfig>('/api/config')
}

/** 设置保存：POST /api/config 深合并 patch（旧 UI 同一语义；只传本页编辑的键，不回传整份配置） */
export async function saveConfigPatch(patch: Record<string, unknown>): Promise<{ ok?: boolean; config?: AppConfig }> {
  return api('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/* ============================================================
   W1 语音快捷开关联动（night-plan-polish §2-W1.3）
   ============================================================ */
/** 单引擎 ensure 结果（engine-manager ensureForCall 引擎项形状） */
export interface VoiceEngineStatus {
  ok?: boolean
  configured?: boolean
  spawned?: boolean
  reason?: string
}
/** POST /api/voice/ensure 响应（双引擎 + TTS 预热；未配置项 configured=false） */
export interface VoiceEnsureResult {
  asr?: VoiceEngineStatus
  tts?: VoiceEngineStatus
  warmup?: { ok?: boolean; ms?: number }
  bothDown?: boolean
}

/** 引擎联动：Settings 打开 TTS/ASR 开关后拉起+预热本地引擎（engine-manager
 *  闸内自动降级——未配置/manage=manual 返回 reason 不抛错；零配置时同步返回）。 */
export async function ensureVoiceEngines(): Promise<{ ok?: boolean; result?: VoiceEnsureResult }> {
  return api('/api/voice/ensure', { method: 'POST' })
}

/** W3 状态卡：GET /api/voice/status 只读快照（两引擎 dialect/configured/running/
 *  lastProbeMs/breakerOpen + 自拉进程表 + 上次合成/转写耗时 + embedding/语音条开关态）。
 *  probe=true 触发即时探针（engine-manager probeEngines——只探测**绝不拉起**，
 *  结果回写服务端 lastProbe 缓存）；false 读缓存快照（可能 null=本进程未探测过）。 */
export async function fetchVoiceStatus(probe = false): Promise<VoiceStatusSnapshot> {
  return api<VoiceStatusSnapshot>(`/api/voice/status${probe ? '?probe=1' : ''}`)
}

/** 子系统开关：POST /api/skills/:id {enabled}（旧 UI 同款——后端先写配置再 activate/deactivate） */
export async function setSkillEnabled(id: string, enabled: boolean): Promise<{ ok?: boolean; skill?: SkillEntry }> {
  return api(`/api/skills/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

export async function fetchSkills(): Promise<SkillsPayload> {
  return api<SkillsPayload>('/api/skills')
}

/** 提供商 API Key 保存（旧 UI「模型配置」弹窗同款端点，08-modals.js L461 口径） */
export async function setProviderKey(providerId: string, apiKey: string): Promise<{ ok?: boolean; hasKey?: boolean }> {
  return api('/api/providers/set-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, apiKey }),
  })
}

/* ============================================================
   M3.5 设置全量化端点群（分区 1-4；分区 5-9 见文件尾段）—— 端点与载荷口径 100% 复用旧 UI：
   - GET  /api/providers                    旧 05-memory-settings.js L137（loadSettings）
   - POST /api/providers                    旧 08-modals.js L1136（添加提供商）
   - DELETE /api/providers {providerId}     旧 08-modals.js L894（删除提供商）
   - POST /api/providers/models             旧 08-modals.js L1040（手动加模型/勾选加入）
   - DELETE /api/providers/models           旧 08-modals.js L997（删除模型）
   - POST /api/providers/fetch-models       旧 08-modals.js L977（拉取模型列表）
   - POST /api/providers/set-key            旧 08-modals.js L461（保存/清除 Key）
   - GET  /api/providers/key?providerId=    旧 08-modals.js L940（明文读取，仅本机）
   - GET  /api/api-key                      旧 08-modals.js L579（直连模式明文读取）
   - GET  /api/vision/results               旧 05-memory-settings.js L138
   - GET  /api/persona-templates            旧 05-memory-settings.js L136
   - POST /api/persona-templates            旧 08-modals.js（openPersonaCreateModal 同款）
   - DELETE /api/persona-templates/custom_N 旧 07-settings-events.js L851
   - GET/POST/DELETE /api/search-providers  旧 07-settings-events.js L336/L393/L548
   - POST /api/search-providers/test        旧 07-settings-events.js L369
   - GET  /api/search-key?field=            旧 07-settings-events.js L583
   - GET  /api/model-prices                 旧 05-memory-settings.js L139
   ============================================================ */
import type {
  ModelPriceRow,
  PersonaTemplate,
  ProviderEntry,
  SearchProviderEntry,
} from './types'

export async function fetchProviders(): Promise<ProviderEntry[]> {
  const data = await api<{ providers: ProviderEntry[] }>('/api/providers')
  return data.providers || []
}

/** 添加提供商（openProviderAddModal L1136 同款载荷） */
export async function addProvider(
  baseUrl: string,
  apiKey: string,
  models: Array<{ id: string; name: string }>,
): Promise<{ ok?: boolean; provider?: ProviderEntry; [key: string]: unknown }> {
  return api('/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl, apiKey, models }),
  })
}

export async function deleteProvider(providerId: string): Promise<{ ok?: boolean }> {
  return api('/api/providers', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId }),
  })
}

/** 给已有提供商加模型（手动添加 L1040 / 拉取勾选 L818 同款载荷） */
export async function addProviderModels(
  providerId: string,
  models: Array<{ id: string; name: string }>,
): Promise<{ ok?: boolean; provider?: ProviderEntry }> {
  return api('/api/providers/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, models }),
  })
}

export async function deleteProviderModel(providerId: string, modelId: string): Promise<{ ok?: boolean }> {
  return api('/api/providers/models', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, modelId }),
  })
}

/** 拉取模型列表（openModelManageModal L977：Key 用后端保存的，只传 baseUrl+providerId） */
export async function renameProvider(
  providerId: string,
  displayName: string,
): Promise<{ ok?: boolean; provider?: ProviderEntry }> {
  return api('/api/providers/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, displayName }),
  })
}

export async function fetchProviderModels(
  baseUrl: string,
  opts: { providerId?: string; apiKey?: string } = {},
): Promise<{ ok?: boolean; models?: string[] }> {
  return api('/api/providers/fetch-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl, ...(opts.providerId ? { providerId: opts.providerId } : {}), ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) }),
  })
}

/** 拉取提供商模型时选中的待加入条目（openModelAddModal 载荷：{id,name}） */
export interface RemoteModelCandidate {
  id: string
  name: string
}

/** 明文读取提供商 Key（仅本机放行；显示按钮专用） */
export async function fetchProviderKey(providerId: string): Promise<string> {
  const r = await api<{ apiKey?: string }>(`/api/providers/key?providerId=${encodeURIComponent(providerId)}`)
  return String(r.apiKey || '')
}

/** 直连模式明文读取顶层 Key（显示按钮专用） */
export async function fetchDirectApiKey(): Promise<string> {
  const r = await api<{ apiKey?: string }>('/api/api-key')
  return String(r.apiKey || '')
}

/** 视觉能力扫描结果（徽标判定用；本页只读 verdict） */
export async function fetchVisionResults(): Promise<Record<string, { verdict?: string; source?: string; note?: string }>> {
  const data = await api<{ results?: Record<string, { verdict?: string; source?: string; note?: string }> }>('/api/vision/results')
  return data.results || {}
}

export async function fetchPersonaTemplates(): Promise<PersonaTemplate[]> {
  const data = await api<{ templates: PersonaTemplate[] }>('/api/persona-templates')
  return data.templates || []
}

/** 添加自定义人设（后端 routes.js L389-400：name/text 必填，customRules 可选） */
export async function addPersonaTemplate(name: string, text: string, customRules = ''): Promise<{ ok?: boolean }> {
  return api('/api/persona-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, text, ...(customRules ? { customRules } : {}) }),
  })
}

export async function deletePersonaTemplate(id: string): Promise<{ ok?: boolean }> {
  return api(`/api/persona-templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
}

export async function fetchSearchProviders(): Promise<SearchProviderEntry[]> {
  const data = await api<{ providers: SearchProviderEntry[] }>('/api/search-providers')
  return data.providers || []
}

/** 添加/更新自定义搜索服务（后端按 baseUrl+type 命中 existing 则更新；apiKey 语义见 routes.js L677-685） */
export async function saveSearchProvider(payload: {
  name?: string
  type?: string
  baseUrl: string
  apiKey?: string
  model?: string
  count?: number
  timeoutMs?: number
}): Promise<{ ok?: boolean; provider?: SearchProviderEntry }> {
  return api('/api/search-providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function deleteSearchProvider(id: string): Promise<{ ok?: boolean }> {
  return api('/api/search-providers', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
}

export async function testSearchProvider(providerId: string): Promise<{ ok?: boolean; result?: { ok?: boolean; count?: number; latencyMs?: number; sample?: string; note?: string } }> {
  return api('/api/search-providers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId }),
  })
}

/** 明文读取搜索 Key（field = deepseek/zhipu/bocha/baidu/metaso/custom:<id>；仅本机放行） */
export async function fetchSearchKey(field: string): Promise<{ apiKey?: string; hasApiKey?: boolean }> {
  return api(`/api/search-key?field=${encodeURIComponent(field)}`)
}

export async function fetchModelPrices(): Promise<{ prices?: ModelPriceRow[]; current?: ModelPriceRow | null }> {
  return api<{ prices?: ModelPriceRow[]; current?: ModelPriceRow | null }>('/api/model-prices')
}

/* ============================================================
   M3.5-下（分区 5-9）端点群 —— 端点与载荷口径 100% 复用旧 UI：
   - GET  /api/tools                     旧 06-settings-render.js renderToolsSection（state.toolRegistry）
   - POST /api/skills/reload             旧 06-settings-render.js rescanSkills L1032
   （skills 开关复用上方 setSkillEnabled；工具开关与桌面端/聊天设置均走
    saveConfigPatch —— 载荷形状照旧 saveConfig 'chat'/'desktop'/'tools' 分支。
    Q2 qq-exit Step 1：协议端 token 端点随设置页连接分区一同摘除；
    清债夜1：好友列表端点与「选择好友」选择器随 QQ 身体退役下线
    ——后端端点已摘除，白名单改纯文本编辑。）
   ============================================================ */
import type { ToolEntry } from './types'

/** 工具注册表（分区 9 工具列表；skillId 供「所属技能失活整组隐藏」过滤） */
export async function fetchTools(): Promise<ToolEntry[]> {
  const data = await api<{ tools: ToolEntry[] }>('/api/tools')
  return data.tools || []
}

/** 技能/插件重扫磁盘（旧 rescanSkills：先 POST reload，再拉一次列表补 uninstalled 字段） */
export async function reloadSkillsList(): Promise<SkillsPayload> {
  await api('/api/skills/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  return fetchSkills()
}

/* ============================================================
   晚安整理按钮（night-plan-life §L1 · 2026-11-14）：
   POST /api/reflection/run-evening —— 依次执行
   cards runOnce（今日，mode 沿 config.memory.writer.mode）→ diary.runDiary（force）。
   两步各自成功/失败如实返回；幂等口径=卡片同日替换、日记判重 skipped:'今日已整理'。
   ============================================================ */

export interface EveningCardResult {
  ok: boolean
  status?: 'written' | 'fallback' | 'skipped' | 'failed'
  day?: string
  mode?: string | null
  card?: { date?: string; entry?: string; events?: string[]; mood?: string } | null
  episodesApplied?: number
  factsUpserted?: number
  factsDropped?: number
  midDropped?: number
  reason?: string
  error?: string
}

export interface EveningDiaryResult {
  ok: boolean
  wrote?: boolean
  entry?: { time?: string; title?: string; content?: string } | null
  skipped?: string
  error?: string
}

/** 明日日程一步（life-prose v2，routes.js run-evening ③；S2 设计稿六接上——
 *  后端 2026-11-16 起就返回该字段，前端此前未声明未消费 = Bug2 反馈断链的一环） */
export interface EveningPlanResult {
  ok: boolean
  status?: 'written' | 'skipped' | 'failed' | (string & {})
  day?: string
  reason?: string
  error?: string
}

export interface EveningResult {
  ok: boolean
  day: string
  card: EveningCardResult
  diary: EveningDiaryResult
  /** 明日日程结果（routes.js:1627 原样；缺失=旧形状，消费方兜底） */
  plan?: EveningPlanResult
  planDay?: string
}

/** 触发今晚的记忆卡+日记整理（Sessions 页头按钮；后端逐项如实，前端只组 toast 文案） */
export async function runEveningReflection(): Promise<EveningResult> {
  return api<EveningResult>('/api/reflection/run-evening', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
}
