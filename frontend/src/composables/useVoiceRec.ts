/* ============================================================
   useVoiceRec —— 按住说话（S6，asr-tts-design.md §2.1 站① / 一期3）：
   MediaRecorder 录音 → blob → V0 上传链路（POST /api/web/upload，FormData
   files 字段与 useUploads 同一端点同一形状；kind:'audio' 由后端 mime 白名单
   routes.js:78 / 魔数 image-type.js detectAudioType 判定）→ useChat.send
   独立成条（text=''：orchestrator.js 只对**无文本**的音频附件做 ASR 转写，
   草稿在途时暂存/恢复，不并进语音条）。Chat.vue（桌面）与 Pwa.vue（移动）
   共用同一实现（抽取=搬运不是重写，useChat/useUploads 同款手法）。

   交互（微信式按住说话；T1 手感修复后口径）：
   · 按住（pointerdown）→ setPointerCapture 锁定按钮（指针事件持续派发到
     按钮，手指漂出视口/掠过其他元素不断流）→ getUserMedia → MediaRecorder
     起录
   · 松开（pointerup）→ 发送；按住期间指针**距按钮中心 >48px 或出按钮
     rect 外扩 24px** → cancelPending（松开=取消，录音丢弃；距离阈值判定
     ——旧 elementFromPoint 命中判定下手机手指几毫米轻漂即误取消=T1 不灵
     敏根因，night-plan §2-T1）；pointercancel（系统抢断）→ 取消
   · ≤60s（MAX_VOICE_MS）自动截断 = 松开（发送已录部分，design §2.1「建议
     ≤60s/条」）；<MIN_VOICE_MS 视为误触丢弃
   · starting 期（getUserMedia 权限弹窗在途）松开/抢断 → 授权落地后不起录
     （releaseDuringStart——防「以为在录其实没按住」的僵尸录音，walkie
     §10-39 口径），但明确提示「请再按一次」，不静默丢弃（T1 §10-39 体验
     修复）

   格式探测链（design §2.1 站①）：audio/webm;codecs=opus（Chromium/Firefox）
   → audio/mp4（iOS Safari AAC）→ audio/ogg;codecs=opus，isTypeSupported
   逐档探测。File type 取分号前**基 mime**（routes.js AUDIO_UPLOAD_MIME_RE
   正则锚定整串，带 codecs 后缀过不了白名单；落盘扩展由后端魔数嗅探兜底，
   V0 的 ftyp/EBML 魔数已接——asr-tts-design §6 录音格式矩阵）。

   getUserMedia 约束（阶段指令）：channelCount:1 + echoCancellation +
   noiseSuppression + autoGainControl（单声道/回声消除/降噪/自动增益，
   对讲场景标准组）。录音器 start() 不带 timeslice：整段单 blob——audio/mp4
   分片在部分实现上拼接不可靠（各自带 ftyp 头），60s 体量无内存压力。

   安全上下文：getUserMedia 仅 HTTPS/localhost 可用——非安全上下文无
   navigator.mediaDevices，voiceSupported=false，按钮不出现（iOS PWA 非
   HTTPS 部署时按钮缺失属预期；桌面 Chrome 127.0.0.1 属安全上下文，晨间
   真机验收前提见 handoff-voice-walkie）。

   生命周期：须在视图 setup 内调用（ref/computed 实例内；onUnmounted 丢弃
   在途录音并停流清定时器——组件销毁不留句柄，与 useChat 纪律同款）。
   ============================================================ */
import { computed, onUnmounted, ref, type Ref } from 'vue'
import { api } from '../lib/api'

/** 录音上限 60s（design §2.1「建议 ≤60s/条」；到点自动截断=松开发送） */
const MAX_VOICE_MS = 60_000
/** 短于此视为误触丢弃（快速点按不应发出空白语音条） */
const MIN_VOICE_MS = 600

/** 取消判定：指针距按钮中心超过此距离 → cancelPending（T1 根因修复，
 *  night-plan §2-T1-2b：小漂移不再误取消） */
const CANCEL_CENTER_PX = 48
/** 取消判定：指针出按钮 rect 外扩此距离 → cancelPending（与中心距二选一
 *  命中即取消；微信式「移开取消」的空间容差） */
const CANCEL_INFLATE_PX = 24
/** §10-38 sending 在途竞态重试间隔：send false（sending 锁 early-false，
 *  useChat.ts:565）后让位在途请求再试一次（walkie §10-38 登记改法，
 *  修复点单在 finish()） */
const SEND_RETRY_MS = 300

/** mime 探测链（design §2.1 站①）：webm/opus → mp4 → ogg/opus */
const MIME_CHAIN = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'] as const

export type VoiceRecState = 'idle' | 'starting' | 'recording' | 'sending'

export function useVoiceRec(options: {
  /** useChat.send（语音条经同一乐观发送/失败撤回链路；失败返回 false） */
  send: (attachments?: unknown) => Promise<boolean>
  /** useChat.draft（语音条恒独立成条——orchestrator 仅对无文本音频转写；
   *  发送前暂存、发送后恢复，草稿不并进语音条也不被清走） */
  draft: Ref<string>
}) {
  const recState = ref<VoiceRecState>('idle')
  /** 按住中指针已移出取消阈值区（松开=取消；红色反馈态 .is-cancel） */
  const cancelPending = ref(false)
  /** 录音已持续秒数（提示条展示用） */
  const recSeconds = ref(0)
  const voiceError = ref('')
  /** 非错误提示（§10-39：首录授权落地但按住已被弹窗打断 → 明确提示再按
   *  一次，不静默丢弃；走 voiceNote 展示，下一次按住即清） */
  const voiceHint = ref('')

  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let chunks: Blob[] = []
  /** 本条录音的基 mime（分号前，探测链命中项） */
  let baseMime = ''
  let elapsedTimer: ReturnType<typeof setInterval> | undefined
  let capTimer: ReturnType<typeof setTimeout> | undefined
  let startedAt = 0
  /** stop(cancel) → onstop(finish) 之间传递取消意图（recorder 事件异步落地） */
  let discardNext = false
  /** starting 期已松开/抢断：授权落地起录后立即丢弃 */
  let releaseDuringStart = false
  /** 按住的按钮 rect（pressStart 时快照；取消判定的空间基准——按钮在按住
   *  期间不移动，无追踪必要） */
  let holdRect: DOMRect | null = null

  /** 探测链逐档探测（design §2.1 站①；isTypeSupported 个别实现抛错继续下一档） */
  function probeMime(): string | null {
    if (typeof MediaRecorder === 'undefined') return null
    for (const m of MIME_CHAIN) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m
      } catch { /* 继续下一档 */ }
    }
    return null
  }

  /** 按钮显隐：非安全上下文（无 mediaDevices）/ 无 MediaRecorder / 探测链全空
   *  = 不支持（按钮隐藏，不埋「按了没反应」的坑） */
  const voiceSupported = computed(() =>
    typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && probeMime() !== null,
  )

  /** 提示条文案（两视图共用同一份）：错误优先，其次非错误提示（§10-39
   *  再按一次），再次录音在途状态 */
  const voiceNote = computed(() => {
    if (voiceError.value) return voiceError.value
    if (voiceHint.value) return voiceHint.value
    if (recState.value === 'starting') return '录音启动中…'
    if (recState.value === 'recording') {
      return cancelPending.value ? '松开取消' : `正在录音 ${recSeconds.value}s · 松开发送，移开取消`
    }
    if (recState.value === 'sending') return '语音发送中…'
    return ''
  })

  /** 错误态标记（视图提示条 err 样式 + 点击清除口径） */
  const voiceIsError = computed(() => voiceError.value !== '')

  /** 录音链路在途（按钮禁用/状态样式；starting 也算——按住中） */
  const voiceActive = computed(() => recState.value !== 'idle')

  function clearVoiceError(): void {
    voiceError.value = ''
  }

  function extOf(mime: string): string {
    if (mime.startsWith('audio/mp4')) return '.m4a'
    if (mime.startsWith('audio/ogg')) return '.ogg'
    return '.webm'
  }

  function releaseStream(): void {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
  }

  function clearTimers(): void {
    if (elapsedTimer !== undefined) {
      clearInterval(elapsedTimer)
      elapsedTimer = undefined
    }
    if (capTimer !== undefined) {
      clearTimeout(capTimer)
      capTimer = undefined
    }
  }

  function detachHoldListeners(): void {
    window.removeEventListener('pointermove', onHoldMove)
    window.removeEventListener('pointerup', onHoldUp)
    window.removeEventListener('pointercancel', onHoldCancel)
  }

  /** 按住中指针移动：距离阈值判定 cancel 态（T1 根因修复）——指针距按钮
   *  中心 >48px 或出按钮 rect 外扩 24px 才取消。监听在 window：pointer
   *  capture 下事件重定向到按钮仍冒泡到 window；无捕获（降级）时原生跟随。
   *  旧实现 elementFromPoint 命中判定在手机上手指几毫米轻漂即误取消=不灵
   *  敏根因，已废弃。 */
  function onHoldMove(ev: PointerEvent): void {
    if (recState.value !== 'recording' && recState.value !== 'starting') return
    const r = holdRect
    if (!r) return // 无基准（异常路径）不取消——宁可不误杀
    const dx = ev.clientX - (r.left + r.width / 2)
    const dy = ev.clientY - (r.top + r.height / 2)
    const beyondCenter = dx * dx + dy * dy > CANCEL_CENTER_PX * CANCEL_CENTER_PX
    const beyondRect = ev.clientX < r.left - CANCEL_INFLATE_PX
      || ev.clientX > r.right + CANCEL_INFLATE_PX
      || ev.clientY < r.top - CANCEL_INFLATE_PX
      || ev.clientY > r.bottom + CANCEL_INFLATE_PX
    cancelPending.value = beyondCenter || beyondRect
  }

  function onHoldUp(): void {
    detachHoldListeners()
    if (recState.value === 'starting') {
      releaseDuringStart = true
      return
    }
    if (recState.value === 'recording') void stop(cancelPending.value)
  }

  function onHoldCancel(): void {
    detachHoldListeners()
    if (recState.value === 'starting') releaseDuringStart = true
    else if (recState.value === 'recording') void stop(true)
  }

  /** 按住开始（视图 @pointerdown 接线）：起录或进 starting（权限在途） */
  async function pressStart(ev: PointerEvent): Promise<void> {
    if (recState.value !== 'idle') return
    voiceError.value = ''
    voiceHint.value = ''
    cancelPending.value = false
    releaseDuringStart = false
    const target = (ev.currentTarget as Element | null) ?? null
    // T1-2a：指针捕获挂按钮——后续 pointermove/up 持续派发到按钮（冒泡到
    // window 监听），手指漂出视口/掠过其他元素不再断流；个别环境
    // （pointerId 失效等）抛错则退回 window 原生跟随，不影响主链路
    try { target?.setPointerCapture(ev.pointerId) } catch { /* 降级：window 跟随 */ }
    holdRect = target?.getBoundingClientRect() ?? null
    const mime = probeMime()
    if (!mime || !navigator.mediaDevices?.getUserMedia) {
      voiceError.value = '当前环境不支持录音（需 HTTPS 或 localhost，且浏览器支持 MediaRecorder）'
      holdRect = null
      return
    }
    baseMime = mime.split(';')[0]
    recState.value = 'starting'
    window.addEventListener('pointermove', onHoldMove, { passive: true })
    window.addEventListener('pointerup', onHoldUp)
    window.addEventListener('pointercancel', onHoldCancel)
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      detachHoldListeners()
      releaseStream()
      recState.value = 'idle'
      holdRect = null
      const msg = err instanceof Error ? err.message : String(err)
      voiceError.value = /permission|denied|notallowed/i.test(msg)
        ? '麦克风权限被拒绝：请在浏览器允许麦克风后重试'
        : `无法访问麦克风：${msg}`
      return
    }
    if (releaseDuringStart) {
      // 等权限期间已松开/被抢断：不起录（防「以为在录其实没按住」的僵尸
      // 录音，walkie §10-39 口径），但明确提示再按一次——T1 不再静默丢弃
      // （iOS 首录授权弹窗夺焦点必打断按住，旧手感=按了没反应）
      releaseStream()
      detachHoldListeners()
      recState.value = 'idle'
      holdRect = null
      voiceHint.value = '麦克风已授权，请再按一次说话'
      return
    }
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime })
    } catch (err) {
      releaseStream()
      detachHoldListeners()
      recState.value = 'idle'
      holdRect = null
      voiceError.value = `录音启动失败：${err instanceof Error ? err.message : String(err)}`
      return
    }
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data) }
    recorder.onerror = () => {
      // 引擎错误：标记丢弃后尽力停（stop 内 inactive 兜底直落 finish）
      discardNext = true
      try { recorder?.stop() } catch { void finish() }
    }
    recorder.onstop = () => { void finish() }
    chunks = []
    startedAt = Date.now()
    recorder.start() // 不带 timeslice：整段单 blob（audio/mp4 分片拼接不可靠；60s 体量无压力）
    recState.value = 'recording'
    recSeconds.value = 0
    // 秒表按起点重算（interval 只做展示刷新）；60s 闸到点=松开（发送）
    elapsedTimer = setInterval(() => {
      recSeconds.value = Math.min(60, Math.ceil((Date.now() - startedAt) / 1000))
    }, 250)
    capTimer = setTimeout(() => { void stop(false) }, MAX_VOICE_MS)
  }

  /** 停录并收尾（cancel=true 丢弃；false/缺省=发送）。stop 后 final blob 经
   *  ondataavailable 落 chunks、onstop 异步进 finish。 */
  function stop(cancel: boolean): void {
    if (recState.value !== 'recording') return
    discardNext = cancel
    detachHoldListeners()
    clearTimers()
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop() } catch { void finish() }
    } else {
      void finish()
    }
  }

  /** onstop 收尾：blob 组装 →（未取消且非误触）→ V0 上传 → send 独立成条 */
  async function finish(): Promise<void> {
    detachHoldListeners()
    clearTimers()
    releaseStream()
    const heldMs = Date.now() - startedAt
    const cancelled = discardNext
    discardNext = false
    const blob = new Blob(chunks, { type: baseMime })
    chunks = []
    const mime = baseMime
    recorder = null
    holdRect = null
    cancelPending.value = false
    recSeconds.value = 0
    recState.value = 'idle'
    if (cancelled) return
    if (!blob.size || heldMs < MIN_VOICE_MS) {
      voiceError.value = '说话时间太短，未发送'
      return
    }
    recState.value = 'sending'
    try {
      // V0 上传链路（POST /api/web/upload，FormData files 字段同 useUploads；
      // kind:'audio' 由后端判定——routes.js:78 mime 白名单 / image-type.js 魔数）。
      // File type=基 mime（白名单正则锚定整串）；文件名带对应扩展名兜底
      // extOf 显式 ext 分支。
      const ext = extOf(mime)
      const stamp = new Date(startedAt)
      const p = (n: number): string => String(n).padStart(2, '0')
      const name = `voice-${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}${p(stamp.getSeconds())}${ext}`
      const file = new File([blob], name, { type: mime })
      const fd = new FormData()
      fd.append('files', file, name)
      const data = await api<{ ok?: boolean; items?: Array<{ id?: string; kind?: string; error?: string }> }>(
        '/api/web/upload',
        { method: 'POST', body: fd },
      )
      const item = data.items?.[0]
      if (!item?.id) {
        voiceError.value = `录音上传失败：${item?.error || '未知错误'}`
        return
      }
      // 独立成条（text=''：orchestrator 仅对无文本音频转写）；草稿暂存/恢复
      // ——语音条不吃草稿、发送失败草稿也不丢。kind 恒 'audio'（录音 blob 恒
      // 音频家族，异常形状不透传成 image）
      const saved = options.draft.value
      options.draft.value = ''
      /** 发送链走完后的草稿恢复值（重试让位窗口内用户可能有新输入） */
      let finalDraft = saved
      try {
        const att = [{ id: item.id, kind: 'audio' }]
        let ok = await options.send(att)
        if (!ok) {
          // §10-38 sending 在途竞态（walkie 登记改法，单点修复在 finish）：
          // 录音中经键盘 Enter 抢先触发文本发送时 sending 锁 early-false
          // （useChat.ts:565），语音条会被误报失败。让位 300ms 重试一次
          // ——锁路径零副作用，重试安全；真失败（网络/5xx）多试一次无害，
          // 仍败才报错。让位窗口内用户若已输入，记为恢复值不吞字
          await new Promise((r) => setTimeout(r, SEND_RETRY_MS))
          finalDraft = options.draft.value
          options.draft.value = ''
          ok = await options.send(att)
        }
        if (!ok) voiceError.value = '语音条发送失败'
      } finally {
        options.draft.value = finalDraft
      }
    } catch (err) {
      voiceError.value = `语音发送失败：${err instanceof Error ? err.message : String(err)}`
    } finally {
      recState.value = 'idle'
    }
  }

  onUnmounted(() => {
    // 卸载丢弃在途录音（不发送）：停流清定时器摘监听，组件销毁不留句柄
    detachHoldListeners()
    clearTimers()
    releaseStream()
    discardNext = true
    try { recorder?.stop() } catch { /* 已 inactive：无 onstop 兜底需要 */ }
    recorder = null
    chunks = []
    recState.value = 'idle'
    cancelPending.value = false
  })

  return {
    /** 按钮显隐（非安全上下文/无 MediaRecorder=false） */
    voiceSupported,
    /** 录音链路在途（按钮禁用/样式；含 starting/sending） */
    voiceActive,
    /** 提示条文案（错误优先；两视图共用同一份文案） */
    voiceNote,
    voiceIsError,
    /** 录音态（视图样式钩子：recording=脉冲、cancelPending=取消色） */
    recState,
    cancelPending,
    voiceError,
    /** 手势接线：@pointerdown.prevent="pressStart"；pressStart 内
     *  setPointerCapture 锁按钮+距离阈值取消判定（T1 手感修复），pointerup/
     *  pointercancel/pointermove 仍挂 window（capture 下重定向事件冒泡可达，
     *  capture 失败降级时原生跟随） */
    pressStart,
    clearVoiceError,
  }
}
