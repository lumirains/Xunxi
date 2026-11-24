<script setup lang="ts">
// ============================================================
// PWA 移动聊天壳（P1，night-plan-pwa §P1 / §1 产品形态定稿）：
//   · chat-only：无 SideNav / 顶栏 / StatusRail——App.vue 按路由名（'pwa'）
//     豁免 AppLayout 直接渲染本视图；AuthOverlay 保持 App 级平级挂载，
//     登录浮层自动继承（R2 / handoff §29-3 前提）。
//   · 顶部极简条 = 「Xunxi」+ 连接状态点三态（P2 落地：在线=陶橙定住 /
//     连接中=基色脉冲 / 离线=次级灰定住；连续失败≥3 次转离线，恢复自动
//     补拉 tail）；数据链路 = useChat 共享 composable
//     （与 Chat.vue 同实现同口径，cid='main' 存储键，Q10 收敛口径）。
//   · 向上翻页（P2）：列表滚动到顶（≤40px）触发 useChat.loadMore——
//     offset 递增取更早一页、prepend + scrollHeight 差值补偿保持滚动位置、
//     在途锁防抖；触发点只在 Pwa 视图（Chat.vue 不接=桌面行为零变化）。
//   · 软键盘适配：基高 100vh→100dvh（浏览器 UI 收展跟随），visualViewport
//     resize → 壳高跟随可视视口（键盘弹出即收缩）+ 贴底保持（列表本就
//     贴底时才跟随，用户上翻阅读不被拽走）；env(safe-area-inset-*) 预留
//     刘海/手势条——viewport-fit=cover 在 P4 落 index.html，此前 env() 回退
//     0px 无副作用（布局视口本就避开刘海）。
//   · textarea 自适应 1-5 行（JS autoGrow：height=auto→min(scrollHeight,
//     5 行上限)；回车发送 / Shift+回车换行 / 输入法组字回车不上屏）。
//   · 深浅色跟随系统：prefers-color-scheme → 根元素 data-theme（D50 换肤
//     协议只切属性，tokens.css 现有变量组整组生效）；不读写 localStorage，
//     不覆盖桌面顶栏「亮暗切换」的显式选择语义。
//   · 图片收发闭环（P3，night-plan-pwa §P3）：图片按钮 → input[type=file]
//     （accept=image/* multiple，≤10 张与后端 UPLOAD_MAX_FILES 对齐）→ 逐张
//     POST /api/web/upload → mediaId 暂存区（缩略图预览/可移除）→ 随文本发送
//     （useChat.send 可选 attachments 形参 → 后端 16-hex 校验落 entry.media）
//     → 乐观缩略图（/api/media/<id>）→ 发送失败撤回乐观条目并还回暂存区
//     （id 已上传仍可重发）。历史消息按 entry.media 与 live mediaIds 归一到
//     同一渲染函数 entryImageIds（useChat 导出；L5 起桌面 Chat.vue 亦接入）。
//     错误提示条可点重试/清除（发送中不重试=口径③）。
//   · L5（night-plan-life §L5.1，ChatDemo 对标——桌面红线已解除，两视图手
//     感同升）：
//     - 上传/暂存逻辑抽取进 composables/useUploads.ts（与 Chat.vue 共用，
//       行为逐项保持），新增粘贴入口（textarea onPaste → addFiles）。
//     - 流式打字机（§L5.1-2）：SSE 分条到达后逐字显现（useChat reveal
//       游标），发送↔停止态互换，停止=finishReveals() 立即显示全文。
//     - 时间标签/分组渲染抽为 useChat.buildChatRenderList 共享（行为逐字节
//       同原私有实现）。
//     - 移动端细节（§L5.1-5）：整页触摸滚动锁 + visualViewport 缩放守卫 +
//       列表 overscroll-behavior: contain。
//   · 整页触摸滚动锁 adapted from DeepSeek chat-demo src/app/viewport.ts
//     preventPageScroll（MIT License · Copyright (c) 2026 DeepSeek）——
//     Vue/TS 习语重写。
// ============================================================
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  buildChatRenderList, callRecallBody, callRecallDuration, chatDisplayText, entryAudioIds, entryImageIds, fmtDaySepLabel, fmtExactTime, fmtSepTime, useChat,
} from '../composables/useChat'
import { useUploads } from '../composables/useUploads'
import { useVoiceRec } from '../composables/useVoiceRec'
import { useVoiceCall } from '../composables/useVoiceCall'
import AudioBubblePlayer from '../components/AudioBubblePlayer.vue'
import { applyTheme } from '../design/theme'
import type { VoiceConfig } from '../lib/types'

// self: true = Xunxi（AI），self: false = 用户（owner）——
// Pwa 视图：用户消息靠右（!m.self），Xunxi消息靠左（m.self）。
// L5：时间标签/分组渲染抽为 useChat.buildChatRenderList 共享（原私有实现
// 平移，行为逐字节同口径；Chat.vue 桌面同采纳）。
const renderList = computed(() => buildChatRenderList(entries.value))

// 列表容器（DOM 绑定留视图层：模板 `ref="listEl"` 持有；贴底滚动在 useChat，
// 键盘弹出时的贴底保持在本视图 syncViewport）
const listEl = ref<HTMLDivElement | null>(null)

const {
  entries, draft, loading, loadError, sendError, sending, typingOn, sseState,
  loadingMore, cid, revealing, load, loadMore, send, finishReveals, reconnect,
} = useChat({ cid: 'main', listEl })

// ── S2 设计稿二：长按气泡显示精确时间（桌面 hover 的移动面等价交互）──
// touchstart 起 450ms 计时 → 该气泡加 .show-time（CSS tooltip 同桌面 hover
// 共用一套 ::after）；touchmove（滚动）/touchend/touchcancel 即取消。
const showTimeId = ref<number | null>(null)
let pressTimer: number | undefined

function onBubblePressStart(id: number): void {
  cancelBubblePress()
  pressTimer = window.setTimeout(() => {
    pressTimer = undefined
    showTimeId.value = id
  }, 450)
}

function cancelBubblePress(): void {
  if (pressTimer !== undefined) {
    window.clearTimeout(pressTimer)
    pressTimer = undefined
  }
}

function endBubblePress(): void {
  cancelBubblePress()
  showTimeId.value = null
}

// ── P2 向上翻页：滚动到顶加载更早一页（触发点只在 Pwa 视图——Chat.vue 不
//    接滚动监听=桌面行为零变化红线）。loadMore 自带三重防抖（loadingMore
//    在途锁 / loading 整页刷新让位 / noMoreHistory 终止位），滚动事件连发
//    只放行第一发；prepend + scrollHeight 差值补偿在 composable 内完成，
//    视口锚定同一内容不跳动。
const TOP_LOAD_THRESHOLD = 40 // px：距顶 ≤40px 即触发（≈滚到顶即拉）

function onListScroll(): void {
  const el = listEl.value
  if (!el || el.scrollTop > TOP_LOAD_THRESHOLD) return
  void loadMore()
}

// ── 连接状态点三态（P2）：在线=苔绿定住 / 连接中=基色脉冲 / 离线=次级灰
//    定住（token 纯净：不引入色板外颜色）。离线语义=连续失败≥3 次；恢复
//    （重连成功）自动回在线并触发 useChat 补拉 tail。S2 设计稿二：点击=
//    手动重连一次（hover/长按出"点击重连"提示）。
const dotTitle = computed(() =>
  sseState.value === 'connected'
    ? '实时已连接 · 点击重连'
    : sseState.value === 'offline'
      ? '实时连接已离线 · 点击重连'
      : '实时连接中… · 点击重连',
)

// ── 深浅色跟随系统（现有 token 变量，D50 换肤协议）──────────────────
const systemDark: MediaQueryList | undefined =
  typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined

function applySystemTheme(): void {
  applyTheme(systemDark?.matches ? 'dark' : 'light')
}

// ── 软键盘适配（100dvh 基高 + visualViewport 高度跟随 + 贴底保持）────
const shellHeight = ref('100dvh')
/** 键盘弹起判定：可视视口显著矮于窗口高（120px≈最小键盘高减余量）——
 *  iOS：innerHeight 不随键盘变、vv.height 变 → 判定成立；
 *  Android：两者同缩 → 判定不成立（dvh/壳高已跟随，等价效果）。 */
const keyboardOpen = ref(false)

function syncViewport(): void {
  const vv = window.visualViewport
  if (!vv) return
  // 双指缩放交由浏览器处理，不与缩放动画抢布局（ChatDemo viewport.ts:63-65
  // 同口径守卫——scale≠1 时跳过本轮视口调整，缩放复位后 resize 自然恢复）
  if (vv.scale !== 1) return
  shellHeight.value = `${Math.round(vv.height)}px`
  keyboardOpen.value = vv.height < window.innerHeight - 120
  window.scrollTo(0, 0) // iOS 聚焦上推整页后复位（页面级恒置顶，滚动全在列表内部）
  // 贴底保持：仅当列表本来就贴底时跟随贴底（阈值 48px≈一行气泡高）
  const el = listEl.value
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 48) {
    el.scrollTop = el.scrollHeight
  }
}

// ── textarea 自适应 1-5 行 ─────────────────────────────────────
const inputEl = ref<HTMLTextAreaElement | null>(null)
/** 5 行上限 ≈ line-height 22.4px（16px×1.4）×5 + 上下 padding 6px×2 → 124.4，取 126
 *  （与 CSS max-height 同值双保险：JS 量高被截断时滚动条接管） */
const INPUT_MAX_H = 126

function autoGrow(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_H)}px`
}

// 草稿变化（输入/清空）都重算高度；nextTick 等程序化清空先落到 DOM
watch(draft, () => { void nextTick(autoGrow) })

// ── 整页触摸滚动锁（L5 §L5.1-5，adapted from DeepSeek chat-demo
//    src/app/viewport.ts preventPageScroll，MIT License · Copyright (c) 2026
//    DeepSeek，TS 习语重写）：touchmove preventDefault 阻止 iOS 整页橡皮筋
//    滚动；事件靶沿 DOM 上溯到第一个可滚动元素即放行（列表滚动与双指缩放
//    不受影响）。壳层 100dvh 后整页本不应滚动，iOS 地址栏收展仍可能拖动
//    body——此锁兜底。
function preventPageScroll(e: TouchEvent): void {
  if (e.touches.length !== 1) return
  for (
    let el = e.target instanceof Element ? e.target : null;
    el && el !== document.body;
    el = el.parentElement
  ) {
    const style = getComputedStyle(el)
    const scrollsY = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight
    const scrollsX = /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth
    if (scrollsY || scrollsX) return
  }
  e.preventDefault()
}

/** 回车发送 / Shift+回车换行；输入法组字中的回车不上屏（isComposing） */
function onEnter(e: KeyboardEvent): void {
  if (e.shiftKey || e.isComposing) return
  e.preventDefault()
  void submitChat()
}

// ── P3→L5 图片收发：选图/粘贴 → 逐张 POST /api/web/upload → mediaId 暂存区
//    上传/暂存逻辑 L5 抽取进 composables/useUploads.ts（与 Chat.vue 桌面共
//    用，行为逐项保持）；本视图保留 DOM 面（file input 复位/图片按钮/粘贴
//    事件接线）。发送时随文本一起（useChat.send 的可选 attachments 形参）；
//    乐观条目带 mediaIds=缩略图即时渲染；发送失败撤回乐观条目并把暂存区还
//    回（id 已上传，重发不必重传）。
const {
  staged, uploadError, uploading, addFiles, removeStaged, clearError, mediaFilesOf,
} = useUploads()
const fileInput = ref<HTMLInputElement | null>(null)

// ── S6 按住说话（asr-tts-design §2.1 站① / 一期3）：MediaRecorder 录音
//    → V0 上传链路 → send 独立成条（录音/手势/上传逻辑在 useVoiceRec，与
//    Chat.vue 共用）。非安全上下文（非 HTTPS/localhost）无 getUserMedia，
//    按钮不出现——iOS PWA 真机验收前提见 handoff-voice-walkie。
const {
  voiceSupported, voiceActive, voiceNote, voiceIsError,
  recState, cancelPending, pressStart, clearVoiceError,
} = useVoiceRec({ send, draft })

// ── T3 电话模式（V2 前半场，night-plan §2-T3）：通话覆盖层 + 独立 WS
//    /api/voice（D16；状态机/播放/换档全在 useVoiceCall，与 Chat.vue 同实现）。
//    入口=输入栏电话按钮（微信式「+」面板=T7；voice.enabled&&voice.call.enabled
//    关闭时禁用不假装能拨——T7 口径一致）。start() 必须在点击手势内调用
//    （iOS AudioContext 解锁前提，design §13.1-③）。
const {
  callState, callError, callHint, callSeconds, audioBlocked, micOpen, statusText, fallbackLines,
  start, sendText, hangup, resumeAudio, dismiss,
} = useVoiceCall()

/** /api/config 的 voice 段（T7 D19：入口闸从开关布尔升级为"开关面+引擎配置面"
 *  两级——§10.2-4 双引擎均未配置=入口置灰给原因；call.enabled=false=显示「开发中」
 *  不假装能拨） */
const voiceCfg = ref<VoiceConfig | null>(null)

/** 开关面：voice.enabled && voice.call.enabled（与服务端握手闸 call.js 同面——
 *  关=「开发中」+握手本就 404） */
const callSwitchOk = computed(() =>
  voiceCfg.value?.enabled === true && voiceCfg.value?.call?.enabled === true)

/** 引擎配置面（§10.2 降级链的入口级判据，Chat.vue 同实现）：ASR/TTS 任一配了
 *  引擎+baseUrl 即可拨；双边皆缺=纯文字对纯文字=普通聊天 → 置灰给原因 */
function engineCfgd(e?: { engine?: string; baseUrl?: string }): boolean {
  return !!e && String(e.engine ?? 'off') !== 'off' && !!String(e.baseUrl ?? '').trim()
}
/** 通话入口闸（电话项 disabled 依据）：开关面 + 引擎任一在册 */
const voiceGateOk = computed(() =>
  callSwitchOk.value && (engineCfgd(voiceCfg.value?.asr) || engineCfgd(voiceCfg.value?.tts)))

/** 通话内文字草稿（与消息 draft 分离——通话逐句不进 messages，D15/D17） */
const callDraft = ref('')

// ── 她的名字与头像（2026-11-21：读配置 persona.botName，缺省"汐"；UI 不写死）────
const botName = ref('汐')
const avatarSrc = ref('/icons/avatar-128.png')
async function loadBotIdentity(): Promise<void> {
  try {
    const res = await fetch('/api/person/state', { headers: { Accept: 'application/json' } })
    if (!res.ok) return
    const s = await res.json() as { botName?: string; avatarTs?: number }
    if (s.botName?.trim()) botName.value = s.botName.trim()
    if (s.avatarTs) avatarSrc.value = `/api/avatar?v=${s.avatarTs}`
  } catch { /* 缺省"汐"即可，不拖垮 PWA */ }
}

/** 电话项 title：闸关=禁用+说明（T7「不假装能拨」口径），开=可拨 */
const phoneTitle = computed(() => {
  if (!callSwitchOk.value) return '电话（开发中）：设置 → 语音电话打开后可拨打'
  if (!voiceGateOk.value) return '语音引擎未配置（ASR/TTS 均未启用），暂不可拨打'
  return `给${botName.value}打个电话（她语音说话，你说话或打字）`
})
/** 电话项可见标签（T7：call.enabled=false 显示「开发中」；引擎未配置显示原因级标签） */
const phoneLabel = computed(() => {
  if (!callSwitchOk.value) return '电话（开发中）'
  if (!voiceGateOk.value) return '电话（引擎未配置）'
  return '电话'
})

// ── T7 D19 微信式「+」面板（design §2.4 / night-plan §2-T7.1，Chat.vue 同实现）：
//    点+上方展开【图片、电话】；点外部/再点+/Esc 收起；打开面板失焦收软键盘
//   （移动端软键盘跟随焦点，blur 即收）。麦克风不进面板（常驻触摸目标）。 ─────
const plusOpen = ref(false)
const plusPanel = ref<HTMLElement | null>(null)
const plusBtn = ref<HTMLButtonElement | null>(null)

function togglePlus(): void {
  plusOpen.value = !plusOpen.value
  if (plusOpen.value) {
    // 打开面板收软键盘：失焦当前输入框
    const el = document.activeElement as HTMLElement | null
    el?.blur?.()
  }
}
function closePlus(): void {
  plusOpen.value = false
}
function onPanelImages(): void {
  closePlus()
  pickImages()
}
function onPanelCall(): void {
  if (!voiceGateOk.value) return   // 禁用态按钮本点不动，双保险
  closePlus()
  openCall()
}
/** Esc 收起（挂 document：面板不一定持焦点） */
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && plusOpen.value) closePlus()
}
/** 点外部收起（+钮与面板内不收——+再点由 togglePlus 自己翻回） */
function onDocPointerdown(e: PointerEvent): void {
  if (!plusOpen.value) return
  const t = e.target as Node | null
  if (!t) return
  if (plusPanel.value?.contains(t) || plusBtn.value?.contains(t)) return
  closePlus()
}

/** 呼叫（点击手势内：AudioContext 创建+resume 须同步发生在手势任务里） */
function openCall(): void {
  if (!voiceGateOk.value) return
  void start()
}

/** 覆盖层文字发送（V2 唯一输入面：文字进 → 她说话；发送成功清草稿） */
function submitCall(): void {
  const t = callDraft.value
  if (!t.trim()) return
  if (sendText(t)) callDraft.value = ''
}

// ── W1 通话覆盖层语音回复开关（与 Chat.vue 同实现）：voice.tts.enabled 即时
//    POST /api/config（初值读 voiceCfg）；服务端逐句现读闸，改后下一句起生效
//    ——callHint 给生效时点提示。 ──
const voiceReplyBusy = ref(false)

async function toggleCallVoiceReply(): Promise<void> {
  if (voiceReplyBusy.value) return
  voiceReplyBusy.value = true
  try {
    const next = !(voiceCfg.value?.tts?.enabled !== false)
    const r = await saveConfigPatch({ voice: { tts: { enabled: next } } })
    if (r.config?.voice) voiceCfg.value = r.config.voice
    callHint.value = voiceCfg.value?.tts?.enabled !== false
      ? '语音回复已开：她的下一句起恢复语音（引擎冷启时稍等一拍）'
      : '语音回复已关：她的下一句起改为文字'
  } catch {
    callHint.value = '语音回复开关没存上，再试一次'
  } finally {
    voiceReplyBusy.value = false
  }
}

/** 通话时长显示 M:SS（与回想行 [通话 M:SS] 前缀同口径的展示） */
const callDurText = computed(() => {
  const s = Math.max(0, callSeconds.value)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})

// ── 晚安整理按钮（2026-11-15，night-plan-life §L1 的手机端入口）：聊完点一下 =
//    记忆卡 → 私密日记 → 明日日程依次整理（后端过期/幂等感知：已是最新则跳过）。
//    S2 设计稿六（Bug2 反馈断链修复，2026-11-18）：结果=常驻三段明细
//    （卡片✓/日记✓/明日日程✓，各带一句状态，不再 8s 淡出；点按提示条清除）；
//    同时经 eveningBus 广播（桌面 StatusRail 订阅渲染常驻明细）+ nudge 状态栏
//    立即补刷。传输异常（无结构化结果）仍走同条提示条（点按清除）。
import { fetchConfig, runEveningReflection, saveConfigPatch } from '../lib/api'
import { badgeMark, badgesOf, publishEveningResult } from '../lib/eveningBus'
import { nudgeStatus } from '../lib/statusNudge'
const eveningLoading = ref(false)
const eveningMsg = ref('')
async function runGoodnight(): Promise<void> {
  if (eveningLoading.value) return
  eveningLoading.value = true
  eveningMsg.value = ''
  try {
    const r = await runEveningReflection()
    publishEveningResult(r)
    nudgeStatus()
    eveningMsg.value = badgesOf(r)
      .map((b) => `${b.label} ${badgeMark(b.state)}${b.note ? ` ${b.note}` : ''}`)
      .join(' · ')
  } catch (e) {
    eveningMsg.value = `整理失败：${String((e as Error)?.message ?? e)}`
  } finally {
    eveningLoading.value = false
  }
}

/** 晚安结果提示条点按 = 清除（常驻不自动淡出后的唯一收起入口） */
function clearEveningMsg(): void {
  eveningMsg.value = ''
}

/** 图片按钮 → 打开文件选择（accept/multiple 在 input 属性上） */
function pickImages(): void {
  fileInput.value?.click()
}

/** 选图落地：input 复位允许连选同一文件；逐张上传进暂存区（useUploads） */
async function onFilesPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  await addFiles(files)
}

/** 粘贴图片/音频（L5 补差）：仅当剪贴板带媒体文件时拦截默认粘贴（纯文本粘贴
 *  不受影响），走与选图同一上传链。 */
function onPaste(e: ClipboardEvent): void {
  const files = mediaFilesOf(Array.from(e.clipboardData?.files ?? []))
  if (!files.length) return
  e.preventDefault()
  void addFiles(files)
}

/** 发送（文本 + 暂存媒体）：先取走暂存项（发送中不再出现暂存条与气泡缩略
 *  图双显），发送失败（send 返回 false）按原序整项还回暂存区供重试
 *  （id 已上传，url 直接可预览）。发送即完成上一条的逐字显现（L5 打字机，
 *  不打断回话动线）。V0 音频（spec §2.8）：暂存项带 kind 以 { id, kind }
 *  形态透传（useChat.send → 后端，string 形态仍等价 image）。 */
async function submitChat(): Promise<void> {
  if (revealing.value) finishReveals()
  const items = [...staged.value]
  const payload = items.map((s) => ({ id: s.id, kind: s.kind }))
  staged.value = []
  const sent = await send(payload)
  if (!sent) staged.value = [...items, ...staged.value]
}

/** 提示条点击：历史加载失败→重试（发送中禁重试=口径③）；语音错误清除；
 *  否则清除上传错误提示（其余在途文案无交互）。 */
function onNoteClick(): void {
  if (loadError.value) {
    if (!sending.value) void load()
    return
  }
  if (voiceIsError.value) {
    clearVoiceError()
    return
  }
  clearError()
}

onMounted(() => {
  void loadBotIdentity()
  applySystemTheme()
  systemDark?.addEventListener('change', applySystemTheme)
  window.visualViewport?.addEventListener('resize', syncViewport)
  syncViewport()
  // L5：整页触摸滚动锁（preventPageScroll，viewport.ts 模式见上方注释）
  document.addEventListener('touchmove', preventPageScroll, { passive: false })
  lockPortrait()
  registerServiceWorker()
  // T7「+」面板：Esc 收起 + 点外部收起（挂 document，面板不持焦点也能收）
  document.addEventListener('keydown', onDocKeydown)
  document.addEventListener('pointerdown', onDocPointerdown)
  // T7 通话入口闸：/api/config 实读 voice 段全量（失败=闸关，电话项禁用不假装能拨）
  void fetchConfig()
    .then((c) => { voiceCfg.value = c?.voice ?? null })
    .catch(() => { voiceCfg.value = null })
})

// ── T1 竖屏锁定（night-plan §2-T1-1）：Android Chrome/installed PWA 生效；
//    iOS Safari 无 screen.orientation.lock API（系统限制，如实登记）——横屏
//    兜底=布局本身横屏不破（.pwa-shell 列向 flex + .pwa-list flex:1 收缩），
//    不做横屏专版。lock 在 Chrome 需页面已进全屏，否则 Promise 拒绝（未全屏
//    的普通 PWA 页常见）——静默，不打断主链路。
function lockPortrait(): void {
  try {
    const lock = (screen.orientation as ScreenOrientation & {
      lock?: (o: 'portrait') => Promise<void>
    })?.lock
    void lock?.('portrait')?.catch(() => { /* 未全屏/系统不支持：静默 */ })
  } catch { /* 无 orientation API（iOS Safari）：静默 */ }
}

// ── P4：Service Worker 注册（/pwa 挂载时，night-plan-pwa §P4）。生产才注册
//    （import.meta.env.DEV 跳过——dev 走 vite 代理/热更，public/sw.js 会被
//    dev server 以 200 回给 /sw.js 造成污染注册）；注册失败静默（SW 只是
//    离线增强，不因它打断聊天主链路；HTTPS/localhost 之外的源浏览器本身拒装）。
function registerServiceWorker(): void {
  if (import.meta.env.DEV) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/sw.js').catch(() => { /* 离线增强失败可忽略 */ })
}
onUnmounted(() => {
  systemDark?.removeEventListener('change', applySystemTheme)
  window.visualViewport?.removeEventListener('resize', syncViewport)
  document.removeEventListener('touchmove', preventPageScroll)
  document.removeEventListener('keydown', onDocKeydown)
  document.removeEventListener('pointerdown', onDocPointerdown)
})
</script>

<template>
  <div class="pwa-shell" :class="{ 'kb-open': keyboardOpen }" :style="{ height: shellHeight }">
    <!-- ── 顶部极简条：头像 + 名字 + 状态点 ── -->
    <header class="pwa-top">
        <div class="pwa-top-left">
          <img class="pwa-avatar" :src="avatarSrc" alt="" aria-hidden="true" />
          <div class="pwa-top-info">
            <h1 class="pwa-title">{{ botName }}</h1>
          <span
            class="pwa-status-text"
            :class="{ on: sseState === 'connected', off: sseState === 'offline' }"
          >{{ sseState === 'connected' ? '在线' : sseState === 'offline' ? '离线' : '连接中…' }}</span>
        </div>
      </div>
      <button
        class="pwa-goodnight"
        type="button"
        :disabled="eveningLoading"
        title="整理今晚的记忆卡与日记"
        @click="runGoodnight"
      >{{ eveningLoading ? '整理中…' : '🌙 晚安整理' }}</button>
      <button
        type="button"
        class="pwa-dot"
        :class="{ on: sseState === 'connected', off: sseState === 'offline' }"
        :title="dotTitle"
        aria-label="连接状态（点击重连）"
        @click="reconnect"
      ></button>
    </header>

    <!-- 晚安整理结果（S2 设计稿六：常驻三段明细，点按清除） -->
    <transition name="note-fade">
      <p v-if="eveningMsg" class="pwa-note" @click="clearEveningMsg">{{ eveningMsg }}</p>
    </transition>

    <!-- 错误/读取提示条（仅异常/在途时出现） -->
    <transition name="note-fade">
      <p
        v-if="loadError || sendError || uploadError || voiceNote || loading || loadingMore || uploading"
        class="pwa-note"
        :class="{ err: loadError || sendError || uploadError || voiceIsError, warn: loadingMore || uploading || (!!voiceNote && !voiceIsError) }"
        @click="onNoteClick"
      >
        <span class="pwa-note-icon" aria-hidden="true">
          <template v-if="loadError || sendError || uploadError || voiceIsError">⚠</template>
          <template v-else>⋯</template>
        </span>
        <template v-if="loadError">{{ loadError }}（点击重试）</template>
        <template v-else-if="sendError">发送失败：{{ sendError }}</template>
        <template v-else-if="voiceIsError">{{ voiceNote }}（点击清除）</template>
        <template v-else-if="voiceNote">{{ voiceNote }}</template>
        <template v-else-if="uploadError">{{ uploadError }}（点击清除）</template>
        <template v-else-if="loadingMore">加载更早中…</template>
        <template v-else-if="loading">读取中…</template>
        <template v-else>图片上传中…</template>
      </p>
    </transition>

    <!-- 消息列表 -->
    <div ref="listEl" class="pwa-list" @scroll="onListScroll">
      <!-- 空状态 -->
      <div v-if="!entries.length && !loading" class="chat-empty">
        <p class="chat-empty-hint">和{{ botName }}说点什么吧</p>
      </div>

      <transition-group name="msg-in" tag="div" class="pwa-list-inner">
        <template v-for="item in renderList" :key="item.kind === 'msg' ? `${cid}-${item.entry.id}` : item.key">
          <!-- 跨日居中分隔线（S2 设计稿二）：—— 昨天 · 11-16 —— -->
          <div v-if="item.kind === 'day'" class="day-sep">
            <span>{{ fmtDaySepLabel(item.ts) }}</span>
          </div>
          <!-- 微信式时间标签 -->
          <div v-else-if="item.kind === 'time'" class="time-sep">
            <span>{{ fmtSepTime(item.ts) }}</span>
          </div>

          <!-- 消息行：!m.self = 用户 = 右侧；m.self = Xunxi = 左侧 -->
          <div
            v-else
            class="chat-row"
            :class="{
              'is-owner': !item.entry.self,
              'is-grouped': item.grouped,
            }"
          >
            <!-- T6 通话回想条（design §8.2）：self 行带 [通话 M:SS] 前缀 → 居中细条
                 带时长，非气泡（无长按手势——回想行非对话内容，无需精确时间交互） -->
            <div
              v-if="item.entry.self && callRecallDuration(item.entry.text)"
              class="call-recall-bar"
            >
              <span class="call-recall-head">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 5c0-1 1-2 2-2h2c.8 0 1.5.5 1.8 1.3l.9 2.6c.2.7 0 1.5-.6 2l-1.3 1a12.5 12.5 0 0 0 5.3 5.3l1-1.3c.5-.6 1.3-.8 2-.6l2.6.9c.8.3 1.3 1 1.3 1.8v2c0 1-1 2-2 2A16.9 16.9 0 0 1 4 5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                </svg>
                <span>通话 {{ callRecallDuration(item.entry.text) }}</span>
              </span>
              <span v-if="callRecallBody(item.entry.text)" class="call-recall-text">{{ callRecallBody(item.entry.text) }}</span>
            </div>
            <!-- 气泡（S2 设计稿二：长按显示精确时间） -->
            <div
              v-else
              class="bubble"
              :class="{
                'bubble-owner': !item.entry.self,
                'bubble-her': item.entry.self,
                pending: item.entry.pending,
                'show-time': showTimeId === item.entry.id,
              }"
              :data-time="fmtExactTime(item.entry.ts)"
              @touchstart="onBubblePressStart(item.entry.id)"
              @touchmove="cancelBubblePress"
              @touchend="endBubblePress"
              @touchcancel="endBubblePress"
            >
              <!-- W1 媒体层音频化·自绘播放键：置于句子前面（文本行上方独立一行，
                   与 Chat.vue 同款组件；弃 <audio controls> 原生控件） -->
              <div v-if="entryAudioIds(item.entry).length" class="bubble-audio">
                <AudioBubblePlayer
                  v-for="id in entryAudioIds(item.entry)"
                  :key="id"
                  :src="`/api/media/${id}`"
                />
              </div>
              <p v-if="item.entry.text" class="bubble-text">{{ chatDisplayText(item.entry) }}</p>
              <!-- P3 媒体层 -->
              <div v-if="entryImageIds(item.entry).length" class="bubble-media">
                <img
                  v-for="id in entryImageIds(item.entry)"
                  :key="id"
                  :src="`/api/media/${id}`"
                  alt="图片消息"
                  loading="lazy"
                />
              </div>
              <!-- 发送中标记（时间已移出气泡，只保留「发送中」状态） -->
              <span v-if="item.entry.pending" class="bubble-pending-badge">发送中…</span>
            </div>
          </div>
        </template>
      </transition-group>
    </div>

    <!-- typing 三点气泡 -->
    <div class="pwa-typing-row" aria-live="polite">
      <transition name="typing-fade">
        <div v-if="typingOn" class="typing-bubble" title="她正在输入…">
          <span class="typing">
            <i></i><i></i><i></i>
          </span>
        </div>
      </transition>
    </div>

    <!-- P3 暂存区：已上传待发送媒体（V0 音频：音频件不渲染缩略图，出图标件） -->
    <transition name="staged-fade">
      <div v-if="staged.length" class="pwa-staged" aria-label="待发送媒体">
        <span v-for="s in staged" :key="s.id" class="pwa-staged-item">
          <span v-if="s.kind === 'audio'" class="pwa-staged-audio" title="待发送音频">♪</span>
          <img v-else :src="s.url" :alt="s.name || '待发送图片'" loading="lazy" />
          <button type="button" class="pwa-staged-x" title="移除" @click="removeStaged(s.id)">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </span>
      </div>
    </transition>

    <!-- 输入区（T7 D19 微信式底栏：+（左）+文本输入+麦克风（右）+发送（右）；
         「+」面板=点+上方展开【图片、电话】（design §2.4），点外部/再点+/Esc
         收起，打开面板失焦收软键盘；麦克风不进面板——按住说话需要常驻触摸
         目标，面板收起会丢按压目标） -->
    <form class="pwa-input-row" @submit.prevent="submitChat">
      <!-- T7「+」面板 -->
      <transition name="plus-fade">
        <div v-if="plusOpen" ref="plusPanel" class="pwa-plus-panel" role="menu" aria-label="更多功能">
          <button class="pwa-plus-item" type="button" title="发送图片/音频（最多 10 个）" @click="onPanelImages">
            <span class="pwa-plus-item-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.5"/>
                <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/>
                <path d="M3 15l5-5 4 4 2-2 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <span class="pwa-plus-item-label">图片</span>
          </button>
          <!-- 电话项（T3 独立钮迁入面板——handoff §9-16 预告的重排）：闸关=
               禁用+「开发中」/「引擎未配置」标签，不假装能拨（T7 口径）。 -->
          <button
            class="pwa-plus-item"
            type="button"
            :title="phoneTitle"
            :aria-label="phoneTitle"
            :disabled="!voiceGateOk"
            @click="onPanelCall"
          >
            <span class="pwa-plus-item-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M7.1 3.6c.5 0 .9.3 1 .8l.7 3c.1.4 0 .8-.3 1.1L6.9 10c1 2.2 2.9 4.1 5.1 5.1l1.5-1.6c.3-.3.7-.4 1.1-.3l3 .7c.5.1.8.5.8 1v3.1c0 .6-.5 1-1 1C9.4 19 5 14.6 5 6.6c0-.5.4-1 1-1h1.1z" fill="currentColor"/>
              </svg>
            </span>
            <span class="pwa-plus-item-label">{{ phoneLabel }}</span>
          </button>
        </div>
      </transition>
      <!-- T7：+ 钮（左一） -->
      <button
        ref="plusBtn"
        class="pwa-plus"
        type="button"
        title="更多：图片、电话"
        aria-label="更多功能（图片、电话）"
        :aria-expanded="plusOpen"
        @click="togglePlus"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/>
          <path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
      <input
        ref="fileInput"
        type="file"
        accept="image/*,audio/*"
        multiple
        hidden
        @change="onFilesPicked"
      />
      <textarea
        ref="inputEl"
        v-model="draft"
        class="pwa-input"
        rows="1"
        placeholder="说点什么…"
        autocomplete="off"
        :disabled="sending"
        @keydown.enter="onEnter"
        @paste="onPaste"
      ></textarea>
      <!-- S6 按住说话（asr-tts-design §2.1 站①）：按住录音/松开发送/移开
           取消（T1：setPointerCapture 锁按钮+距离阈值 48px 判定，小漂移不
           误取消），≤60s 自动截断；非安全上下文（HTTP）或无 MediaRecorder
           时隐藏。pointerup/pointercancel/pointermove 在 useVoiceRec 内挂
           window（capture 下重定向事件冒泡可达）；录得 blob 走 V0 上传链路
           （kind:'audio'）。 -->
      <button
        v-if="voiceSupported"
        class="pwa-mic"
        type="button"
        title="按住说话（松开发送，移开取消，最长 60 秒）"
        aria-label="按住说话"
        :class="{ 'is-rec': recState === 'recording', 'is-cancel': cancelPending }"
        :disabled="sending || voiceActive"
        @pointerdown.prevent="pressStart"
        @contextmenu.prevent
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="1.5"/>
          <path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M12 18v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
      <!-- 发送↔停止态互换（L5，ChatDemo ChatInput 语义）：停止=跳过打字
           动画立即显示全文（纯渲染端，后端无停止端点） -->
      <button
        v-if="revealing"
        class="pwa-send is-stop"
        type="button"
        title="跳过打字动画，显示全文"
        @click="finishReveals"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/>
        </svg>
      </button>
      <button
        v-else
        class="pwa-send"
        type="submit"
        :disabled="sending || uploading || (!draft.trim() && !staged.length)"
        title="发送"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 20V4M5 11l7-7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </form>

    <!-- T3 通话覆盖层（V2 前半场，spec §2.5）：状态行（呼叫中/准备声音/
         她在想…/她正在说…/通话中/已结束）+ 文字输入 → 她说话 + 挂断钮；
         text_fallback 降级行内嵌显示；audioBlocked（iOS 来电打断）出
         「点一下继续」手势按钮（design §13.1-③）。 -->
    <transition name="note-fade">
      <div v-if="callState !== 'idle'" class="call-mask" role="dialog" aria-label="语音通话">
        <div class="call-card">
          <div class="call-peer">
            <img class="call-avatar" :src="avatarSrc" alt="" aria-hidden="true" />
            <p class="call-name">{{ botName }}</p>
            <p class="call-status" :class="{ live: callState === 'connected' }">
              {{ statusText }}<template v-if="callState === 'connected'"> · {{ callDurText }}</template>
            </p>
          </div>

          <!-- V3 产品红线（design §6.5 / night-plan §2-T5.3）：常开麦明示文案——
               缺此行=红线违规，不得删。micOpen 才显示（没开麦不说"常开"）。 -->
          <p v-if="callState === 'connected' && micOpen" class="call-mic-note">
            通话中麦克风常开（仅你与我之间）· iOS 顶部橙灯常亮属正常，挂断即灭
          </p>

          <button
            v-if="audioBlocked"
            class="call-resume"
            type="button"
            @click="resumeAudio"
          >通话被打断了，点一下继续</button>

          <!-- TTS 降级纯文字行（text_fallback，spec §2.5：该句文字出） -->
          <div v-if="fallbackLines.length" class="call-fallback" aria-label="她说（文字）">
            <p v-for="(line, i) in fallbackLines" :key="i" class="call-fallback-line">{{ line }}</p>
          </div>

          <p v-if="callHint" class="call-hint" @click="callHint = ''">{{ callHint }}</p>
          <p v-if="callError" class="call-err">{{ callError }}</p>

          <!-- W1 语音回复快捷开关：voice.tts.enabled 即时保存；生效时点（下一句起）见 callHint -->
          <button
            v-if="callState === 'connected'"
            class="call-voice-toggle"
            type="button"
            :disabled="voiceReplyBusy"
            @click="toggleCallVoiceReply"
          >{{ voiceCfg?.tts?.enabled !== false ? '她的语音：开 · 点此改文字' : '她的语音：文字 · 点此恢复' }}</button>

          <!-- 文字输入 → 她说话（V2 唯一输入面；接通后才可发） -->
          <form v-if="callState === 'connected'" class="call-input-row" @submit.prevent="submitCall">
            <input
              v-model="callDraft"
              class="call-input"
              type="text"
              placeholder="打字跟她说…"
              autocomplete="off"
            />
            <button class="call-send" type="submit" :disabled="!callDraft.trim()">发送</button>
          </form>

          <button
            v-if="callState === 'ended'"
            class="call-dismiss"
            type="button"
            @click="dismiss"
          >知道了</button>
          <button
            v-else
            class="call-hangup"
            type="button"
            @click="hangup"
          >{{ callState === 'connected' ? '挂断' : '取消' }}</button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
/* ── 壳：基高 100dvh + safe-area ──────────────────────────── */
.pwa-shell {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100vh;
  height: 100dvh;
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  padding-left: env(safe-area-inset-left, 0px);
  padding-right: env(safe-area-inset-right, 0px);
  background: var(--paper);
  overflow: hidden;
}

.pwa-shell.kb-open {
  padding-bottom: 0;
}

/* ── 顶部栏：头像 + 名字/状态 + 连接点 ─────────────────────── */
.pwa-top {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px var(--space-2);
  border-bottom: 1px solid var(--line);
  background: var(--paper);
  /* 顶栏轻微加深，视觉分层 */
  box-shadow: 0 1px 0 var(--line);
}

.pwa-top-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 圆形头像（画稿标识「圆徽章」：透明底圆形 PNG，裁到可见圆；带一圈琥珀细光） */
.pwa-avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
  flex-shrink: 0;
  user-select: none;
  pointer-events: none;
  box-shadow: var(--ring);
}

.pwa-top-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* 她：名字用陶土（--warm） */
.pwa-title {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 16px;
  font-weight: 500;
  color: var(--warm);
  letter-spacing: 0.16em;
  line-height: 1.2;
}

/* 副标题：在线状态文字 */
.pwa-status-text {
  font-size: 11px;
  color: var(--ink-2);
  letter-spacing: 0.02em;
  transition: color 0.3s ease;
}

.pwa-status-text.on {
  color: var(--olive); /* 苔绿 = 正向/在线 */
}

.pwa-status-text.off {
  color: var(--ink-2);
  opacity: 0.65;
}

/* 连接状态点（右上角辅助视觉）——S2 设计稿二：按钮化，点击=手动重连一次 */
.pwa-dot {
  appearance: none;
  padding: 10px;
  margin: -10px;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  cursor: pointer;
  flex-shrink: 0;
  touch-action: manipulation;
}

.pwa-dot::after {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--line-strong);
  animation: dot-pulse 1.4s infinite ease-in-out;
}

/* 晚安整理按钮（2026-11-15）：顶栏右侧轻量胶囊——底色 token 卡面/细线描边，
   与顶栏头像信息并排；disabled 整理中降透明度。不引新设计元素（对齐 Pwa 既有口径）。 */
.pwa-goodnight {
  appearance: none;
  border: 1px solid var(--line-strong);
  background: var(--card, transparent);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 999px;
  cursor: pointer;
  flex-shrink: 0;
  transition: border-color .15s ease, opacity .15s ease;
}
.pwa-goodnight:hover:not(:disabled) {
  border-color: var(--accent, currentColor);
}
.pwa-goodnight:disabled {
  opacity: .55;
  cursor: default;
}

.pwa-dot.on::after {
  background: var(--olive);
  animation: none;
}

.pwa-dot.off::after {
  background: var(--ink-2);
  animation: none;
  opacity: 0.45;
}

@keyframes dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.4; transform: scale(0.8); }
}

/* ── 状态提示条（仅错误/在途时） ───────────────────────────── */
.pwa-note {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px var(--space-2);
  font-size: 12px;
  color: var(--ink-2);
  background: var(--card);
  border-bottom: 1px solid var(--line);
  cursor: pointer;
}

.pwa-note.err {
  color: #c0392b;
  background: color-mix(in srgb, #c0392b 8%, var(--paper));
}

.pwa-note.warn {
  color: var(--ink-2);
}

.pwa-note-icon {
  font-style: normal;
  flex-shrink: 0;
}

/* 提示条进出动画 */
.note-fade-enter-active,
.note-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.note-fade-enter-from,
.note-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* ── 消息列表 ───────────────────────────────────────────── */
.pwa-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain; /* ChatDemo MessageList：滚到头不连锁拖动整页 */
  scrollbar-width: thin;
  scrollbar-color: var(--line-strong) transparent;
}

.pwa-list::-webkit-scrollbar {
  width: 4px;
}

.pwa-list::-webkit-scrollbar-track {
  background: transparent;
}

.pwa-list::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border-radius: 2px;
}

.pwa-list-inner {
  display: flex;
  flex-direction: column;
  padding: var(--space-2) var(--space-2) var(--space-1);
  min-height: 100%;
  justify-content: flex-end;
}

/* ── 跨日居中分隔线（S2 设计稿二）：—— 昨天 · 11-16 —— ──────── */
.day-sep {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin: 20px 0 10px;
  color: var(--mist-3);
  font-family: var(--font-serif);
  font-size: 11.5px;
  letter-spacing: 0.14em;
  user-select: none;
}

.day-sep::before,
.day-sep::after {
  content: "";
  height: 1px;
  flex: 1;
  max-width: 110px;
  background: var(--line);
}

.day-sep:first-child {
  margin-top: 2px;
}

/* ── 时间标签：等宽 + 两侧细线（编辑式） ───────────────────── */
.time-sep {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: center;
  margin: 16px 0 10px;
  color: var(--mist-3);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.12em;
  user-select: none;
}

.time-sep::before,
.time-sep::after {
  content: "";
  height: 1px;
  flex: 1;
  max-width: 90px;
  background: var(--line);
}

.time-sep span {
  font-family: var(--font-mono);
  color: var(--mist-3);
  letter-spacing: 0.08em;
}

/* ── 消息行 ─────────────────────────────────────────────── */
.chat-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  justify-content: flex-start;
  padding: 2px 0;
}

/* 连续消息（同一发言者）：间距缩小 */
.chat-row.is-grouped {
  padding: 1px 0;
}

.chat-row.is-owner {
  justify-content: flex-end;
}

/* ── T6 通话回想条（design §8.2）：居中、细、带时长，非气泡——
   与 day-sep 同款居中淡字语言（--mist-3/衬线/hairline --line），移动端窄幅 ── */
.call-recall-bar {
  max-width: 86%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin: 2px 0;
  padding: 7px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  color: var(--mist-3);
  font-family: var(--font-serif);
  font-size: 11.5px;
  letter-spacing: 0.05em;
  line-height: 1.6;
  user-select: none;
}

.call-recall-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.call-recall-text {
  text-align: center;
  word-break: break-word;
  white-space: pre-wrap;
}

/* ── 气泡：排版承担语义（衬线 = 她 / 无衬线 = 我） ───────────
   W1 加宽：76%→88%（移动端仍在 100% 内；原 76% 略窄） */
.bubble {
  max-width: 88%;
  min-width: 48px;
  padding: 9px 13px;
  position: relative;
}

/* 汐（左侧）：陶土竖线 + 衬线，无卡面 */
.bubble-her {
  border-radius: 0;
  background: transparent;
  border: none;
  border-left: 2px solid var(--warm);
  padding-left: 13px;
}

/* 浔（右侧）：卡片 + 无衬线 */
.bubble-owner {
  border-radius: 12px 12px 12px 3px;
  background: var(--card);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}

.bubble.pending {
  opacity: 0.65;
}

/* ── 精确时间 tooltip（S2 设计稿二）：桌面 hover / 移动长按（.show-time）
   同一套 ::after；底=--card、字=--ink-2、4px 圆角、150ms 过渡 ── */
.bubble::after {
  content: attr(data-time);
  position: absolute;
  bottom: calc(100% + 4px);
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--card);
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.05em;
  white-space: nowrap;
  box-shadow: var(--shadow);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
  z-index: 5;
}

.bubble-her::after {
  left: 12px;
}

.bubble-owner::after {
  right: 0;
}

.bubble:hover::after,
.bubble.show-time::after {
  opacity: 1;
}

.bubble-text {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 14.5px;
  line-height: 1.75;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ink);
}

.bubble-her .bubble-text {
  font-family: var(--font-serif);
  font-size: 15.5px;
  line-height: 1.9;
}

/* 图片媒体 */
.bubble-media {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

.bubble-media img {
  display: block;
  max-width: min(260px, 72vw);
  max-height: 260px;
  border-radius: 10px;
  border: 1px solid var(--line);
  object-fit: cover;
}

/* W1 媒体层音频化·自绘播放键（组件自带按钮/时长样式）：行置于文本上方，
   间距改到行下（与后续文本行隔开） */
.bubble-audio {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 6px;
}

/* 发送中徽标（气泡内右下角，不占单独行） */
.bubble-pending-badge {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: var(--ink-2);
  opacity: 0.7;
  text-align: right;
  font-family: var(--font-sans);
}

/* ── 空状态：巨大的「汐」水印（唯一一处大胆） ───────────── */
.chat-empty {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  gap: 12px;
  padding: var(--space-4);
  overflow: hidden;
}

.chat-empty::before {
  content: "汐";
  position: absolute;
  font-family: var(--font-serif);
  font-weight: 300;
  font-size: 180px;
  line-height: 1;
  color: var(--warm);
  opacity: 0.12;
  pointer-events: none;
}

.chat-empty-hint {
  position: relative;
  margin: 0;
  color: var(--ink-2);
  font-family: var(--font-serif);
  font-size: 16px;
  letter-spacing: 0.1em;
}

/* ── 消息入场动画 ────────────────────────────────────────── */
.msg-in-enter-active {
  transition: opacity 0.18s ease-out, transform 0.18s ease-out;
}

.msg-in-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.msg-in-leave-active {
  transition: opacity 0.1s ease;
}

.msg-in-leave-to {
  opacity: 0;
}

/* ── typing 气泡（包在气泡壳里，像 iMessage 风格） ──────── */
.pwa-typing-row {
  flex: none;
  min-height: 36px;
  display: flex;
  align-items: center;
  padding: 0 var(--space-2) 2px;
}

/* typing 气泡进出动画 */
.typing-fade-enter-active,
.typing-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.typing-fade-enter-from,
.typing-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.typing-bubble {
  display: inline-flex;
  align-items: center;
  padding: 8px 14px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 18px 18px 18px 5px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}

.typing {
  display: inline-flex;
  gap: 5px;
  align-items: center;
}

.typing i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ink-2);
  animation: typing-blink 1.3s infinite ease-in-out;
  display: block;
}

.typing i:nth-child(2) { animation-delay: 0.18s; }
.typing i:nth-child(3) { animation-delay: 0.36s; }

@keyframes typing-blink {
  0%, 70%, 100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  35% {
    opacity: 1;
    transform: translateY(-3px);
  }
}

/* ── P3 暂存区 ─────────────────────────────────────────── */
.pwa-staged {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px var(--space-2);
  border-top: 1px solid var(--line);
  background: var(--card);
}

.staged-fade-enter-active,
.staged-fade-leave-active {
  transition: opacity 0.15s ease;
}
.staged-fade-enter-from,
.staged-fade-leave-to {
  opacity: 0;
}

.pwa-staged-item {
  position: relative;
  flex: none;
}

.pwa-staged-item img {
  display: block;
  width: 68px;
  height: 68px;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid var(--line);
}

/* V0 音频暂存件：不渲染缩略图，出音符字形件（与缩略图同尺寸盒） */
.pwa-staged-audio {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 68px;
  height: 68px;
  border-radius: 10px;
  border: 1px solid var(--line);
  color: var(--ink-2);
  font-size: 24px;
}

/* 移除按钮：视觉 20px，触摸靶通过 padding 扩到 ~44px */
.pwa-staged-x {
  position: absolute;
  top: -8px;
  right: -8px;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink-2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  /* 扩大触摸靶 */
  touch-action: manipulation;
}

.pwa-staged-x:active {
  background: var(--line);
}

/* ── 输入区 ─────────────────────────────────────────────── */
.pwa-input-row {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px var(--space-2) calc(8px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--line);
  background: var(--paper);
  position: relative;   /* T7：「+」面板 absolute 锚点 */
}

/* ── T7 D19 微信式底栏 ───────────────────────────────────────────────────
   + 钮：图标风格 40px 触摸靶（原图片钮位）；「+」面板：点+上方展开
   【图片、电话】（design §2.4），点外部/再点+/Esc 收起由 document 监听；
   电话项 disabled=「开发中」/「引擎未配置」标签不假装能拨（T7 口径）。 */
.pwa-plus {
  flex: none;
  align-self: center;
  width: 40px;
  height: 40px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  color: var(--ink-2);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
  touch-action: manipulation;
}

.pwa-plus:hover,
.pwa-plus:active {
  border-color: var(--accent);
  color: var(--accent);
}

.pwa-plus-panel {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 8px;
  z-index: 60;
  display: flex;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--paper);
  box-shadow: var(--shadow);
}

.pwa-plus-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 76px;
  padding: 10px 6px 8px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--ink-1);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  touch-action: manipulation;
}

.pwa-plus-item:hover:not(:disabled),
.pwa-plus-item:active:not(:disabled) {
  background: rgba(0, 0, 0, 0.04);
  color: var(--accent);
}

.pwa-plus-item-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  color: var(--ink-2);
}

.pwa-plus-item-label {
  font-size: 12px;
  color: var(--ink-2);
}

/* 电话项禁用态（闸关=「开发中」标签+不可点，T7「不假装能拨」） */
.pwa-plus-item:disabled {
  opacity: 0.45;
  cursor: default;
  color: var(--ink-2);
}

.pwa-plus-item:disabled .pwa-plus-item-icon {
  border-color: var(--line-strong);
  color: var(--ink-2);
}

.plus-fade-enter-active,
.plus-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.plus-fade-enter-from,
.plus-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

/* ── S6 按住说话：44px 圆钮（T1-2c 触摸目标下限，WCAG/移动端 44px 口径；
   旧 40px 偏小）+ ::after 外扩 8px 透明热区（伪元素命中计入按钮本体，
   getBoundingClientRect 仍取视觉 44px rect——取消判定基准不受热区影响）；
   录音中 accent 实底脉冲 / 移出阈值区=取消态红实底（#c0392b=错误红既有
   先例）。touch-action:none 掐掉按住手势的滚动判定（pointercancel 不打断
   录音，preventPageScroll 兜底）；user-select/callout 防长按选中与 iOS
   弹出放大镜。 ── */
.pwa-mic {
  flex: none;
  position: relative;
  width: 44px;
  height: 44px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  color: var(--ink-2);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

/* 外扩透明热区（命中测试计入按钮，无视觉变化） */
.pwa-mic::after {
  content: '';
  position: absolute;
  inset: -8px;
  border-radius: 50%;
}

.pwa-mic:active {
  border-color: var(--accent);
  color: var(--accent);
}

.pwa-mic.is-rec {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  animation: mic-pulse 1.2s infinite ease-in-out;
}

.pwa-mic.is-cancel {
  background: #c0392b;
  border-color: #c0392b;
  color: #fff;
  animation: none;
}

.pwa-mic:disabled {
  cursor: default;
}

@keyframes mic-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

/* 文本输入框 */
.pwa-input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-sans);
  font-size: 16px; /* ≥16px 防 iOS 自动放大 */
  line-height: 1.45;
  padding: 9px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 20px; /* 圆润胶囊输入框，移动端常见 */
  background: var(--card);
  color: var(--ink);
  resize: none;
  overflow-y: auto;
  max-height: 126px;
  transition: border-color 0.15s;
}

.pwa-input:focus {
  outline: none;
  border-color: var(--accent);
}

.pwa-input::placeholder {
  color: var(--ink-2);
  opacity: 0.65;
}

/* 发送按钮：圆形图标按钮，accent 色 */
.pwa-send {
  flex: none;
  width: 40px;
  height: 40px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  border: none;
  border-radius: 50%;
  color: #fff;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.1s;
  touch-action: manipulation;
}

.pwa-send:hover:not(:disabled) {
  opacity: 0.88;
}

.pwa-send:active:not(:disabled) {
  transform: scale(0.93);
}

.pwa-send:disabled {
  opacity: 0.35;
  cursor: default;
}

/* 停止态（L5）：同圆钮，墨黑底白方块（发送↔停止一眼可辨） */
.pwa-send.is-stop {
  background: var(--ink-strong);
}

/* ── T3 通话覆盖层（V2 前半场）：全屏遮罩 + 居中卡（纸张风 token 内；
   与 Chat.vue 同实现同视觉，PWA 侧加大触摸目标）──────────────────── */
.call-mask {
  position: fixed;
  inset: 0;
  z-index: 100; /* 高于提示条/输入区（z-index:5 既有先例），低于 AuthOverlay App 级浮层 */
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--paper) 92%, transparent);
}

.call-card {
  width: min(360px, calc(100vw - 40px));
  padding: 28px 24px 24px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--card);
  box-shadow: 0 8px 32px color-mix(in srgb, var(--ink) 14%, transparent);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.call-peer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.call-avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  border: 1px solid var(--line);
}

.call-name {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 18px;
  color: var(--ink-strong);
}

.call-status {
  margin: 0;
  font-size: 13px;
  color: var(--ink-2);
}

.call-status.live {
  color: var(--accent);
}

.call-resume {
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: transparent;
  color: var(--accent);
  font-size: 14px;
  padding: 10px 20px; /* ≥44px 触摸目标口径（T1-2c 同源） */
  cursor: pointer;
}

.call-fallback {
  width: 100%;
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.call-fallback-line {
  margin: 0;
  padding: 8px 12px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  font-size: 14px;
  line-height: 1.5;
  color: var(--ink);
}

.call-hint {
  margin: 0;
  font-size: 12px;
  color: var(--ink-2);
  cursor: pointer;
}

/* V3 产品红线文案（design §6.5）：常开麦明示——小字常驻状态行下 */
.call-mic-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--ink-2);
  opacity: 0.75;
  text-align: center;
  padding: 0 12px;
}

/* W1 语音回复快捷开关（覆盖层内，与 Chat.vue 同款）：细边幽灵钮 */
.call-voice-toggle {
  margin: 2px auto 0;
  padding: 5px 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--ink-2);
  font-size: 12px;
  cursor: pointer;
}

.call-voice-toggle:disabled {
  opacity: 0.5;
  cursor: default;
}

.call-err {
  margin: 0;
  font-size: 12px;
  color: #c0392b; /* 取消红同源（.pwa-mic.is-cancel 既有先例） */
}

.call-input-row {
  width: 100%;
  display: flex;
  gap: 8px;
}

.call-input {
  flex: 1;
  min-width: 0;
  padding: 10px 12px; /* ≥44px 触摸目标口径 */
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper);
  color: var(--ink);
  font-size: 16px; /* iOS 聚焦自动放大阈值 16px：防软键盘顶起时缩放 */
}

.call-input:focus {
  outline: none;
  border-color: var(--accent);
}

.call-send {
  flex: none;
  min-width: 44px;
  padding: 10px 14px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: transparent;
  color: var(--accent);
  font-size: 14px;
  cursor: pointer;
}

.call-send:disabled {
  opacity: 0.45;
  cursor: default;
}

.call-hangup {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: none;
  background: #c0392b; /* 取消红同源 */
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

.call-dismiss {
  padding: 10px 28px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--ink-2);
  font-size: 14px;
  cursor: pointer;
}
</style>
