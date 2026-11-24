/* ============================================================
   useVoiceCall —— 电话模式 V2 前半场（night-plan §2-T3 / spec §2.5 /
   design §5.4-§5.5）：独立 WS `/api/voice`（D16，绕开 adapter/sender——
   通话不是会话），文字帧进 → 她整段语音回（下行二进制=整段 ogg Opus 24k/
   voip 一帧一整句，night-plan §0 2026-11-18 裁定，取代 spec §2.5 表里的
   PCM 24k 帧方案；decodeAudioData 排程播放）。

   W2 下行双模（内部文档 voice-provider-plan.md §6）：服务端 tts.dialect=deepseek-tools
   时 ready 后发 {type:'audio-mode',value:'pcm',sampleRate:24000}——二进制帧变为
   PCM 流分块（24k mono s16，帧边界无语义）：桌面走 PCM 流式播放（ChatDemo
   readAloud 移植：toFloat32→独立 AudioContext(24k)→顺排程、网络慢续传、首块前
   0.1s 前缓冲）；iOS 元素播放需要完整文件 → segment_start..segment_end 间累积
   整段 PCM → 客户端封装 wav → 既有 playViaElement（前端 PCM→WAV 封装裁决，
   真机实测待白天）。segment 模式（缺省）行为逐字节不变。

   状态机（night-plan §2-T3 口径：呼叫中→准备声音→接通→通话中→已结束）：
   · idle      未在通话（覆盖层关闭）
   · dialing   呼叫中：WS 连接在途（连接超时 8s 报错）
   · preparing 准备声音：WS 已开、hello 已发、等 ready。V2 无 engine-manager
               （T7 落地），此态=握手在途；T7 起引擎拉起/预热也归此态
   · connected 接通 → 通话中：ready 已收（callId 就位）；文字可发
   · ended     已结束：ended 帧 / 断链 / 挂断完成 → dismiss() 回 idle

   「她」的说话状态（她正在说… 提示，纯 UI 无逻辑承载——状态机权威在
   call.js 服务端，spec §2.5 帧表无"整轮结束"帧，V2 用两条近似合成：
   ① thinking=文字已发、首个下行未到；② speaking=有段待解码或有源在播
   （AudioBufferSourceNode.onended 追踪）；尾部 600ms 静默兜底清 hint
   ——解码失败换档间隙 hint 不断流。setTimeout 只用于这条 UI 提示，
   播放时钟一律 ctx.currentTime（design §5.4-3 禁 setTimeout 是指排程
   计时，不指提示条）。

   播放（design §5.4 四条原文全落 + ogg 裁定）：
   · AudioContext + AudioBufferSourceNode，不用 <audio>（元素切换有 gap）
   · 每段一个 Buffer，start(when) 精确排程：when = max(ctx.currentTime +
     0.02, 上一段结束时刻 playHead)；AudioContext 时钟对齐，不用 setTimeout
   · 预调度：段到达即解码即排程（服务端整段合成完才发，天然提前 ≥200ms
     ——若网络/合成让提前量不足，max(…, playHead) 兜底不断音）
   · 首帧前 30ms 静音填充防爆音（整通第一次出声前排一段 30ms 静音 Buffer）
   · 挂断：所有源 stop() + close() AudioContext，不做淡出（§5.4-4）
   · 解码失败（iOS Safari decodeAudioData(ogg) 兼容性未实测，design §13.1）
     → 发 {type:'audio-format', value:'wav'} 换档（服务端 synthesizeRaw
     换档重合成；call.js:457 已接），整通只发一次（换档后 ogg 帧不再来）
   · 解码串行化：decodeAudioData 异步，乱序 resolve 会打乱排程序——按
     到达序链式解码（decodeChain promise），保证 Buffer 排程序=下行序

   iOS 手势约束（design §13.1-③）：AudioContext 必须 start()（呼叫按钮
   点击）同步创建并 resume——非手势内创建必 suspended；来电打断后 ctx
   回 suspended，audioBlocked 置位，UI 出「点一下继续」，resumeAudio()
   在该手势内 resume（不能自动恢复）。

   V3 上行（night-plan §2-T5 / design §6，T5 落地）：
   · 收音=getUserMedia（§6.2 约束组：channelCount1+AEC+NS+AGC，AEC 保持开
     ——§6.5 不因丢帧门控关 AEC）→ AudioWorklet（public/voice-capture-worklet.js）
     线性重采样 16k → 40ms/640 样本 PCM16 帧 + RMS → WS 二进制（1280B 裸帧）；
   · 麦克风全程常开：track 不 stop（挂断才停——蓝牙 HFP 路由稳定/audio session
     不抖动，§6.5），「她说话时不收音」=发送侧门控：服务端 {type:'state'} 帧
     （listening/thinking/speaking，T5 契约帧）驱动 micGateOpen，门关时主线程
     向 Worklet 推 gate=true 机械丢帧（不 postMessage 不进 WS）；不用
     track.enabled=false（等价关麦，路由会切）；本地尾音在播（她的话还从喇叭
     出来）同样关门，防外放回环；
   · 尾点判定前端做（design §6.1）：RMS≥阈值=语音起点（带 320ms 预卷一并上行），
     RMS<阈值持续 700ms（SILENCE_END_MS，2026-11-19 由 300 上调——300 会把句内
     自然停顿误判成句尾）→ 发
     {type:'utterance_end'} 信令；最短 300ms（防咳嗽误触）/最长 60s 强制收尾
     ——服务端只按 min/max 兜底（无服务端 VAD）。静默期（无语音）零上行帧
     （预卷环只留最近 8 帧），服务端缓冲同样零增长；
   · 生命周期：pagehide / visibilitychange(hidden) → 立即 stop+挂断（§6.5：
     iOS 挂起后 track 反正失效，主动清理避免"假通话"）；
   · ASR 失败/error{code:'asr'} → 提示"没听清，再说一次"（服务端不落任何条目）；
     {code:'asr_off'} → 识别未开启引导文字输入。

   错误面：error 帧 {code,message} 按 code 分支（busy=她说着呢排队满深度 1
   超出 / bad_request=协议错 / internal=模型或轮次异常 / asr=没听清 /
   asr_off=识别未开启——call.js busy message 带自增 tick，前端不解析其内容，
   handoff §9-14 口径）。

   生命周期：须在视图 setup 内调用（onUnmounted 兜底挂断清资源——组件
   销毁不留 WS/AudioContext 句柄，与 useVoiceRec 纪律同款）。
   ============================================================ */
import { computed, onUnmounted, ref, watch } from 'vue'

/** WS 连接超时：hello→ready 正常亚秒级（同机回环），8s=极慢网络兜底 */
const CONNECT_TIMEOUT_MS = 8000
/** 准备声音超时上限（T7 D19 状态链"准备声音（超时上限）"）：T7 起此态覆盖
 *  引擎探测/拉起/预热——SoVITS 冷启 ~25s+重试一次的预算，90s=装配层预算的
 *  兜底上限（engine-manager 内部预算约 45s×2+探针，正常远先于此返回） */
const PREPARE_TIMEOUT_MS = 90000
/** 排程最小提前量：when 至少 = ctx.currentTime + 0.02（spec §2.5 前端播放节） */
const START_GAP_S = 0.02
/** 首帧前静音填充（design §5.4-4：避免起播爆音） */
const LEAD_SILENCE_S = 0.03
/** PCM 流播放首块前缓冲（ChatDemo readAloud START_DELAY=0.1 同值——首帧前多缓冲
 *  一点，减少网络抖动造成的断续；readAloud.ts:24） */
const PCM_START_DELAY_S = 0.1
/** PCM 下行缺省采样率（服务端 audio-mode 帧 sampleRate 缺省同值；deepseek 协议固定 24k） */
const PCM_DEFAULT_RATE = 24000
/** 说话提示尾部静默兜底（最后一段结束后无新帧且无音频在播，清「她正在说」） */
const SPEAK_HINT_TAIL_MS = 600
/** busy/error 提示自动清除时长（纯 UI 提示，点按可提前清） */
const HINT_CLEAR_MS = 4000
/** iOS 走 <audio> 元素播放（2026-11-19 实测裁定）：Safari/PWA 里出现过
 *  "ctx.state=running、两段都解码成功、也已排程，但播放计数永不回落"——音频时钟不推进，
 *  结果就是无声 + 永远卡在「她正在说」。元素播放走媒体会话，绕开该缺陷；
 *  代价是句间会有几十毫秒空隙（可接受，半双工本来就有停顿）。
 *  iOS 不支持 Ogg 容器，所以这一路要服务端下发 wav（audio-format 换档）。 */
const IS_IOS =
  typeof navigator !== 'undefined'
  && (/iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
/** 100ms 静音 wav：iOS 媒体解锁用（必须由用户手势内 play 一次，之后换 src 才允许播）。
 *  W1 起导出：AudioBubblePlayer（消息语音条自绘播放键）同件复用——单一事实源。 */
export const SILENT_AUDIO =
  'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='

// ── V3 上行常量（night-plan §2-T5 / design §6.1-§6.2）────────────────────────
// 上行采样率 16000 与帧化（40ms/640 样本线性重采样）都在 Worklet 件内
//（public/voice-capture-worklet.js，spec §2.5 帧表 1280B/帧无帧头）。
/** 帧时长 ms（尾点/最短/最长计时的粒度） */
const FRAME_MS = 40
/** 语音起点预卷帧数（≈320ms 音头，起播判定的前摇一并上行，whisper vad 兜首部） */
const PREROLL_FRAMES = 8
/** 尾点静音阈值 ms（服务端无 VAD，这里是**唯一**尾点判定器，只受 maxUtteranceMs 兜底）。
 *  2026-11-19 实测 300ms 过于敏感：中文自然停顿常在 300–600ms，用户一句话被切成两半。
 *  调到 700ms（句内停顿不再误判），代价是每轮回复晚 0.4s —— 宁可慢一点，不要抢话。 */
const SILENCE_END_MS = 700
/** 最短语音 ms（防咳嗽误触，=config voice.call.minUtteranceMs 缺省） */
const MIN_UTTERANCE_MS = 300
/** 最长单段 ms（强制收尾，=config voice.call.maxUtteranceMs 缺省） */
const MAX_UTTERANCE_MS = 60000
/** 语音能量起步阈值（Float32 线性域 RMS；AGC 开启下的经验起步值，真机可调——晨间清单项） */
const RMS_SPEECH = 0.01
/** 上行采集 Worklet（public/ 静态件，同源加载；sw/构建产物随 dist 拷贝） */
const WORKLET_URL = '/voice-capture-worklet.js'

export type CallState = 'idle' | 'dialing' | 'preparing' | 'connected' | 'ended'

/** 服务端半双工阶段（{type:'state'} 帧的 value；T5 契约帧） */
export type ServerPhase = 'idle' | 'listening' | 'thinking' | 'speaking'

/** 下行 JSON 控制帧（spec §2.5 控制消息表 + T5 增帧 + W2 audio-mode，S→C 侧形状） */
interface ServerFrame {
  type: string
  callId?: number
  segId?: number
  index?: number
  isFirst?: boolean
  text?: string
  code?: string
  message?: string
  reason?: string
  value?: string
  /** W2 audio-mode 帧的 PCM 采样率（24k；deepseek 协议固定） */
  sampleRate?: number
}

export function useVoiceCall() {
  const callState = ref<CallState>('idle')
  /** 呼叫/通话 fatal 错误（连接失败/协议错/模型没接上——覆盖层红字展示） */
  const callError = ref('')
  /** 瞬时提示（busy/换档/排队满；自动清除，点按可清） */
  const callHint = ref('')
  /** 服务端 callId（ready 帧；展示用） */
  const callId = ref(0)
  /** TTS 降级纯文字行（text_fallback；面板文字行显示，spec §2.5） */
  const fallbackLines = ref<string[]>([])
  /** 通话时长（秒，UI 展示；connected 起计） */
  const callSeconds = ref(0)
  /** AudioContext 被系统抢占（iOS 来电打断）待手势 resume（design §13.1-③） */
  const audioBlocked = ref(false)
  /** 服务端半双工阶段（{type:'state'} 帧驱动；T5 契约帧——「她正在说…」收敛为单帧驱动） */
  const serverPhase = ref<ServerPhase>('idle')
  /** 麦克风已开（getUserMedia 成功；红线文案的显示条件——没开麦不说"常开"） */
  const micOpen = ref(false)

  // ── 「她」的说话状态（两条近似合成，见文件头注）────────────────────────
  const thinking = ref(false)        // 文字已发、首个下行未到
  const pendingDecode = ref(0)       // 已收段待解码（decodeChain 在途计）
  const playingCount = ref(0)        // 已排程未播完的源数（onended 追踪）
  /** 尾部静默兜底计时器（segment_end/fallback 后无新帧且无音频在播时清 hint） */
  let speakTailTimer: ReturnType<typeof setTimeout> | undefined

  /** 她正在说（提示条文案口径：思考中 → 说话中 → 空闲） */
  const peerSpeaking = computed(() =>
    thinking.value || pendingDecode.value > 0 || playingCount.value > 0,
  )

  // ── 内部句柄（ref 外的普通变量：无响应式需求）──────────────────────────
  let ws: WebSocket | null = null
  let ctx: AudioContext | null = null
  let connectTimer: ReturnType<typeof setTimeout> | undefined
  let prepareTimer: ReturnType<typeof setTimeout> | undefined
  let secondsTimer: ReturnType<typeof setInterval> | undefined
  let hintTimer: ReturnType<typeof setTimeout> | undefined
  /** playHead：下一段排程起点（=已排程音频的结束时刻；AudioContext 时钟） */
  let playHead = 0
  /** 整通首次出声前是否还欠 30ms 静音段 */
  let leadSilencePending = false
  /** decode 失败已换档 wav（整通只发一次 audio-format） */
  let switchedToWav = false
  /** 解码串行链（按到达序排程，防乱序 resolve 打乱衔接） */
  let decodeChain: Promise<void> = Promise.resolve()
  /** iOS 元素播放：串行链（保序，同时只播一个）+ 复用的播放元素（挂断要 pause） */
  let elChain: Promise<void> = Promise.resolve()
  let elPlayer: HTMLAudioElement | null = null
  /** 元素播放连续失败计数（≥2 次回退 WebAudio 解码排程，见 playViaElement catch） */
  let elementFails = 0
  /** 在途源集合（挂断统一 stop） */
  const sources = new Set<AudioBufferSourceNode>()
  /** 本组件是否已卸载（卸载后不再 setState） */
  let disposed = false

  // ── W2 PCM 流播放分支（内部文档 voice-provider-plan.md §6，ChatDemo readAloud 模式移植；
  //    服务端 audio-mode 帧驱动，deepseek 方言下行 = 24k mono s16 PCM 流分块）────
  /** 下行模式：segment=整段 ogg/wav（现行为，缺省）；pcm=PCM 流分块 */
  let downMode: 'segment' | 'pcm' = 'segment'
  let pcmRate = PCM_DEFAULT_RATE
  /** 独立 24k 播放 AudioContext（懒建）——**不动主 ctx**：主 ctx 带着麦克 Worklet 图
   *  （voice-capture-worklet.js:13 重采样比依赖图采样率），换 24k 会破坏上行管线；
   *  iOS 不走此 ctx（元素播放路径，见 pcmSegChunks） */
  let pcmCtx: AudioContext | null = null
  let pcmNextTime = 0            // 下一块排程起点（AudioContext 时钟，跨段连续）
  let pcmStarted = false         // 整通首块已排程（首块带 PCM_START_DELAY_S 前缓冲）
  let pcmRest = new Uint8Array(0)   // 奇数字节余料（16-bit 对齐，readAloud.ts:46 同款）
  /** iOS pcm 模式：整段 PCM 累积（segment_start..segment_end 间收块）——元素播放
   *  需要完整文件，收口后客户端封装 wav 走既有 playViaElement（plan §6 裁决：
   *  前端 PCM→WAV 封装；真机实测待白天，异常回退=服务端整段封装下发） */
  let pcmSegChunks: ArrayBuffer[] = []

  // ── V3 上行句柄（麦克风常开 + 发送侧门控 + 尾点判定，见文件头注）────────
  let micStream: MediaStream | null = null
  let micSource: MediaStreamAudioSourceNode | null = null
  let worklet: AudioWorkletNode | null = null
  // 尾点判定状态（40ms 一跳的普通变量：无响应式需求，ref 反而添渲染噪声）
  let speechActive = false        // 语音段进行中（起点已判定）
  let speechMs = 0                // 当前段语音累计（静音帧不计）
  let silenceMs = 0               // 当前段尾部静音累计（≥SILENCE_END_MS → 尾点）
  /** 起点预卷环（listening 期滚动留最近 PREROLL_FRAMES 帧，语音起点时一并上行） */
  let preroll: ArrayBuffer[] = []

  function setStatus(s: CallState): void {
    if (disposed) return
    callState.value = s
  }

  function setHint(text: string): void {
    if (disposed) return
    callHint.value = text
    if (hintTimer !== undefined) clearTimeout(hintTimer)
    if (text) hintTimer = setTimeout(() => { callHint.value = '' }, HINT_CLEAR_MS)
  }

  /** 思考/说话提示尾静默兜底（见文件头注：setTimeout 只服务这条 UI 提示） */
  function armSpeakTail(): void {
    if (speakTailTimer !== undefined) clearTimeout(speakTailTimer)
    speakTailTimer = setTimeout(() => {
      if (playingCount.value === 0 && pendingDecode.value === 0) thinking.value = false
    }, SPEAK_HINT_TAIL_MS)
  }

  // ── 播放排程（design §5.4 四条）──────────────────────────────────────────
  /** 建一段静音 Buffer（首帧前 30ms 防爆音填充） */
  function scheduleSilence(): void {
    if (!ctx) return
    const len = Math.max(1, Math.ceil(LEAD_SILENCE_S * ctx.sampleRate))
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)   // 零填充即静音
    play(buf)
  }

  /** 排程一个已解码 Buffer：when = max(currentTime+0.02, playHead)，无缝衔接 */
  function play(buf: AudioBuffer): void {
    if (!ctx || !ws || ws.readyState !== WebSocket.OPEN) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    const when = Math.max(ctx.currentTime + START_GAP_S, playHead)
    src.start(when)
    playHead = when + buf.duration
    playingCount.value += 1
    sources.add(src)
    src.onended = () => {
      sources.delete(src)
      playingCount.value = Math.max(0, playingCount.value - 1)
      if (playingCount.value === 0) armSpeakTail()
    }
  }

  /**
   * iOS 媒体解锁（2026-11-19 实测）：Safari 只允许"用户手势内"开始的媒体播放。
   * 呼叫时若先 await 建连/开麦，手势窗口过期，之后每个 <audio>.play() 都被拒 →
   * 全部段被静默丢弃（表现：能说话、听不到她；随便敲一下键盘就好了）。
   * 解法=手势内先播一段 100ms 静音把元素"解锁"，后续换 src 即放行。
   */
  async function unlockAudioElement(): Promise<void> {
    try {
      if (!elPlayer) elPlayer = new Audio()
      elPlayer.preload = 'auto'
      elPlayer.src = SILENT_AUDIO
      await elPlayer.play()
    } catch { /* 解锁失败不致命：播放时会置 audioBlocked 提示点一下继续 */ }
  }

  /** 整段音频 → Blob URL → 复用已解锁的 <audio>（媒体会话，绕开 WebAudio 时钟缺陷） */
  function playViaElement(bytes: ArrayBuffer, mime = 'audio/wav'): void {
    playingCount.value += 1
    elChain = elChain.then(async () => {
      if (callState.value === 'ended' || disposed) {
        playingCount.value = Math.max(0, playingCount.value - 1)
        return
      }
      if (!elPlayer) elPlayer = new Audio()
      const el = elPlayer
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
      try {
        el.src = url
        await el.play()
        await new Promise<void>((resolve) => {
          let done = false
          const fin = (): void => { if (!done) { done = true; resolve() } }
          el.onended = fin
          el.onerror = fin
          setTimeout(fin, 20000)   // 兜底：iOS 偶发不触发 ended
        })
      } catch {
        // 播放被拒（无手势/被系统打断）：置阻塞态，UI 出「点一下继续」重试解锁；
        // 连续两次仍失败 → 回退 WebAudio 解码排程（极少数环境元素播放完全不可用）。
        elementFails += 1
        audioBlocked.value = true
        if (elementFails >= 2) { try { queueDecode(bytes) } catch { /* ignore */ } }
      } finally {
        el.onended = null
        el.onerror = null
        URL.revokeObjectURL(url)
        playingCount.value = Math.max(0, playingCount.value - 1)
        if (playingCount.value === 0) armSpeakTail()
      }
    })
  }

  /** 解码并排程（串行链保序）：ogg 整段一帧一整句；失败 → wav 换档 */
  function queueDecode(bytes: ArrayBuffer): void {
    pendingDecode.value += 1
    decodeChain = decodeChain.then(async () => {
      if (!ctx || !ws || ws.readyState !== WebSocket.OPEN) return   // 已挂断：丢弃
      let buf: AudioBuffer | null = null
      try {
        buf = await ctx.decodeAudioData(bytes)
      } catch {
        buf = null
      }
      if (!buf) {
        if (!switchedToWav) {
          // iOS Safari decodeAudioData(ogg) 兼容性未实测（design §13.1）：
          // 失败 → 换档 wav（服务端 synthesizeRaw(text,{format:'wav'}) 重合成）
          switchedToWav = true
          sendJson({ type: 'audio-format', value: 'wav' })
          setHint('语音解码换档中…')
        }
        return
      }
      if (leadSilencePending) {
        // 首帧前 30ms 静音填充（design §5.4-4）：排静音段，再排本段
        leadSilencePending = false
        scheduleSilence()
      }
      play(buf)
    }).finally(() => {
      pendingDecode.value = Math.max(0, pendingDecode.value - 1)
      if (pendingDecode.value === 0 && playingCount.value === 0) armSpeakTail()
    })
  }

  // ── W2 PCM 播放（plan §6；ChatDemo readAloud.ts:46-54/118-127 移植）─────────
  /** 16-bit 小端 PCM → Float32；奇数字节留到下一段（readAloud.ts:46-54 同款） */
  function toFloat32(bytes: Uint8Array): Float32Array {
    const samples = new Float32Array(bytes.length >> 1)
    const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000
    return samples
  }

  /** 裸 PCM → wav 容器封装（mono s16；iOS 元素播放需要完整文件，plan §6） */
  function pcmToWavBytes(pcm: Uint8Array, rate: number): ArrayBuffer {
    const dataLen = pcm.length - (pcm.length % 2)
    const out = new ArrayBuffer(44 + dataLen)
    const v = new DataView(out)
    const w = (off: number, s: string): void => {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
    }
    w(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); w(8, 'WAVE'); w(12, 'fmt ')
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true)
    v.setUint16(32, 2, true); v.setUint16(34, 16, true)
    w(36, 'data'); v.setUint32(40, dataLen, true)
    new Uint8Array(out, 44).set(pcm.subarray(0, dataLen))
    return out
  }

  /** PCM 块流式排程（桌面 pcm 模式）：toFloat32 → AudioBuffer(24k) → 顺排程；
   *  网络慢于播放时从当前时间续上、不补播过去（readAloud.ts:124 同款）；
   *  计数面复用 playingCount/sources（麦门控/「她正在说」/挂断清理统一）。 */
  function schedulePcmChunk(data: ArrayBuffer): void {
    if (disposed || callState.value === 'ended') return
    const value = new Uint8Array(data)
    const bytes = new Uint8Array(pcmRest.length + value.length)
    bytes.set(pcmRest)
    bytes.set(value, pcmRest.length)
    const samples = toFloat32(bytes)
    pcmRest = bytes.slice(samples.length * 2)
    if (!samples.length) return
    if (!pcmCtx) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) { setHint('当前环境不支持音频播放'); return }
      try {
        pcmCtx = new Ctor({ sampleRate: pcmRate })
      } catch {
        pcmCtx = null
        setHint('音频播放初始化失败')
        return
      }
    }
    if (pcmCtx.state === 'suspended') void pcmCtx.resume().catch(() => { /* 点按继续路径不适用——元素路径兜底 */ })
    const buffer = pcmCtx.createBuffer(1, samples.length, pcmRate)
    buffer.getChannelData(0).set(samples)   // copyToChannel 的 ArrayBufferLike 型别不容（同效）
    const src = pcmCtx.createBufferSource()
    src.buffer = buffer
    src.connect(pcmCtx.destination)
    pcmNextTime = Math.max(pcmNextTime, pcmCtx.currentTime + (pcmStarted ? 0 : PCM_START_DELAY_S))
    src.start(pcmNextTime)
    pcmNextTime += buffer.duration
    pcmStarted = true
    playingCount.value += 1
    sources.add(src)
    src.onended = () => {
      sources.delete(src)
      playingCount.value = Math.max(0, playingCount.value - 1)
      if (playingCount.value === 0) armSpeakTail()
    }
  }

  /** iOS pcm 模式收口：整段 PCM 累积 → wav 封装 → 复用既有元素播放链（解锁/串行
   *  保序全复用；plan §6 裁决：前端 PCM→WAV 封装，真机实测待白天） */
  function flushPcmSegmentIos(): void {
    if (!IS_IOS || downMode !== 'pcm' || !pcmSegChunks.length) return
    const chunks = pcmSegChunks
    pcmSegChunks = []
    let total = 0
    for (const c of chunks) total += c.byteLength
    if (!total) return
    const merged = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      merged.set(new Uint8Array(c), off)
      off += c.byteLength
    }
    playViaElement(pcmToWavBytes(merged, pcmRate))
  }

  // ── V3 上行门控与尾点（night-plan §2-T5 / design §6；判断在主线程，Worklet 只机械丢帧）──
  /** 她的声音还在本地出声（待解码/在播）——外放回环防线：此刻不收音 */
  const audioPlaying = computed(() => pendingDecode.value > 0 || playingCount.value > 0)
  /** 发送侧门控：接通 + 服务端 listening + 本地无尾音 + 音频图在跑 → 麦帧放行 */
  const micGateOpen = computed(
    () =>
      callState.value === 'connected' &&
      serverPhase.value === 'listening' &&
      !audioPlaying.value &&
      !audioBlocked.value &&
      !!ctx &&
      ctx.state === 'running',
  )

  /** 向 Worklet 推门控（gate=true=机械丢帧：不 postMessage 不进 WS——design §6.5） */
  function pushGate(open: boolean): void {
    if (!worklet) return
    try {
      worklet.port.postMessage({ gate: !open })
    } catch { /* worklet 未就绪/已断 */ }
  }

  watch(micGateOpen, (open) => { pushGate(open) })

  watch(serverPhase, (phase) => {
    if (phase !== 'listening') {
      // 离开 listening：作废半截判定（静音计数/预卷），门控随 micGateOpen 自动关
      speechActive = false
      speechMs = 0
      silenceMs = 0
      preroll = []
    }
    if (phase === 'listening') thinking.value = false   // 回到可说话（error 路径无下行帧可清）
  })

  /** Worklet 40ms 帧回调：门开时跑尾点判定并上行（起点预卷 + 语音流 + 尾点信令） */
  function onMicFrame(pcm: ArrayBuffer, rms: number): void {
    if (callState.value !== 'connected' || serverPhase.value !== 'listening') return
    if (!speechActive) {
      preroll.push(pcm)
      if (preroll.length > PREROLL_FRAMES) preroll.shift()
      if (rms < RMS_SPEECH) return    // 静默期零上行（服务端缓冲零增长）
      // 语音起点：预卷先发，进入流式
      speechActive = true
      speechMs = FRAME_MS
      silenceMs = 0
      for (const f of preroll) sendBinary(f)
      preroll = []
      sendBinary(pcm)
      return
    }
    sendBinary(pcm)                   // 语音中：逐帧上行（WS FIFO 保序，帧先于信令到）
    if (rms >= RMS_SPEECH) {
      silenceMs = 0
      speechMs += FRAME_MS
    } else {
      silenceMs += FRAME_MS
    }
    if (speechMs >= MAX_UTTERANCE_MS) { endUtterance(); return }   // 60s 强制收尾
    if (silenceMs >= SILENCE_END_MS) endUtterance()                // 尾点：700ms 静音（SILENCE_END_MS）
  }

  /** 尾点收尾：发 utterance_end 信令（服务端攒段 wav → ASR）；过短段本地直接丢弃 */
  function endUtterance(): void {
    speechActive = false
    silenceMs = 0
    const total = speechMs
    speechMs = 0
    if (total < MIN_UTTERANCE_MS) {
      preroll = []
      return   // 咳嗽/误触（design §6.1 最短语音）：不惊动服务端
    }
    sendJson({ type: 'utterance_end', ms: total })
  }

  function sendBinary(buf: ArrayBuffer): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(buf)
      return true
    } catch {
      return false
    }
  }

  /** 麦克风开链（start() 手势内调用）：getUserMedia §6.2 约束组（AEC 保持开）→
   *  Worklet 挂图（不上扬声器）。失败=上行缺席，V2 文字面仍在（降级不致命）。 */
  async function startMic(): Promise<void> {
    if (!ctx || !navigator.mediaDevices?.getUserMedia) {
      setHint('当前环境不支持麦克风，可打字说')
      return
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      micStream = null
      const msg = err instanceof Error ? err.message : String(err)
      setHint(/permission|denied|notallowed/i.test(msg) ? '麦克风权限被拒，可打字说' : '麦克风不可用，可打字说')
      return
    }
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL)
      worklet = new AudioWorkletNode(ctx, 'xunxi-pcm16k-capture')
      worklet.port.onmessage = (ev: MessageEvent) => {
        const d = ev.data as { pcm?: ArrayBuffer; rms?: number } | null
        if (d && d.pcm instanceof ArrayBuffer && typeof d.rms === 'number') onMicFrame(d.pcm, d.rms)
      }
      micSource = ctx.createMediaStreamSource(micStream)
      micSource.connect(worklet)   // worklet 不接 destination（采音不上扬声器）
      micOpen.value = true
      pushGate(micGateOpen.value)  // 新链路初始门：按当前状态放行/拦
    } catch {
      stopMic()
      setHint('语音上行不可用，可打字说')
    }
  }

  /** 麦克风停链（挂断才 stop track——§6.5 常开纪律；两轮之间绝不停） */
  function stopMic(): void {
    if (worklet) {
      try { worklet.port.onmessage = null } catch { /* ignore */ }
      try { worklet.disconnect() } catch { /* ignore */ }
    }
    if (micSource) {
      try { micSource.disconnect() } catch { /* ignore */ }
    }
    worklet = null
    micSource = null
    if (micStream) {
      for (const t of micStream.getTracks()) {
        try { t.stop() } catch { /* 已停 */ }
      }
      micStream = null
    }
    micOpen.value = false
    speechActive = false
    speechMs = 0
    silenceMs = 0
    preroll = []
  }

  // ── 上行（spec §2.5 控制消息表 + T5 utterance_end，C→S 侧）────────────────
  function sendJson(obj: Record<string, unknown>): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }

  /** 文字输入发送（V2 输入面，V3 与语音上行并存）：她说期间服务端排队深度 1，超出回 busy */
  function sendText(text: string): boolean {
    const t = String(text ?? '').trim()
    if (!t) return false
    if (callState.value !== 'connected') return false
    if (!sendJson({ type: 'text', text: t })) return false
    thinking.value = true                       // 等她的第一个下行（段/fallback/error）
    return true
  }

  // ── 下行帧处理 ───────────────────────────────────────────────────────────
  function onFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'ready':
        callId.value = Number(frame.callId ?? 0)
        if (prepareTimer !== undefined) { clearTimeout(prepareTimer); prepareTimer = undefined }
        setStatus('connected')
        if (secondsTimer === undefined) {
          callSeconds.value = 0
          secondsTimer = setInterval(() => { callSeconds.value += 1 }, 1000)
        }
        break
      case 'segment_start':
        thinking.value = false
        armSpeakTail()
        break
      case 'segment_end':
        armSpeakTail()
        flushPcmSegmentIos()   // W2：iOS pcm 模式整段收口（segment 模式/桌面为空操作）
        break
      case 'text_fallback': {
        // TTS 失败/降级：该句纯文字出（面板文字行显示，spec §2.5）
        const line = String(frame.text ?? '').trim()
        if (line) fallbackLines.value = [...fallbackLines.value.slice(-19), line]
        thinking.value = false
        armSpeakTail()
        break
      }
      case 'error': {
        // 按 code 分支（busy message 带自增 tick，不解析内容——handoff §9-14）
        const code = String(frame.code ?? '')
        if (code === 'busy') {
          thinking.value = false
          setHint('她说着呢，这条稍后再发')
        } else if (code === 'bad_request') {
          setHint('这条没发出去（格式不对）')
        } else if (code === 'asr') {
          // 转写失败/为空：服务端不落任何条目，回 listening 后可直接重说（T5）
          thinking.value = false
          setHint(String(frame.message ?? '没听清，再说一次'))
        } else if (code === 'asr_off') {
          // 识别未开启（§10.2 降级链：ASR 缺席→文字输入）
          thinking.value = false
          setHint(String(frame.message ?? '语音识别未开启，打字说吧'))
        } else if (code === 'unavailable') {
          // T7 D19 拒接（§10.2-4 双引擎配置在册但均不可用）：原因进 fatal 错误面
          //（服务端随后断链，onclose→finishCall('') 保留此文案，ended 态可读）
          thinking.value = false
          callError.value = String(frame.message ?? '语音引擎未就绪，这通先打不了')
        } else {
          thinking.value = false
          setHint(String(frame.message ?? '出错了，再说一句试试'))
        }
        armSpeakTail()
        break
      }
      case 'state': {
        // 服务端半双工阶段帧（T5 契约）：listening/thinking/speaking——
        // 「她正在说…」提示与麦克风发送侧门控都由它单帧驱动（handoff §9-18 收敛）
        const v = String(frame.value ?? '')
        if (v === 'listening' || v === 'thinking' || v === 'speaking') serverPhase.value = v
        break
      }
      case 'audio-mode': {
        // W2 下行双模通知（plan §4）：value 'pcm' = PCM 流分块（deepseek 方言）；
        // 服务端只在 pcm 模式发此帧（segment 为缺省，不发=向后兼容旧客户端）。
        if (String(frame.value ?? '') === 'pcm') {
          downMode = 'pcm'
          const sr = Number(frame.sampleRate)
          if (sr > 0) pcmRate = sr
        }
        break
      }
      case 'ended':
        // 挂断完成（reason: 'client'|'server'）——服务端 appendSelf 后断链
        cleanupMedia()
        setStatus('ended')
        break
      default:
        break   // 未知类型忽略（协议前向兼容）
    }
  }

  /** 二进制帧（W2 双模，plan §6）：segment 模式=整段 ogg/wav 一帧一整句（call.js
   *  sendBinary）；pcm 模式=PCM 流分块——桌面流式排程（schedulePcmChunk），iOS
   *  整段累积（元素播放需完整文件，segment_end 收口封装 wav） */
  /** 整段音频的容器类型（决定 Blob mime；元素播放靠魔数嗅探，mime 只是提示） */
  function mimeOf(bytes: ArrayBuffer): string {
    const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength))
    const sig = String.fromCharCode(...head)
    if (sig === 'OggS') return 'audio/ogg'
    if (sig === 'RIFF') return 'audio/wav'
    return 'audio/ogg'
  }

  function onBinary(data: ArrayBuffer): void {
    thinking.value = false
    if (downMode === 'pcm') {
      if (IS_IOS) { pcmSegChunks.push(data); return }
      schedulePcmChunk(data)
      return
    }
    // 2026-11-20：**所有平台统一走元素播放**。桌面原走 WebAudio（decodeAudioData +
    // 精确排程），但实测桌面通话整通无声（同一引擎的消息语音条却正常），
    // 与 11-19 iOS 那次是同一类"上下文在跑、时钟不推进"问题。
    // 元素播放是已验证可出声的路径，代价只是句间几十毫秒空隙，半双工下无感。
    playViaElement(data, mimeOf(data))
  }

  // ── 清理（挂断/卸载共用；design §5.4-4：stop + close，不做淡出）──────────
  function cleanupMedia(): void {
    for (const src of sources) {
      try { src.stop() } catch { /* 已停止 */ }
      src.onended = null
    }
    sources.clear()
    playingCount.value = 0
    pendingDecode.value = 0
    playHead = 0
    leadSilencePending = false
    decodeChain = Promise.resolve()
    // iOS 元素播放：停当前段 + 清串行链（否则挂断后还在播上一段）
    if (elPlayer) { try { elPlayer.pause() } catch { /* 已停 */ } try { elPlayer.removeAttribute('src') } catch { /* ignore */ } }
    elChain = Promise.resolve()
    elementFails = 0
    // W2 PCM 分支：关独立 24k 播放 ctx + 清余料/累积/双模态（sources 已含 pcmCtx 源，
    // 上面统一 stop 了）
    if (pcmCtx) { try { void pcmCtx.close() } catch { /* 已关 */ } pcmCtx = null }
    pcmNextTime = 0
    pcmStarted = false
    pcmRest = new Uint8Array(0)
    pcmSegChunks = []
    downMode = 'segment'
    pcmRate = PCM_DEFAULT_RATE
    stopMic()   // 麦 track 挂断才 stop（§6.5 常开纪律的终态；两轮之间不停）
    if (ctx) {
      try { void ctx.close() } catch { /* 已关 */ }
      ctx = null
    }
    audioBlocked.value = false
  }

  function clearTimers(): void {
    if (connectTimer !== undefined) { clearTimeout(connectTimer); connectTimer = undefined }
    if (prepareTimer !== undefined) { clearTimeout(prepareTimer); prepareTimer = undefined }
    if (secondsTimer !== undefined) { clearInterval(secondsTimer); secondsTimer = undefined }
    if (speakTailTimer !== undefined) { clearTimeout(speakTailTimer); speakTailTimer = undefined }
    if (hintTimer !== undefined) { clearTimeout(hintTimer); hintTimer = undefined }
  }

  function closeWs(): void {
    if (!ws) return
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    try { ws.close() } catch { /* 已断 */ }
    ws = null
  }

  /** 通话终态统一收尾（ended 帧 / onclose / onerror / 挂断超时兜底共用） */
  function finishCall(message = ''): void {
    clearTimers()
    cleanupMedia()
    closeWs()
    thinking.value = false
    if (message) callError.value = message
    setStatus('ended')
  }

  // ── 呼叫（须在用户手势内调用：点击呼叫按钮——iOS AudioContext 解锁前提）──
  async function start(): Promise<boolean> {
    if (callState.value === 'dialing' || callState.value === 'preparing') return false
    callError.value = ''
    callHint.value = ''
    callId.value = 0
    callSeconds.value = 0
    fallbackLines.value = []
    thinking.value = false
    switchedToWav = false
    serverPhase.value = 'idle'
    cleanupMedia()
    setStatus('dialing')

    // AudioContext 手势内创建 + resume（design §13.1-③：非手势内必 suspended，
    // 来电打断后同样须手势 resume——audioBlocked 路径见 resumeAudio）
    try {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) {
        callError.value = '当前环境不支持 WebAudio（通话不可用）'
        setStatus('ended')
        return false
      }
      ctx = new Ctor()
      playHead = ctx.currentTime
      leadSilencePending = true
      await ctx.resume().catch(() => { /* resume 拒绝 → audioBlocked 路径 */ })
      if (ctx.state === 'suspended') audioBlocked.value = true
    } catch (err) {
      callError.value = `音频初始化失败：${err instanceof Error ? err.message : String(err)}`
      setStatus('ended')
      return false
    }

    // iOS：仍在手势窗口内，先把 <audio> 解锁（必须在任何 await 链过长之前）
    await unlockAudioElement()

    // V3 上行：麦克风手势内开链（getUserMedia 常开，挂断才停——§6.5）。
    // 失败不致命：V2 文字面仍在（startMic 内部已提示并降级）。
    await startMic()

    // WS 连接（同源 /api/voice；握手 404=voice.call.enabled 关——入口本就不该出现）
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    try {
      ws = new WebSocket(`${proto}//${location.host}/api/voice`)
    } catch (err) {
      callError.value = `无法发起通话：${err instanceof Error ? err.message : String(err)}`
      setStatus('ended')
      return false
    }
    ws.binaryType = 'arraybuffer'
    connectTimer = setTimeout(() => {
      if (callState.value === 'dialing') {
        finishCall('呼叫超时：连接不上通话服务（通话可能未开启，或网络不通）')
      }
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      if (connectTimer !== undefined) { clearTimeout(connectTimer); connectTimer = undefined }
      setStatus('preparing')
      sendJson({ type: 'hello' })
      // iOS：Safari 不支持 Ogg 容器，元素播放要 wav —— 握手后立即换档，
      // 保证第一段就是 wav（桌面仍走 ogg + WebAudio，体积小 20 倍）。
      if (IS_IOS) sendJson({ type: 'audio-format', value: 'wav' })
      // 准备声音超时上限（T7 D19）：T7 起本态覆盖服务端引擎探测/拉起/预热
      //（SoVITS 冷启 ~25s 级），90s 仍无 ready = 装配层卡死兜底
      if (prepareTimer !== undefined) clearTimeout(prepareTimer)
      prepareTimer = setTimeout(() => {
        if (callState.value === 'preparing') {
          finishCall('准备声音超时：引擎一直没就绪（检查 whisper/SoVITS 是否能启动，或改 manage=manual 手动起引擎）')
        }
      }, PREPARE_TIMEOUT_MS)
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        try {
          onFrame(JSON.parse(ev.data) as ServerFrame)
        } catch {
          setHint('收到无法解析的消息')
        }
        return
      }
      // ArrayBuffer / Blob 两种形态兜底（ws.binaryType 已设 arraybuffer）
      if (ev.data instanceof ArrayBuffer) {
        onBinary(ev.data)
      } else if (typeof Blob !== 'undefined' && ev.data instanceof Blob) {
        void ev.data.arrayBuffer().then(onBinary).catch(() => { /* 丢弃坏帧 */ })
      }
    }
    ws.onclose = () => {
      if (callState.value === 'ended') return   // ended 帧已收（服务端主动断，正常路径）
      finishCall(callState.value === 'connected' ? '通话已断开' : '连接已断开（通话可能未开启）')
    }
    ws.onerror = () => {
      if (callState.value === 'dialing') {
        // onerror 后必接 onclose（finishCall 在那里统一收尾），这里只记错误文案
        callError.value = '连接不上通话服务（通话可能未开启，或网络不通）'
      }
    }
    return true
  }

  /** 「点一下继续」：iOS 来电打断等场景 AudioContext suspended，必须由用户
   *  手势 resume（design §13.1-③，不能自动恢复）。麦 track 全程未 stop（§6.5），
   *  resume 即整图恢复（含 Worklet 采音），恢复后按当前状态重推门控。 */
  function resumeAudio(): void {
    // 手势内顺手重新解锁 <audio>（iOS 元素播放被拒后的恢复路径）
    void unlockAudioElement()
    if (!ctx || ctx.state !== 'suspended') {
      audioBlocked.value = false
      return
    }
    void ctx.resume().then(() => {
      audioBlocked.value = false
      pushGate(micGateOpen.value)
    }).catch(() => { /* 再点一次（仍 suspended 时 audioBlocked 保持） */ })
  }

  /** 挂断：发 stop（服务端 appendSelf 恰一次 → 回 ended → 服务端断链）。
   *  ended 帧 / onclose 兜底收尾；本地立即停声断链（不等服务端）。 */
  function hangup(): void {
    if (callState.value === 'idle' || callState.value === 'ended') return
    sendJson({ type: 'stop' })
    // 本地侧不等回帧：立刻停播断链进 ended（服务端 ended/onclose 再兜底一次）
    finishCall()
  }

  /** 已结束覆盖层「知道了」→ 回 idle（覆盖层关闭） */
  function dismiss(): void {
    clearTimers()
    cleanupMedia()
    closeWs()
    callError.value = ''
    callHint.value = ''
    callId.value = 0
    callSeconds.value = 0
    fallbackLines.value = []
    thinking.value = false
    serverPhase.value = 'idle'
    setStatus('idle')
  }

  // ── 生命周期红线（night-plan §2-T5 / design §6.5）：pagehide / 切后台即挂断 ──
  // iOS 挂起后 track 反正失效——主动 stop+挂断，避免留下"假通话"（服务端 onclose
  // 同样落回想行）。监听器随 composable 存活，非通话态 handler 空转。
  function activeCallLive(): boolean {
    return callState.value === 'dialing' || callState.value === 'preparing' || callState.value === 'connected'
  }
  function onPageHide(): void {
    if (activeCallLive()) hangup()
  }
  function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden' && activeCallLive()) hangup()
  }
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibilityChange)

  onUnmounted(() => {
    disposed = true
    window.removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (callState.value !== 'idle' && callState.value !== 'ended') {
      // 卸载兜底挂断（sendJson 静默失败即可——服务端 onclose 同样落回想）
      sendJson({ type: 'stop' })
    }
    clearTimers()
    cleanupMedia()
    closeWs()
  })

  /** 覆盖层状态行文案（night-plan §2-T3 五态 + T7 D19 状态链：呼叫中→准备
   *  声音→接通中→通话中→已结束。V3 起她侧状态=服务端 {type:'state'} 帧单帧
   *  驱动，本地音频在播作尾部兜底——handoff §9-18 收敛。「接通中」=ready 已收、
   *  首个 state 帧未到（服务端 ready 后立即 setPhase listening，正常一闪而过；
   *  卡在接通中=服务端握手后半程异常，由 preparing 超时/断链兜底） */
  const statusText = computed(() => {
    switch (callState.value) {
      case 'dialing': return '呼叫中…'
      case 'preparing': return '准备声音…'
      case 'connected': {
        if (serverPhase.value === 'idle' && !thinking.value) return '接通中…'
        if (serverPhase.value === 'thinking' || thinking.value) return '她在想…'
        if (serverPhase.value === 'speaking' || pendingDecode.value > 0 || playingCount.value > 0) return '她正在说…'
        return '通话中'
      }
      case 'ended': return '已结束'
      default: return ''
    }
  })

  return {
    callState,
    callError,
    callHint,
    callId,
    fallbackLines,
    callSeconds,
    audioBlocked,
    micOpen,
    peerSpeaking,
    statusText,
    start,
    sendText,
    hangup,
    resumeAudio,
    dismiss,
  }
}
