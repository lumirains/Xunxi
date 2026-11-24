/* ============================================================
   会话页类型 · 载荷形状照抄后端，端点与字段口径 100% 复用旧 UI
   （phase9 D40：routes/SSE 原样保留，前端只读）

   依据（本次逐行读过）：
   - /api/sessions 列表项 = src/sessions.js #summary（L246-263）
   - /api/sessions/:id 详情 = sessions.get() 整个会话对象
     （src/sessions.js create L265-291：含 surface / triggerText /
      systemPrompt / userPrompt / messages / sent / feedbacks）
   - SSE session-update 载荷 = src/app.js emit L588-615（完整会话快照）
   - messages 条目 = src/orchestrator.js：
       L1143 assistant { role, content, tool_calls?, raw? }
       L1286 { toolCall: { name, args, result, isError } }
       L1301 { toolImages: { tool, count, images, videos } }
   - 【深度思考】气泡 = src/orchestrator.js:1226（原 plugins/detailed-thinking/index.js，Q15 收编核心）
     after-response 注入 { role:'assistant', content:'【深度思考】\n…' }

   说明：列表项字段多数标为可选 —— HTTP 列表（#summary）字段齐全，
   但 SSE session-update 首次 upsert 的条目（旧 UI 02-sse-sessions.js
   L46 的 unshift 分支）只带 SSE 载荷里有的字段；模板对缺失字段一律
   兜底显示，不假设存在。
   ============================================================ */

/** 会话状态词表（src/sessions.js #summary L252 注释原样） */
export type SessionStatus =
  | 'waiting'
  | 'running'
  | 'done'
  | 'noreply'
  | 'error'
  | 'aborted'
  // 防御：后端加了新状态时前端不崩，徽标原样显示英文词
  | (string & {})

export interface UsageEntry {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
  calls?: number
  extra?: Record<string, unknown>
}

/** /api/sessions 列表项（#summary 逐字段；SSE upsert 的条目字段可缺） */
export interface SessionSummary {
  id: string
  chatKey: string
  startedAt: number
  status: SessionStatus
  endedAt?: number | null
  waitUntil?: number | null
  activity?: string
  webSearchCount?: number
  outcome?: { sent: number; finishReason: string | null } | null
  usage?: UsageEntry | null
  model?: string
  /** 列表里是 triggerSummary 字符串（#summary L259） */
  trigger?: string
  promptChars?: number
  rounds?: number
  /** S2 设计稿一（2026-11-18）：她的回应摘要 = sent 最后一条正文（后端截 120 字）。
   *  HTTP 列表 #summary 新增；SSE upsert 的条目缺省（模板走 lastSentOf 兜底链） */
  lastSent?: string
  /** 身体归属：#summary 目前不带（前端按路由表推导），SSE/未来后端可能带 */
  surface?: string
  /** 收尾字段：SSE session-update patch 携带（旧 02-sse-sessions.js L36-41），
      HTTP 列表（#summary）没有 —— 只作数据留存，列表展示不依赖 */
  sent?: SentEntry[]
  finishReason?: string | null
  error?: string | null
}

/** 工具调用条目（orchestrator L1286） */
export interface ToolCallItem {
  name: string
  args: unknown
  result: string
  isError?: boolean
}

/** 图片注入条目（orchestrator L1301） */
export interface ToolImagesItem {
  tool: string
  count: number
  images?: number
  videos?: number
}

/** OpenAI 消息条目（orchestrator L1136 assistantEntry） */
export interface AssistantMessage {
  role: 'assistant' | (string & {})
  content: string | null
  tool_calls?: unknown
  raw?: unknown
}

/** 会话消息流条目：三类（工具 / 图片注入 / assistant 气泡） */
export type SessionMessageItem =
  | { toolCall: ToolCallItem }
  | { toolImages: ToolImagesItem }
  | AssistantMessage

/** 实际发出的每一条（src/tools.js L199：{ type, text, at }） */
export interface SentEntry {
  type?: string
  text: string
  at?: string
  to?: string
}

/** /api/sessions/:id 详情（会话对象全量；SSE 合并进来的快照缺的键可选） */
export interface SessionDetail {
  id: string
  chatKey: string
  /** 身体归属（src/sessions.js L286 落字段，source 直取；Q11 起 web 是唯一在册身体，当前恒 'web'） */
  surface?: string
  startedAt: number
  endedAt?: number | null
  status: SessionStatus
  waitUntil?: number | null
  /** 详情里是创建时原值（'message' | 'proactive'，见 sessions.js L277） */
  trigger?: string | string[]
  triggerSummary?: string
  /** 真实存档的触发消息（sessions.js L540 triggerEntriesToText） */
  triggerText?: string
  systemPrompt?: string
  userPrompt?: string
  promptChars?: number
  model?: string
  rounds?: number
  webSearchCount?: number
  messages?: SessionMessageItem[]
  sent?: SentEntry[]
  finishReason?: string | null
  error?: string | null
  usage?: UsageEntry | null
}

/** SSE session-update 载荷（src/app.js L594-615 逐字段） */
export interface SessionUpdatePayload {
  sessionId: string
  chatKey: string
  startedAt: number
  status: SessionStatus
  waitUntil: number | null
  activity: string
  webSearchCount: number
  rounds: number
  usage: UsageEntry | null
  trigger: string
  triggerSummary: string
  messages: SessionMessageItem[]
  sent: SentEntry[]
  finishReason: string | null
  error: string | null
  endedAt: number | null
}

/** SSE session-end 载荷（routes.js L1031 / L1040） */
export interface SessionEndPayload {
  sessionId?: string
  status?: string
  removed?: number
}

/** /api/chats 列表项（routes.js L1066-1081：key + getChatMeta 展开 + chatName） */
export interface ChatMeta {
  key: string
  unread?: number
  lastText?: string
  total?: number
  lastTs?: number
  chatName?: string
}

/* ============================================================
   M2 前额叶页群类型（D43）—— 载荷形状照抄后端：
   - MindState          contracts.js MindState（mind.js 落地）
   - MemoryCard         contracts.js MemoryCard（原清单 §10.1 schema）
   - StagingEntry       contracts.js StagingEntry
   - KernelEvent        src/kernel/events.js append 字段（source/kind/valence/
                        impact/text/ref/ts [+channel/visibility/conversationId]）
   字段多数标可选：后端各读路径对缺失/损坏一律防御式 null / 空，
   前端逐格兜底显示，不假设存在。
   ============================================================ */

/** self.history 条目（self.js update 记账：before/after 只含变更字段） */
export interface Preoccupation {
  id?: string
  text?: string
  at?: number
  source?: string
  expiresAt?: number
}

export interface MindState {
  mood?: { text?: string; textAt?: number; updatedAt?: number }
  body?: { sleepy?: boolean; hungry?: boolean }
  preoccupations?: Preoccupation[]
  intentions?: Array<{ text?: string; weight?: number }>
  updatedAt?: number
}

export interface PersonState {
  mind?: MindState | null
  /** 生活模块开关（config.modules.life.enabled，缺省 true）——右栏区分"未开启"与"还没有安排" */
  lifeEnabled?: boolean
  /** 她的名字（config.persona.botName，后端兜底"汐"）——UI 用配置名指代，不写死 */
  botName?: string
  /** 自定义头像 mtime（缓存击穿用；0=未设置，回落内置圆徽章） */
  avatarTs?: number
  lifeToday?: unknown
  sleep?: { asleep?: boolean; awakeUntil?: number } | null
  now?: number
}

export interface MemoryCardFact {
  kind?: string
  content?: string
  mid?: number | null
}

export interface MemoryCardPromise {
  text?: string
  due?: string
  status?: string
  mid?: number | null
}

export interface MemoryCard {
  date?: string
  salience?: number
  events?: string[]
  facts?: MemoryCardFact[]
  promises?: MemoryCardPromise[]
  open_loops?: string[]
  mood?: string
  range?: { from?: number; to?: number }
  source?: string
}

/** /api/person/cards 的 facts（person/memory.facts({status:'active'})） */
export interface ActiveFact {
  key?: string
  kind?: string
  subject?: string
  content?: string
  status?: string
  validFrom?: number
  supersededBy?: string | null
  mid?: number | null
}

export interface StagingEntry {
  text?: string
  mid?: number | null
  source?: string
  at?: number
}

/** /api/events/recent 条目 + SSE kernel-event 载荷（kernel/events.js append 字段） */
export interface KernelEvent {
  source?: string
  kind?: string
  valence?: number
  impact?: number
  text?: string
  ref?: string
  ts?: number
  channel?: string
  visibility?: string
  conversationId?: string
}

/* ============================================================
   M3 页群类型（D44）—— 端点 100% 复用旧 UI，载荷形状照抄后端：
   - UsageStats     GET /api/usage/stats（src/app.js buildUsageStatsWithSnapshots
                    返回 stats 字段；routes.js L243-253 展开为顶层）
   - UsageBreakdown GET /api/usage/breakdown（buildUsageBreakdown：totals+rows）
   - StatusPayload  GET /api/status（routes.js L140-176 逐字段；Q2 摘
                    QQ 载体两组诊断字段、Q11 摘连接诊断段后仅剩 orchestrator/usage/…）
   - AppLogLine     GET /api/logs（logger.recent：{ts,level,module,text}）
   - AppConfig      GET /api/config（sanitizeConfig 脱敏后形状：apiKey 删除 → hasApiKey）
   - SkillsPayload  GET /api/skills（moduleManager.list + summary + uninstalled）
   （Q2 qq-exit Step 1：LogLine（进程日志行）与空间只读状态型
     两型随其端点一同摘除。）
   字段可选 = 后端该路径可能缺省/降级，前端逐格兜底显示。
   ============================================================ */

/** /api/usage/stats 聚合组里的一行（chats/models 维度；models 另拆 vendor/model） */
export interface UsageGroupRow {
  /** totals 本身没有 key（app.js totals 组装）；chats/models/breakdown rows 有 */
  key?: string
  vendor?: string
  model?: string
  runs?: number
  exactCalls?: number
  cost?: number
  peakCost?: number
  offPeakCost?: number
  peakTokens?: number
  offPeakTokens?: number
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  totalTokens?: number
  cacheHitRate?: number
  peakRatio?: number
}

/** 按天聚合行（= 各日 totals + searchCount，app.js byDay 组装） */
export interface UsageDayRow extends UsageGroupRow {
  day: string
  searchCount?: number
}

/** 今日按小时行（app.js hours 组装） */
export interface UsageHourRow {
  hour: number
  cost?: number
  runs?: number
  searchCount?: number
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  cacheHitRate?: number
  totalTokens?: number
}

export interface UsageStats {
  range?: string
  rangeLabel?: string
  mode?: 'today' | '24h' | 'all' | 'days' | (string & {})
  totals?: UsageGroupRow & { hasPeakModel?: boolean }
  searchCount?: number
  toolCounts?: Record<string, number>
  days?: UsageDayRow[]
  hours?: UsageHourRow[]
  chats?: UsageGroupRow[]
  models?: UsageGroupRow[]
}

/** /api/usage/breakdown 响应（buildUsageBreakdown：totals + rows） */
export interface UsageBreakdown {
  totals?: UsageGroupRow & { hasPeakModel?: boolean }
  rows?: UsageGroupRow[]
}

/** GET /api/status 载荷（routes.js 逐字段；Q2 摘 QQ 载体诊断字段，Q11 摘连接诊断段
 *  ——连接诊断键已随协议端归档从响应摘除，本接口仅剩下列） */
export interface StatusPayload {
  paused?: boolean
  pauseReason?: string | null
  dataDir?: string
}

/** 应用日志行（logger.recent：{ts, level, module, text}） */
export interface AppLogLine {
  ts?: number
  level?: string
  module?: string
  text?: string
}

/* ============================================================
   M3.5 设置全量化类型（night-plan §6.5）—— 载荷形状照抄后端：
   - ProviderEntry     GET /api/providers（routes.js L414-424：sanitize 后形状）
   - PersonaTemplate   GET /api/persona-templates（routes.js L378-387）
   - ModelPriceRow     GET /api/model-prices（routes.js L273-277，listOfficialPrices 行）
   - SearchProvider    GET /api/search-providers（routes.js L650-657：脱敏后 hasApiKey）
   - AppConfig 补分区 1-4 用到的键（api 全字段 / webSearch / memory / persona）；
     密钥字段脱敏为 hasXxx 布尔（sanitizeConfig）。
   ============================================================ */

/** GET /api/providers 列表项（脱敏后：apiKey 恒空串，hasKey 表存在） */
export interface ProviderEntry {
  id?: string
  displayName?: string
  baseURL?: string
  apiKey?: string
  apiKeyFrom?: string
  needsBaseUrl?: boolean
  hasKey?: boolean
  anthropicOrigin?: boolean
  models?: string[]
  modelNames?: Record<string, string>
}

/** GET /api/persona-templates 条目（内置 + custom_ 前缀自定义） */
export interface PersonaTemplate {
  id?: string
  name?: string
  text?: string
  customRules?: string
  builtin?: boolean
}

/** GET /api/model-prices 的 prices 行（src/model-prices.js 官方表；页面仅展示官方价参考） */
export interface ModelPriceRow {
  id?: string
  in?: number
  out?: number
  cached?: number
  src?: string
  [key: string]: unknown
}

/** api.modelPrices 条目形状（config.js L91-93：{ in, out, cached }） */
export interface ModelPriceEntry {
  in?: number
  out?: number
  cached?: number
}

/** api.fallbackModels 条目（config.js L36-39：{ model, provider? }） */
export interface FallbackModelEntry {
  model?: string
  provider?: string
}

/** GET /api/search-providers 列表项（脱敏后：apiKey 删除 → hasApiKey） */
export interface SearchProviderEntry {
  id?: string
  name?: string
  type?: string
  baseUrl?: string
  model?: string
  count?: number
  timeoutMs?: number
  hasApiKey?: boolean
}

/** GET /api/config 的 voice 段（spec §2.6 / src/config.js:427-497 逐键对应；
 *  T3 V2 前端——通话入口闸=voice.enabled && voice.call.enabled。W3 起 asr/tts
 *  含 W2 全键；apiKey 由 GET /api/config 脱敏删除→hasApiKey 布尔，不出现在此） */
export interface VoiceConfig {
  enabled?: boolean
  asr?: {
    /** W1 快捷开关：false=零调用（缺省 true 兼容现役；Settings 顶部可切） */
    enabled?: boolean
    engine?: string
    /** W2 协议方言：缺省不在 config（运行时 dialectOf 从 engine 名派生）；
     *  ''/未设置=跟随 engine 名，显式值='gpu-local'|'deepseek-tools'|'openai-compat' */
    dialect?: string
    baseUrl?: string
    /** W2：deepseek-tools/openai-compat Bearer（GET 脱敏→hasApiKey 布尔） */
    apiKey?: string
    /** GET 脱敏副产物：明文 key 是否已在服务端配置 */
    hasApiKey?: boolean
    model?: string
    timeoutMs?: number
    language?: string
    [key: string]: unknown
  }
  tts?: {
    /** W1 快捷开关：false=零调用（缺省 true 兼容现役；Settings 顶部可切，
     *  通话覆盖层内也可切——逐句现读闸，下一句起生效） */
    enabled?: boolean
    engine?: string
    /** W2 协议方言（同 asr.dialect 语义：'' =跟随 engine 名派生） */
    dialect?: string
    baseUrl?: string
    /** W2：deepseek-tools/openai-compat Bearer（GET 脱敏→hasApiKey 布尔） */
    apiKey?: string
    hasApiKey?: boolean
    refVoice?: string
    /** W2：openai-compat speech 模型名（空=请求不带 model 字段） */
    model?: string
    /** W2：deepseek voice_id 'stella'|'tide'；openai voice 字段同读此键 */
    voiceId?: string
    /** W2：deepseek 协议参数（服务端过滤代码块/表格/引用），缺省 true */
    filterMarkdown?: boolean
    /** 落档/请求档位：'ogg'|'wav'|'pcm'（pcm 仅流式方言有义；gpu-local 按 ogg 处理） */
    format?: string
    /** W2：PCM 档位采样率（deepseek 协议固定 24000） */
    sampleRate?: number
    /** W2：Opus 落档码率 kbps（缺省 24=听感定稿值） */
    bitrateKbps?: number
    timeoutMs?: number
    [key: string]: unknown
  }
  /** 引擎运行策略（design §10.1 / D19；Settings 语音分区暴露两键） */
  engine?: {
    /** 'auto'=允许 App 在呼叫中拉起/预热引擎；'manual'=只探测不拉起 */
    manage?: string
    gpuAllow?: boolean
    [key: string]: unknown
  }
  call?: {
    /** 通话模式单独开关（false=通话入口不存在，握手 404——T7 口径一致） */
    enabled?: boolean
    silenceMs?: number
    minUtteranceMs?: number
    maxUtteranceMs?: number
    firstSentenceMaxChars?: number
    maxSentences?: number
    promptBudget?: number
    historyTurns?: number
    recallMinSeconds?: number
    /** 挂断回想开关（false=整通不落回想行，调试期用） */
    recall?: boolean
    keepAudio?: boolean
    dnd?: { start?: string; end?: string; [key: string]: unknown }
    [key: string]: unknown
  }
  [key: string]: unknown
}

/* ============================================================
   W3 状态卡（night-plan-polish §2-W3.2 · GET /api/voice/status 只读快照）
   ============================================================ */
/** 单引擎状态条目（running=null=本进程尚未探测过，前端渲染灰点+"未探测"） */
export interface VoiceStatusEngine {
  kind?: string
  /** config.voice.asr/tts.engine 原值（'off'|引擎名|方言名） */
  engine?: string
  /** dialectOf 派生结果（''=未配置或引擎未启用） */
  dialect?: string
  enabled?: boolean
  /** gateOf 同口径四合成：总闸+快捷开关+engine≠off+baseUrl 非空+方言合法 */
  configured?: boolean
  running?: boolean | null
  lastProbeMs?: number | null
  lastProbeAt?: number | null
  /** 仅 tts 有义（连续 3 次失败熔断；asr 恒 false） */
  breakerOpen?: boolean
  reason?: string
}
/** engine-manager 自拉进程表条目（owned 登记表口径——外部手启引擎不在列） */
export interface VoiceProcessInfo {
  pid?: number
  kind?: string
  exe?: string
  startedAt?: number
}
/** 上次合成/转写耗时（W3 埋点；null=本进程还没真实尝试过） */
export interface VoiceTimingInfo {
  ms?: number
  ok?: boolean
  at?: number
}
/** GET /api/voice/status 响应（probe=true 时即时探针结果优先并回写服务端缓存） */
export interface VoiceStatusSnapshot {
  ok?: boolean
  /** 本次响应是否含即时探针结果（?probe=1） */
  probed?: boolean
  voiceEnabled?: boolean
  engines?: { asr?: VoiceStatusEngine; tts?: VoiceStatusEngine }
  processes?: VoiceProcessInfo[]
  timings?: { lastSynth?: VoiceTimingInfo | null; lastTranscribe?: VoiceTimingInfo | null }
  /** TTS 熔断连击计数（辅助诊断） */
  ttsFailStreak?: number
  embedding?: { enabled?: boolean; model?: string }
  /** 消息语音条开关态 = voice.enabled && voice.tts.enabled !== false */
  messageVoiceBars?: boolean
}

/**
 * [通话 M:SS] 回想行前缀契约（design §8.2/night-plan §2-T6："前缀是契约，两侧同源常量"）。
 * 这是**前端侧唯一定义点**；后端同值字面 = `src/voice/recall.js` 的 RECALL_PREFIX_RE
 * （两侧字面一致性由 tools/voice-call-test.mjs 同源断言锁）。改文案必须两处一起改。
 * 消费面：useChat.ts 的 callRecallDuration/callRecallBody → Chat.vue/Pwa.vue 通话条渲染。
 */
export const RECALL_LINE_RE = /^\[通话 (\d+:\d{2})\]\s/

/** GET /api/config 脱敏后形状（本页用到的键；apiKey 已删 → hasApiKey/hasKey 布尔） */
export interface AppConfig {
  api?: {
    baseUrl?: string
    apiKey?: string
    model?: string
    provider?: string
    fallbackModels?: FallbackModelEntry[]
    visionModel?: string
    videoModel?: string
    videoMode?: string
    vision?: boolean
    video?: boolean
    temperature?: number
    maxRounds?: number
    maxTokens?: number
    thinkingMode?: string
    thinkingEffort?: string
    priceInputPerM?: number
    priceOutputPerM?: number
    priceCachedPerM?: number
    useOfficialPrice?: boolean
    modelPrices?: Record<string, ModelPriceEntry>
    hasApiKey?: boolean
    hasKey?: boolean
    [key: string]: unknown
  }
  providers?: Array<Record<string, unknown>>
  webSearch?: {
    enabled?: boolean
    searchUrl?: string
    maxResults?: number
    provider?: string
    deepseek?: { apiKey?: string; hasApiKey?: boolean; baseUrl?: string; model?: string; timeoutMs?: number; [key: string]: unknown }
    zhipu?: { apiKey?: string; hasApiKey?: boolean; baseUrl?: string; engine?: string; count?: number; timeoutMs?: number; [key: string]: unknown }
    bocha?: { apiKey?: string; hasApiKey?: boolean; baseUrl?: string; count?: number; timeoutMs?: number; [key: string]: unknown }
    baidu?: { apiKey?: string; hasApiKey?: boolean; baseUrl?: string; count?: number; timeoutMs?: number; [key: string]: unknown }
    metaso?: { apiKey?: string; hasApiKey?: boolean; baseUrl?: string; count?: number; timeoutMs?: number; [key: string]: unknown }
    providers?: SearchProviderEntry[]
    custom?: { name?: string; type?: string; baseUrl?: string; apiKey?: string; model?: string; count?: number; timeoutMs?: number; [key: string]: unknown }
    [key: string]: unknown
  }
  allow?: { groups?: string[]; private?: string[] }
  deny?: DenyMap
  allowAllWhenEmpty?: boolean
  wakeDelayMs?: number
  drainDelayMs?: number
  maxConcurrentRuns?: number
  sessionRetryAttempts?: number
  send?: SendConfig
  store?: StoreConfig
  sticker?: StickerConfig
  server?: ServerConfig
  ui?: UiConfig
  voice?: VoiceConfig
  tools?: ToolsConfig
  /** W6-②：容器键由 skills 更名 modules（GET /api/config 随后端形状） */
  modules?: Record<string, { enabled?: boolean; [key: string]: unknown }>
  memory?: {
    writer?: { mode?: string }
    consolidateEnabled?: boolean
    consolidateMinIntervalMs?: number
    useChatModel?: boolean
    provider?: string
    model?: string
    /** W4 · 向量召回与注入（src/config.js DEFAULT_CONFIG.memory.embedding 同形） */
    embedding?: {
      enabled?: boolean
      provider?: string
      model?: string
      queryInstruction?: string
      /** 'always'（缺省，命中即注入）| 'strict'（旧三闸门） */
      gateMode?: string
      fuseWeights?: { lexical?: number; vector?: number; row?: number; gist?: number; fact?: number }
      vectorFloor?: number
      rowFloor?: number
      lexicalFloor?: number
      dateCollapse?: boolean
    }
    [key: string]: unknown
  }
  /** P14 · 聊天侧日程注入开关（'off' | 'prose'；生成侧另看 modules.life.enabled） */
  life?: { promptMode?: string; [key: string]: unknown }
  /** P16 · 跨轮思考注入（只读派生，不写状态） */
  transition?: { enabled?: boolean; ttlMin?: number; maxChars?: number; [key: string]: unknown }
  persona?: {
    botName?: string
    ownerLabel?: string
    selfNickname?: string
    roleText?: string
    participation?: string
    customRules?: string
    systemPromptOverride?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** GET /api/skills 列表项（moduleManager.status 投影，src/modules/manager.js status()） */
export interface SkillEntry {
  id?: string
  name?: string
  description?: string
  version?: string
  category?: string
  kind?: string | null
  dir?: string
  hasSettings?: boolean
  loaded?: boolean
  loadError?: string
  active?: boolean
  enabled?: boolean
  available?: boolean
  code?: string | number
  reason?: string
  lastError?: string
  toolIds?: string[]
  [key: string]: unknown
}

export interface SkillsPayload {
  skills?: SkillEntry[]
  summary?: { total?: number; active?: number; disabled?: number; broken?: number; capabilities?: string[] }
  capabilities?: string[]
  uninstalled?: Array<{ id: string; enabled?: boolean; hasSettings?: boolean }>
}

/* ============================================================
   M3.5-下（分区 5-9）追加形状 —— 载荷照抄后端（src/config.js DEFAULT_CONFIG
   L220-455 / src/routes.js / src/modules/manager.js status()），字段口径同上：
   密钥字段经 sanitizeConfig 脱敏（accessToken 删除 → hasAccessToken 布尔）。
   ============================================================ */

/** GET /api/config 的 deny / 运行节奏 / 存储 / 表情包 / 桌面端段（本页用到的键） */
export interface DenyMap {
  groups?: string[]
  private?: string[]
}

export interface SendConfig {
  minGapMs?: number
  maxGapMs?: number
  maxPerMinute?: number
  maxPerHour?: number
  [key: string]: unknown
}

export interface StoreConfig {
  historyCount?: number
  promptAnchor?: { enabled?: boolean; maxExtraRead?: number; [key: string]: unknown }
  [key: string]: unknown
}

export interface StickerConfig {
  enabled?: boolean
  encourage?: number
  promptMaxStickers?: number
  [key: string]: unknown
}

export interface ServerConfig {
  port?: number
  autoStart?: boolean
  closeToTray?: boolean
  [key: string]: unknown
}

export interface UiConfig {
  theme?: string
  showVision?: boolean
  refreshMs?: number
  [key: string]: unknown
}

export interface ToolsConfig {
  enabled?: boolean
  overrides?: Record<string, boolean>
  categories?: Record<string, boolean>
  [key: string]: unknown
}

/** GET /api/tools 列表项（tool-registry listTools 投影，routes.js :1003） */
export interface ToolEntry {
  id?: string
  name?: string
  description?: string
  category?: string
  icon?: string
  defaultEnabled?: boolean
  requiresVision?: boolean
  requiresSearch?: boolean
  skillId?: string | null
}
