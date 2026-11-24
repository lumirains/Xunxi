/* ============================================================
   useChat —— web 身体聊天共享逻辑（P1，night-plan-pwa §P1）：
   从 views/Chat.vue 原样抽取（load / 发送 / 乐观插入 / mid 去重 /
   typing / 刷新在途锁 + SSE 接线），Chat.vue（桌面控制台对话页）与
   Pwa.vue（移动 chat-only 壳）两视图共用同一实现。抽取=搬运不是重写，
   W6 §9-23 六条口径逐项保持：
     ① 负数本地 id（takeLocalId 向下递增，永不与 store 正数自增 id 相撞）
     ② POST 失败撤回临时条目 + 草稿还回输入框
     ③ 发送中禁用刷新与二次发送（sending 在途锁；load 另有 loading 锁）
     ④ load 保留 mid 不在历史的 live 分条（messageId 尾部合并）
     ⑤ typing 三点行固定高（视图层 CSS min-height 承担）
     ⑥ 输入框样式口径（视图层 scoped CSS token 承担）

   cid 参数 = **存储键**（Q10 chatKey 收敛口径，'main'）：只用作 HTTP
   端点参数（GET /api/web/messages 的 cid、POST /api/web/send 的 body.cid）
   —— store 键盲单一时间线（store.js:63/94，'web:main' 与 'main' 同落一份
   main.json），routes.js:1104-1107 注释明文后端早容忍。

   SSE 过滤双形态兼容：broadcast 载荷 conversationId = orchestrator
   **路由键**（routeKeyOf = surface 前缀 + 存储键 → 'web:main'；
   orchestrator.js:45-63 明文「web adapter 的 broadcast cid 与前端 SSE
   过滤都按它」）——chat-message/chat-typing 过滤器对 'main' 与 'web:main'
   两者皆收。对真实广播形状（恒路由键）与抽取前 CID='web:main' 单值过滤
   逐字节等价；收存储键形态是 Q10 两键分离的防分裂容忍（现网广播不带
   裸存储键，容忍分支为理论面）。

   生命周期：须在视图 setup 内调用（onMounted 先 load 后 connectEvents，
   onUnmounted teardown）——复用 lib/sse.ts 唯一一条 EventSource 的禁令
   不变，两视图不同时挂载时各自独占同一条通道。

   historyLimit：历史页大小（GET limit，缺省 50 = W6 现口径）。

   P2（night-plan-pwa §P2）新增两链路（均复用既有 mid 去重机制）：
   · loadMore()——向上翻页：offset=已持有的服务端条目数（排除 pending 在途
     条目），prepend 更早一页并在渲染后做滚动位置补偿（prepend 前记录
     scrollHeight/scrollTop，差值加回=视口锚定同一内容）；loadingMore 在途锁
     防抖 + noMoreHistory 终止位（服务端返回不足一页=已到最早）。触发点在
     视图层滚动事件（Pwa.vue 滚动到顶调用；Chat.vue 不接=桌面行为零变化）。
     翻页窗口与 live 到达错位时（拉取期间又来新消息使窗口前移），重合部分由
     prepend 的 mid 去重吸收——窗口按 offset 步进在服务端「跳过最近 N 条」
     语义下连续下探，覆盖面不缺（触及最早一条后返回不足页→终止位）。
   · refreshTail()——SSE 断线恢复补拉：sse.ts onRecover（断线后重连成功）
     触发，重拉 tail（最近一页）；tail 窗口内的已持有条目让位给服务端副本
     （服务端是真相：正规 id/read 标志、断线期间漏掉的条目一并补齐），两类
     本地状态原样保留——pending 在途条目（服务端副本可能尚未落库，让位会
     闪失）与带 mediaIds 的 live 分条（29-6 既有性质：her 图片只活在广播
     mediaIds、存档 entry.media 无 id，让位=图片渲染消失）。发送中到达的
     恢复让位到发送完成后补拉（recoverPending，防在途 pending 与服务端副本
     双显）。Chat.vue 与 Pwa.vue 同享此行为（六条口径不涉：口径③的刷新锁
     语义不变，恢复补拉不写 loading 不与刷新互抢 UI）。

   P3（night-plan-pwa §P3）新增：send 可选 attachments 形参（图片暂存区随文
   发送；乐观条目带 mediaIds=缩略图即时渲染，失败经返回值让调用方还回暂存
   区）+ entryImageIds 归一渲染函数导出（live mediaIds ∪ 历史 entry.media
   双形状 → /api/media/<id> 可渲染 id 列表；仅 Pwa.vue 接入，Chat.vue 模板
   现状只消费 m.mediaIds=桌面零变化红线）。

   L5（night-plan-life §L5.1，桌面红线已解除——两视图手感同升）新增：
   · 流式打字机（§L5.1-2）：SSE 分条到达后渲染端逐字显现——live self 分条
     带 revealChars 游标，单一定时器 30ms/tick 推进（速率自适应 max(2,
     ceil(len/90))≈任意长度 2.7s 收尾）；text 本体恒完整（数据与动画分离），
     展示一律走 chatDisplayText()。停止态=finishReveals() 立即显示全文
     （后端无停止端点，停止语义=跳过动画，勘察登记）。
   · 粘性贴底（§L5.1-1，ChatDemo MessageList STICKY_THRESHOLD 语义）：
     近底 <48px 跟随、仅向上滚动停跟随；load()/send() 恒回底部（用户主动）。
   · 共享渲染列表 buildChatRenderList/fmtSepTime/chatDisplayText 导出：
     微信式时间标签 + 同发言者分组（原 Pwa.vue 私有实现平移，两视图共用）。
   ============================================================ */
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { api } from '../lib/api'
import { connectEvents, type ChatMessagePayload, type ChatTypingPayload, type EventConnection, type SseState } from '../lib/sse'
import { fmtClock, fmtTime } from '../lib/format'
import { RECALL_LINE_RE } from '../lib/types'

/** store.recent 条目投影（src/store.js :111-131 incoming 全字段；self 条目少 isPoke/atMe/atNames → 可选） */
export interface ChatEntry {
  id: number
  mid: string | null
  ts: number
  senderId: string
  senderName: string
  text: string
  self: boolean
  read?: boolean
  reply?: unknown
  media?: unknown[]
  isPoke?: boolean
  atMe?: boolean | null
  atNames?: string[]
  /** 仅本会话 live 分条携带：SSE messageId（与历史条目的 mid 同值口径） */
  messageId?: string
  /** Q6+Q8 媒体层：随消息附带的媒体（mediaStore 内容哈希 id）。live self 分条
   *  与 P3 乐观 owner 条目携带；历史条目走 media 字段（entryImageIds 归一） */
  mediaIds?: string[]
  /** V2 语音条 TTS：live self 分条的可播放语音（TTS 合成 wav 的 mediaStore
   *  内容哈希 id）；历史条目走 media=[{kind:'audio',id}]（entryAudioIds 归一） */
  audioIds?: string[]
  /** 乐观插入的临时条目（POST 返回前） */
  pending?: boolean
  /** L5 渲染端打字机游标（night-plan-life §L5.1-2）：SSE 分条到达后逐字显现。
   *  仅本会话 live self 分条携带（数值=已显现字符数）；历史条目/乐观条目/纯图
   *  分条不带（全文立即渲染）。展示文本一律走 chatDisplayText(m)——text 本体
   *  是完整数据（复制/落库口径不受动画影响），revealChars 纯展示层非存储字段。 */
  revealChars?: number
}

/* ============================================================
   L5 共享渲染列表（night-plan-life §L5.1-1）：微信式时间标签 + 同发言者
   连续分组。纯展示逻辑（不改 entries 任何状态），原为 Pwa.vue 视图内私有
   实现，L5 抽出为导出函数供 Pwa.vue（行为逐字节不变）与 Chat.vue（桌面
   新采纳——桌面红线已解除）共用。
   ChatDemo 对标点（勘察 §消息列表）：ChatDemo 全列表不渲染逐条时间戳、
   连续发言者紧凑分组——时间密度收敛到间隔时间标签（5 分钟阈值沿用 P2
   既有口径），逐条 meta 时间行随之移除。
   ============================================================ */

/** 时间标签阈值：相邻展示条目间隔 >5 分钟插入时间标签行（P2 Pwa 既有口径） */
export const CHAT_TIME_GAP_MS = 5 * 60 * 1000

/** 跨日分隔线标签（S2 设计稿二）：`今天 · 11-18` / `昨天 · 11-17` / `11-15` */
export function fmtDaySepLabel(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  const mmdd = `${p(d.getMonth() + 1)}-${p(d.getDate())}`
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === new Date().toDateString()) return `今天 · ${mmdd}`
  if (d.toDateString() === yesterday.toDateString()) return `昨天 · ${mmdd}`
  return mmdd
}

export interface ChatDaySep { kind: 'day'; ts: number; key: string }
export interface ChatTimeSep { kind: 'time'; ts: number; key: string }
export interface ChatMsgItem { kind: 'msg'; entry: ChatEntry; grouped: boolean }
export type ChatRenderItem = ChatDaySep | ChatTimeSep | ChatMsgItem

/** entries → 展示序列（跨日分隔线 + 时间标签 + 分组标记）。同发言者连续消息
 *  grouped=true（气泡间距缩小）；分隔线/时间标签之后不合并（Pwa.vue 原口径）。
 *  S2 设计稿二：跨日处插入居中日分隔线（`—— 昨天 · 11-16 ——`），该边界不再
 *  叠加 5 分钟时间标签（日分隔线携带日期，精确时刻经 hover/长按 tooltip 可考）。 */
export function buildChatRenderList(list: ChatEntry[]): ChatRenderItem[] {
  const result: ChatRenderItem[] = []
  let lastShownTs = 0
  let lastDay = ''
  let lastSelf: boolean | null = null
  const dayKey = (ts: number): string => new Date(ts).toDateString()
  for (const entry of list) {
    const day = dayKey(entry.ts)
    if (day !== lastDay) {
      result.push({ kind: 'day', ts: entry.ts, key: `day-${day}-${entry.id}` })
      lastDay = day
      lastShownTs = entry.ts
      lastSelf = null // 分隔线后不合并
    } else if (entry.ts - lastShownTs > CHAT_TIME_GAP_MS) {
      result.push({ kind: 'time', ts: entry.ts, key: `time-${entry.ts}-${entry.id}` })
      lastShownTs = entry.ts
      lastSelf = null // 时间标签后不合并
    }
    const grouped = lastSelf === entry.self
    result.push({ kind: 'msg', entry, grouped })
    lastSelf = entry.self
  }
  return result
}

/** 时间标签格式：今天显示 HH:MM，更早显示 M月D日 HH:MM（Pwa.vue 原实现平移） */
export function fmtSepTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}

/** 气泡精确时间（S2 设计稿二 hover/长按 tooltip）：今天 HH:MM:SS，
 *  更早 MM-DD HH:MM:SS（与 displayTime 的页面口径独立——tooltip 要秒级可考） */
export function fmtExactTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  const hms = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  if (d.toDateString() === new Date().toDateString()) return hms
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hms}`
}

/** 气泡展示文本：reveal 游标在途时只出已显现前缀，否则全文（纯函数，模板
 *  内直接读 entry.revealChars 建立响应依赖——游标推进即重渲染）。 */
export function chatDisplayText(m: Pick<ChatEntry, 'text' | 'revealChars'>): string {
  return m.revealChars != null ? m.text.slice(0, m.revealChars) : m.text
}

// ── T6 通话回想条（design §8.2：匹配前缀的行渲染成通话条——居中、细、带时长，
//    不渲染成她的气泡；前缀契约常量=types.ts RECALL_LINE_RE 两侧同源）──────────────

/** self 行带 [通话 M:SS] 前缀 → 返回时长（M:SS 分组 1）；否则 null（普通消息走气泡）。 */
export function callRecallDuration(text: string): string | null {
  const m = RECALL_LINE_RE.exec(String(text ?? ''))
  return m ? m[1] : null
}

/** 通话回想条正文（剥前缀后的回想内容；trim 后可能为空 → 模板不渲染正文行）。 */
export function callRecallBody(text: string): string {
  return String(text ?? '').replace(RECALL_LINE_RE, '').trim()
}

export interface UseChatOptions {
  /** 存储键（Q10 收敛口径）：HTTP 端点参数（broadcast 过滤的路由键形态由本模块按 `web:${cid}` 兼容） */
  cid: string
  /** 历史页大小（GET /api/web/messages 的 limit，缺省 50） */
  historyLimit?: number
  /** 列表容器（DOM 绑定留视图层：视图持有 ref 并绑定 `ref="listEl"`，
   *  贴底滚动逻辑在本模块；string 模板 ref 不计入 vue-tsc 使用检查，
   *  传参形态让两视图的绑定都过 noUnusedLocals） */
  listEl: Ref<HTMLDivElement | null>
}

/** 单条消息随文图片上限（P3：与后端 UPLOAD_MAX_FILES 对齐，routes.js:62） */
export const MAX_ATTACHMENTS = 10

/**
 * P3 归一渲染函数（night-plan-pwa §P3「与 self 侧 mediaIds broadcast 形状
 * 统一到同一渲染函数」/ handoff §29-6 尾）：两类形状归一为可渲染的
 * mediaStore id 列表（img src=/api/media/<id>，immutable）——
 *   · live 形状：Q6+Q8 broadcast mediaIds[]（sse.ts ChatMessagePayload；
 *     含 useChat 乐观插入条目）→ m.mediaIds；
 *   · 历史形状：P3 落库 entry.media = [{kind:'image', id}]（routes /api/web
 *     /send attachments 接线 → orchestrator submit → store.appendIncoming）。
 * 旧 QQ 直链遗留条目 {kind:'image', url}（无 id，rkey 已失效）不可渲染=跳过；
 * id 须 16-hex（MEDIA_ID_RE 口径）防脏数据。mediaIds 与 media 实际不同时出现
 *（live 条目只有 mediaIds、历史条目只有 media），mediaIds 优先即并集语义。
 * Chat.vue 模板现状只消费 m.mediaIds（历史 entry.media 在桌面不渲染=29-1
 * 现状实锚）——桌面零变化红线，本函数仅 Pwa.vue 接入。
 */
export function entryImageIds(m: Pick<ChatEntry, 'mediaIds' | 'media'>): string[] {
  if (Array.isArray(m.mediaIds) && m.mediaIds.length) {
    return m.mediaIds.map(String).filter((s) => /^[a-f0-9]{16}$/.test(s))
  }
  const media = Array.isArray(m.media) ? (m.media as Array<{ kind?: unknown; id?: unknown } | null>) : []
  const out: string[] = []
  for (const it of media) {
    const id = it?.id
    if (it?.kind === 'image' && typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)) out.push(id)
  }
  return out
}

/**
 * V0 媒体层音频化（asr-tts-v0-execution-spec §2.6）：音频 id 归一渲染函数，
 * 其余逻辑照 entryImageIds 的历史形状分支复制（kind==='audio'，16-hex 正则
 * 同款）。两类形状归一：
 *   · live 形状：V2 语音条 broadcast audioIds[]（sse.ts ChatMessagePayload；kind
 *     隐含=audio——TTS 合成恒音频，无 kind 字段可比）→ m.audioIds；
 *   · 历史形状：entry.media = [{kind:'audio', id}]（V0 入站录音 / V2 存档透传
 *     ——appendSelf media 与 appendIncoming 同款元素形状）。
 * 16-hex 正则防脏数据（entryImageIds 同款）。mediaIds 扁平数组（图片 live 广播
 * 形状）**不参与**音频判定（V0 §2.6 ⚠ 口径不变——audioIds 是 V2 的音频专用面）。
 */
export function entryAudioIds(m: Pick<ChatEntry, 'media' | 'audioIds'>): string[] {
  if (Array.isArray(m.audioIds) && m.audioIds.length) {
    return m.audioIds.map(String).filter((s) => /^[a-f0-9]{16}$/.test(s))
  }
  const media = Array.isArray(m.media) ? (m.media as Array<{ kind?: unknown; id?: unknown } | null>) : []
  const out: string[] = []
  for (const it of media) {
    const id = it?.id
    if (it?.kind === 'audio' && typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)) out.push(id)
  }
  return out
}

export function useChat(options: UseChatOptions) {
  const cid = options.cid
  const HISTORY_LIMIT = options.historyLimit ?? 50
  /** 广播载荷 conversationId 的现网形态 = orchestrator 路由键（surface 前缀 + 存储键） */
  const routeKey = `web:${cid}`
  const matchCid = (c: string): boolean => c === cid || c === routeKey

  const entries = ref<ChatEntry[]>([])
  const draft = ref('')
  const loading = ref(false)
  const loadError = ref('')
  const sendError = ref('')
  const sending = ref(false)
  const typingOn = ref(false)
  const sseState = ref<SseState>('reconnecting')
  /** P2 翻页态：loadMore 在途锁（滚动连发防抖）/ 终止位（已到最早一条） */
  const loadingMore = ref(false)
  const noMoreHistory = ref(false)
  const listEl = options.listEl

  /* ── L5 粘性贴底（night-plan-life §L5.1-1，ChatDemo MessageList.tsx:33
     STICKY_THRESHOLD 语义采纳，Vue 习语重写）：近底（<48px）跟随贴底；
     仅用户向上滚动时停止跟随（布局/内容增高不改变跟随态），滚回底部恢复。
     load()/send() 两个「用户主动」入口恒置 sticky（刷新与发送=回到底部）；
     SSE 分条到达与打字机增长只在 sticky 时贴底——上翻阅读不被新消息拽走。 */
  const STICKY_GAP = 48
  let stickyBottom = true
  let lastScrollTop = 0

  function onListScrollSticky(): void {
    const el = listEl.value
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_GAP
    if (near) {
      stickyBottom = true
    } else if (el.scrollTop < lastScrollTop) {
      stickyBottom = false // 仅向上滚才停跟随（ChatDemo MessageList.tsx:129-135 同款判定）
    }
    lastScrollTop = el.scrollTop
  }

  // listEl 由视图模板 ref 绑定（挂载赋值/卸载置 null）——随绑定变化挂/卸监听
  watch(listEl, (el, prev) => {
    prev?.removeEventListener('scroll', onListScrollSticky)
    if (el) {
      lastScrollTop = el.scrollTop
      el.addEventListener('scroll', onListScrollSticky, { passive: true })
    }
  }, { immediate: true })

  function scrollBottom(): void {
    stickyBottom = true
    void nextTick(() => {
      const el = listEl.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  /** sticky 语义贴底：SSE 分条到达/打字机增长用（只在近底时跟随） */
  function stickIfPinned(): void {
    if (!stickyBottom) return
    void nextTick(() => {
      const el = listEl.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  /* ── L5 流式打字机（night-plan-life §L5.1-2「SSE 分条到达后渲染端逐字
     显现」）：Xunxi SSE 每次广播=一条完整分条（与 ChatDemo 的 token delta
     流不同），故打字机在渲染端补出流式手感——live self 分条以 revealChars=0
     起步，单一定时器逐 tick 推进游标；text 本体恒为完整数据。速率自适应：
     revealRateOf(len)=max(2, ceil(len/90))，任意长度 ~2.7s 收尾（30ms tick），
     短消息 ≥2 字/tick 不失速。停止（stop 态按钮）=finishReveals() 立即显示
     全文，纯渲染端不动后端（后端无停止端点，勘察登记）。 */
  const REVEAL_TICK_MS = 30

  function revealRateOf(len: number): number {
    return Math.max(2, Math.ceil(len / 90))
  }

  let revealTimer: ReturnType<typeof setInterval> | undefined

  function revealTick(): void {
    let active = 0
    for (const e of entries.value) {
      if (e.revealChars == null || e.revealChars >= e.text.length) continue
      e.revealChars = Math.min(e.text.length, e.revealChars + revealRateOf(e.text.length))
      if (e.revealChars < e.text.length) active++
    }
    if (active > 0) {
      // 打字机增长撑高列表：sticky 时跟随贴底（用户上翻阅读不拽走）
      const el = listEl.value
      if (el && stickyBottom) el.scrollTop = el.scrollHeight
    } else {
      stopRevealTimer()
    }
  }

  function stopRevealTimer(): void {
    if (revealTimer !== undefined) {
      clearInterval(revealTimer)
      revealTimer = undefined
    }
  }

  function ensureRevealTimer(): void {
    if (revealTimer === undefined) revealTimer = setInterval(revealTick, REVEAL_TICK_MS)
  }

  /** 停止态按钮/发送下一句入口：所有在途 reveal 立即完成（显示全文） */
  function finishReveals(): void {
    let completed = false
    for (const e of entries.value) {
      if (e.revealChars != null && e.revealChars < e.text.length) {
        e.revealChars = e.text.length
        completed = true
      }
    }
    stopRevealTimer()
    if (completed) stickIfPinned()
  }

  /** 是否还有在途 reveal（停止态按钮显隐 + 视图可消费） */
  const revealing = computed(() =>
    entries.value.some((e) => e.revealChars != null && e.revealChars < e.text.length),
  )

  // 客户端自造条目的 id：负数向下递增，永不与 store 的正数自增 id 相撞
  let nextLocalId = 0
  function takeLocalId(): number {
    nextLocalId -= 1
    return nextLocalId
  }

  /** 历史 + live 分条合并刷新：历史是服务端真相；
   *  只有拉取期间刚到的 live 分条（messageId 不在历史里）保留在尾部。
   *  P2：整页刷新同时复位翻页态（offset 由 entries 自描述，无需额外复位；
   *  终止位复位——刷新后重新允许上翻探测）。 */
  async function load(): Promise<void> {
    loading.value = true
    loadError.value = ''
    noMoreHistory.value = false
    try {
      const data = await api<{ conversationId: string; messages: ChatEntry[] }>(
        `/api/web/messages?cid=${encodeURIComponent(cid)}&limit=${HISTORY_LIMIT}`,
      )
      const merged: ChatEntry[] = Array.isArray(data.messages) ? [...data.messages] : []
      for (const live of entries.value) {
        if (!live.messageId) continue
        if (!merged.some((m) => m.mid != null && m.mid === live.messageId)) merged.push(live)
      }
      entries.value = merged
      scrollBottom()
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  /** P2 向上翻页：拉取更早一页并 prepend，滚动位置补偿保持视口不跳。
   *  offset = 已持有的服务端条目数（排除 pending 在途条目——可能尚未落库，
   *  计入会让窗口多跳过一条真实历史；live 直达条目广播前已落库，计入）。
   *  防抖三闸：loadingMore 在途锁（滚动事件连发只放行第一发）/ loading
   *  整页刷新让位（其结果会整体重置 entries）/ noMoreHistory 终止位。 */
  async function loadMore(): Promise<void> {
    if (loadingMore.value || loading.value || noMoreHistory.value) return
    if (!entries.value.length) return
    const el = listEl.value
    loadingMore.value = true
    try {
      const offset = entries.value.filter((m) => !m.pending).length
      const data = await api<{ conversationId: string; messages: ChatEntry[] }>(
        `/api/web/messages?cid=${encodeURIComponent(cid)}&limit=${HISTORY_LIMIT}&offset=${offset}`,
      )
      // 滚动基准在响应落地后、prepend 前捕获（非发起时）：拉取期间恰有 live
      // 到达会触发既有 scrollBottom 贴底，锚到响应时刻视口=不被陈旧基准拽走
      const prevHeight = el?.scrollHeight ?? 0
      const prevTop = el?.scrollTop ?? 0
      const page = Array.isArray(data.messages) ? data.messages : []
      // 服务端返回不足一页（含空页）= start 触到最早一条 → 终止位
      if (page.length < HISTORY_LIMIT) noMoreHistory.value = true
      if (!page.length) return
      // mid 去重（现有机制同款）：翻页窗口与已持有条目重合（拉取期间又来
      // 新消息使「跳过最近 N 条」窗口前移）不再 prepend；无 mid 的存档条目
      // 按存储 id 判重（服务端 id 全表唯一）
      const fresh = page.filter((p) => !entries.value.some((e) =>
        p.mid != null
          ? e.mid === p.mid || e.messageId === p.mid
          : e.id === p.id,
      ))
      if (!fresh.length) return
      entries.value = [...fresh, ...entries.value]
      if (el) {
        // 滚动位置补偿：prepend 只在顶部增高，把新增高度加回 scrollTop
        // （nextTick 等新 DOM 落地后量 scrollHeight），视口锚定同一内容
        void nextTick(() => {
          el.scrollTop = el.scrollHeight - prevHeight + prevTop
        })
      }
    } catch {
      // 翻页失败不打断当前阅读面（loadError 只归 load() 的整页失败口径），
      // 终止位未置，下次滚动到顶自动重试
    } finally {
      loadingMore.value = false
    }
  }

  /** P2 断线恢复补拉：sse.ts onRecover（断线后重连成功）触发，重拉 tail
   *  （最近一页）合并进现有 entries——不整页重置（load() 会重置+贴底，
   *  打断阅读位置）。服务端 tail 是真相：tail 窗口内的已持有条目让位
   *  （ts 分界），pending 在途条目与带 mediaIds 的 live 分条保留（理由见
   *  头注）；mid 去重挡住保留条目与服务端副本双显。 */
  async function refreshTail(): Promise<void> {
    if (loading.value) return // 整页刷新在途让位（其结果已含最新 tail）
    try {
      const wasEmpty = entries.value.length === 0
      const data = await api<{ conversationId: string; messages: ChatEntry[] }>(
        `/api/web/messages?cid=${encodeURIComponent(cid)}&limit=${HISTORY_LIMIT}`,
      )
      const tail = Array.isArray(data.messages) ? data.messages : []
      if (!tail.length) return
      loadError.value = '' // 断线期间首拉失败的话，这次成功即清错误条
      if (wasEmpty) {
        entries.value = tail
        scrollBottom()
        return
      }
      // 保留集：窗口外更早翻页条目（ts 分界）+ pending 在途 + 带 mediaIds
      // 的 live 分条 + 打字机在途分条（让位给服务端副本会跳完动画，L5 补保
      // 留——恢复补拉不打断逐字显现）；其 mid/messageId 登记给 tail 去重
      //（副本不双显）
      const keep = entries.value.filter((e) =>
        e.pending
        || (e.messageId != null && Array.isArray(e.mediaIds) && e.mediaIds.length > 0)
        || (e.revealChars != null && e.revealChars < e.text.length)
        || e.ts < tail[0].ts,
      )
      const keptMids = new Set<string>()
      for (const e of keep) {
        if (e.mid != null) keptMids.add(e.mid)
        if (e.messageId != null) keptMids.add(e.messageId)
      }
      const incoming = tail.filter((p) => p.mid == null || !keptMids.has(p.mid))
      if (!incoming.length) return
      // ts 归并（keep 与服务端 tail 各自时间正序；同 ts 既有条目在前）
      const merged: ChatEntry[] = []
      let i = 0
      let j = 0
      const el = listEl.value
      const nearBottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 48 : false
      const prevHeight = el?.scrollHeight ?? 0
      const prevTop = el?.scrollTop ?? 0
      while (i < keep.length && j < incoming.length) {
        if (keep[i].ts <= incoming[j].ts) merged.push(keep[i++])
        else merged.push(incoming[j++])
      }
      while (i < keep.length) merged.push(keep[i++])
      while (j < incoming.length) merged.push(incoming[j++])
      entries.value = merged
      void nextTick(() => {
        if (!el) return
        if (wasEmpty || nearBottom) scrollBottom()
        else el.scrollTop = el.scrollHeight - prevHeight + prevTop // 阅读位置锚定
      })
    } catch {
      // 恢复补拉失败静默：状态点已回在线，下次恢复或手动刷新仍可补
    }
  }

  /** 恢复补拉入口：发送中到达的恢复让位到发送完成后补拉（防在途 pending
   *  与其服务端副本双显——POST 成功即落库，届时 tail 让位口径自然接管）。 */
  let recoverPending = false
  function requestTailRefresh(): void {
    if (sending.value) {
      recoverPending = true
      return
    }
    void refreshTail()
  }

  /** 乐观发送：先插入左侧临时条目，POST 成功只摘 pending 标记
   *  （真身已由 submit 同步存档，刷新即见 store id）；
   *  失败撤回临时条目、草稿还回输入框。
   *  P3（night-plan-pwa §P3）：可选 attachments（mediaStore 内容哈希 id 列表，
   *  Pwa.vue 图片暂存区传入）——非空时随 POST body 带 attachments（后端 16-hex/
   *  ≤10 校验后落 entry.media），乐观条目带 mediaIds=缩略图立即渲染
   *  （/api/media/<id>），失败随条目一并撤回（暂存区还原由调用方按返回值
   *  处理）。形参 unknown：Chat.vue 模板 `@submit.prevent="send"` 会把原生
   *  submit Event 作为首参传入（非数组=按无图处理，桌面行为零变化），
   *  Array.isArray 内校验后取用；≤MAX_ATTACHMENTS 个（与后端上限对齐）。
   *  V0 媒体层音频化（asr-tts-v0-execution-spec §2.3/§2.8）：元素支持
   *  string（图片历史形态，映射 {kind:'image', id}）与 {id, kind}（暂存区
   *  项直接透传，kind 缺省 image）；POST body 带 [{id, kind}]（后端两形态
   *  等价）。乐观条目：图片仍走 mediaIds（渲染口径不变），音频按历史形状
   *  塞 media=[{kind:'audio', id}]——entryAudioIds 只读 entry.media（spec
   *  §2.6），发送成功后刷新前音频控件也能立即可见。
   *  返回 true=POST 成功；false=早退（发送中/空载）或失败——调用方据此
   *  决定是否还回暂存区，既有消费方（Chat.vue）忽略返回值不受影响。 */
  async function send(attachments?: unknown): Promise<boolean> {
    const text = draft.value.trim()
    const list = Array.isArray(attachments) ? (attachments as unknown[]) : []
    const mediaItems = list.slice(0, MAX_ATTACHMENTS)
      .map((a) => {
        if (typeof a === 'string') return { id: a, kind: 'image' as const }
        const kind = (a as { kind?: unknown } | null)?.kind === 'audio' ? 'audio' as const : 'image' as const
        return { id: String((a as { id?: unknown } | null)?.id ?? ''), kind }
      })
      .filter((it) => /^[a-f0-9]{16}$/.test(it.id))
    if ((!text && !mediaItems.length) || sending.value) return false
    sendError.value = ''
    draft.value = ''
    const localId = takeLocalId()
    const imageIds = mediaItems.filter((it) => it.kind === 'image').map((it) => it.id)
    const audioIds = mediaItems.filter((it) => it.kind === 'audio').map((it) => it.id)
    entries.value.push({
      id: localId,
      mid: null,
      ts: Date.now(),
      senderId: 'owner',
      senderName: '我',
      text,
      self: false,
      pending: true,
      ...(imageIds.length ? { mediaIds: imageIds } : {}),
      ...(audioIds.length ? { media: audioIds.map((id) => ({ kind: 'audio', id })) } : {}),
    })
    scrollBottom()
    sending.value = true
    try {
      await api<{ ok?: boolean; silent?: boolean }>('/api/web/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid, text, ...(mediaItems.length ? { attachments: mediaItems } : {}) }),
      })
      const sent = entries.value.find((m) => m.id === localId)
      if (sent) sent.pending = false
      return true
    } catch (e) {
      entries.value = entries.value.filter((m) => m.id !== localId)
      draft.value = text
      sendError.value = e instanceof Error ? e.message : String(e)
      return false
    } finally {
      sending.value = false
      // P2：发送期间到达的 SSE 恢复在此补拉（requestTailRefresh 的让位队列）
      if (recoverPending) {
        recoverPending = false
        void refreshTail()
      }
    }
  }

  /** AI 分条到达：收三点动画 → messageId 去重 → 追加到尾部。
   *  L5 打字机：有正文的 self 分条以 revealChars=0 起步逐字显现（纯图分条
   *  立即渲染）；贴底改为 sticky 语义（上翻阅读不被新分条拽走——ChatDemo
   *  MessageList 跟随判定，桌面/移动手感同升）。 */
  function handleChatMessage(d: ChatMessagePayload): void {
    if (!matchCid(d.conversationId)) return
    typingOn.value = false
    const mid = String(d.messageId ?? '')
    if (!mid) return
    if (entries.value.some((m) => (m.mid != null && m.mid === mid) || m.messageId === mid)) return
    const text = String(d.text ?? '')
    entries.value.push({
      id: takeLocalId(),
      mid,
      ts: Number(d.ts) || Date.now(),
      senderId: 'self',
      senderName: '我',
      text,
      self: true,
      messageId: mid,
      mediaIds: Array.isArray(d.mediaIds) ? d.mediaIds.map(String).filter(Boolean) : undefined,
      // V2 语音条：可播放语音随分条即时渲染（audioIds→entryAudioIds live 形状；
      // 存档侧同 id 落 media，刷新后走历史形状仍在）
      audioIds: Array.isArray(d.audioIds) ? d.audioIds.map(String).filter(Boolean) : undefined,
      ...(text ? { revealChars: 0 } : {}),
    })
    if (text) ensureRevealTimer()
    stickIfPinned()
  }

  function handleChatTyping(d: ChatTypingPayload): void {
    if (!matchCid(d.conversationId)) return
    typingOn.value = d.on !== false
  }

  let conn: EventConnection | undefined

  onMounted(() => {
    void load()
    conn = connectEvents({
      onChatMessage: handleChatMessage,
      onChatTyping: handleChatTyping,
      onStateChange: (state) => { sseState.value = state },
      onRecover: requestTailRefresh, // P2：断线恢复 → 重拉 tail 按 mid 去重合并
    })
  })
  onUnmounted(() => {
    conn?.disconnect()
    conn = undefined
    stopRevealTimer() // L5：打字机定时器随视图卸载收掉（组件销毁不留句柄）
    listEl.value?.removeEventListener('scroll', onListScrollSticky)
  })

  /** 显示时间：今天的只显示时钟，更早的带日期（Events.vue 同口径） */
  function displayTime(ts: number): string {
    const d = new Date(ts)
    return d.toDateString() === new Date().toDateString() ? fmtClock(ts) : fmtTime(ts)
  }

  return {
    /** 存储键（视图列表 key 用；与 options.cid 同值） */
    cid,
    entries,
    draft,
    loading,
    loadError,
    sendError,
    sending,
    typingOn,
    sseState,
    /** P2 翻页态：loadMore 在途锁（视图可挂提示）/ 终止位（已到最早一条） */
    loadingMore,
    noMoreHistory,
    load,
    /** P2 向上翻页（视图滚动到顶触发；Chat.vue 不接=桌面行为零变化） */
    loadMore,
    send,
    /** S2 设计稿二：手动重连一次（顶栏状态点点击，替代原「刷新」按钮语义） */
    reconnect: () => conn?.reconnect(),
    displayTime,
    /** L5 打字机：是否有在途逐字显现（停止态按钮显隐） */
    revealing,
    /** L5 停止态：立即完成所有在途 reveal（显示全文，纯渲染端） */
    finishReveals,
  }
}
