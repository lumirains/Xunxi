<script setup lang="ts">
// ============================================================
// 对话页（web 身体前端，night-plan-web-body §4 W6 / web-body-plan Step 6）：
//   · 交互/数据逻辑自 P1 起收进 composables/useChat.ts（night-plan-pwa §P1，
//     抽取=搬运不是重写）：load/发送/乐观插入/mid 去重/typing/刷新在途锁
//     + SSE 接线全部在 composable 内；本视图与 Pwa.vue（移动 chat-only 壳）
//     共用同一实现。
//   · L5（night-plan-life §L5.1）ChatDemo 对标——桌面红线已解除（所有者
//     明确要求会话页对标），Chat.vue 与 Pwa.vue 手感同升：
//     1. 气泡排版（§L5.1-1）：微信式时间标签 + 同发言者连续分组（与 Pwa
//        共用 buildChatRenderList）；逐条 meta 时间行移除（ChatDemo 全列表
//        不渲染逐条时间戳=时间密度收敛到间隔标签）；左右语义对齐 PWA/
//        ChatDemo（用户右·陶橙淡底，Xunxi左·白卡面——桌面原 self:true=右
//        的观测语义翻转，交接登记）；媒体渲染接 entryImageIds 归一（历史
//        entry.media 补渲染）。
//     2. 流式打字机（§L5.1-2）：SSE 分条到达后渲染端逐字显现（useChat
//        reveal 游标，桌面与 PWA 同享）；输入区发送↔停止态互换（ChatDemo
//        ChatInput 语义），停止=finishReveals() 跳过动画立即显示全文——
//        纯渲染端，后端无停止端点（勘察登记）。
//     3. 输入区微交互（§L5.1-3）：单行自增高 textarea（1-4 行，回车发送/
//        Shift+回车换行/组字回车不上屏）+ ChatDemo 式 wrapper 卡（附件条+
//        正文+按钮行同卡）；发送/停止按钮圆形图标化（PWA 同款 40px）。
//     4. 粘贴/拖拽图片入口补差（§L5.1-4）：上传链路 P3 已有（POST
//        /api/web/upload → mediaId 暂存区 → 随文发送），桌面新增 附件按钮/
//        粘贴/拖拽 三入口 + 暂存缩略图条——逻辑在 composables/useUploads.ts
//        与 Pwa 共用（抽取=搬运）。
//   · 拖拽计数式 dragenter/leave 判定与全屏遮罩交互 adapted from DeepSeek
//     chat-demo src/components/chatInput/DragMask.tsx
//     （MIT License · Copyright (c) 2026 DeepSeek）——Vue 习语重写。
//   · 数据链路（细节见 useChat.ts 头注）：
//     历史 = GET /api/web/messages；发送 = POST /api/web/send，乐观插入、
//     失败撤回还草稿；AI 回复 = SSE 'chat-message' 按 messageId 去重 +
//     打字机逐字显现；正在输入 = SSE 'chat-typing' 三点动画；复用
//     lib/sse.ts 唯一一条 EventSource。
// 第一版不做：语音/已读/引用/多会话/虚拟滚动（plan Step 6 明文）；L5 不抄
// ChatDemo 的多会话/语音/Mermaid/KaTeX/IndexedDB（计划 §L5.1 明文）。
// ============================================================
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  buildChatRenderList, callRecallBody, callRecallDuration, chatDisplayText, entryAudioIds, entryImageIds, fmtDaySepLabel, fmtExactTime, fmtSepTime, MAX_ATTACHMENTS, useChat,
} from '../composables/useChat'
import { useUploads } from '../composables/useUploads'
import { useVoiceRec } from '../composables/useVoiceRec'
import { useVoiceCall } from '../composables/useVoiceCall'
import AudioBubblePlayer from '../components/AudioBubblePlayer.vue'
import { fetchConfig, saveConfigPatch } from '../lib/api'
import type { VoiceConfig } from '../lib/types'

// 列表容器（DOM 绑定留视图层：模板 `ref="listEl"` 持有，贴底滚动由 useChat 负责）
const listEl = ref<HTMLDivElement | null>(null)

const {
  entries, draft, loading, loadError, sendError, sending, typingOn, sseState,
  cid, revealing, send, finishReveals, reconnect,
} = useChat({ cid: 'main', listEl })

// ── S2 设计稿二：连接状态点三态 + 点击=手动重连（替代原「刷新」按钮语义）──
// 绿=连接 / 琥珀=重连中 / 灰=离线（视觉规格口径）；hover 提示可点。
const connTitle = computed(() =>
  sseState.value === 'connected'
    ? '实时已连接 · 点击重连'
    : sseState.value === 'offline'
      ? '实时连接已离线 · 点击重连'
      : '实时重连中… · 点击重连',
)

// 展示序列：时间标签 + 分组标记（与 Pwa.vue 共用，桌面新采纳）
const renderList = computed(() => buildChatRenderList(entries.value))

// ── L5 图片上传/暂存（useUploads 共享 composable，与 Pwa 同实现）────────
const {
  staged, uploadError, uploading, addFiles, removeStaged, clearError, mediaFilesOf,
} = useUploads()

// ── S6 按住说话（asr-tts-design §2.1 站① / 一期3）：MediaRecorder 录音
//    → V0 上传链路 → send 独立成条（录音/手势/上传逻辑在 useVoiceRec，
//    与 Pwa 共用；录得 blob 走 kind:'audio' 链 → orchestrator '[语音]' 占位
//    → V1 ASR 转写注入）。非安全上下文（HTTP）/无 MediaRecorder 按钮隐藏。
const {
  voiceSupported, voiceActive, voiceNote, voiceIsError,
  recState, cancelPending, pressStart, clearVoiceError,
} = useVoiceRec({ send, draft })

// ── T3 电话模式（V2 前半场，night-plan §2-T3）：通话覆盖层 + 独立 WS
//    /api/voice（D16；状态机/播放/换档全在 useVoiceCall）。入口=输入栏
//    电话按钮（微信式「+」面板=T7；enabled&&call.enabled 关闭时禁用不假装
//    能拨——T7「显示开发中并给一句说明」口径一致）。start() 必须在点击
//    手势内调用（iOS AudioContext 解锁前提，design §13.1-③）。
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

/** 引擎配置面（§10.2 降级链的入口级判据）：ASR/TTS 任一配了引擎+baseUrl 即可拨
 *  （单边缺失走通话内降级：TTS 缺=她纯文字 / ASR 缺=你打字）；双边皆缺=纯文字对
 *  纯文字=普通聊天，电话入口无意义 → 置灰给原因 */
function engineCfgd(e?: { engine?: string; baseUrl?: string }): boolean {
  return !!e && String(e.engine ?? 'off') !== 'off' && !!String(e.baseUrl ?? '').trim()
}
/** 通话入口闸（电话项 disabled 依据）：开关面 + 引擎任一在册 */
const voiceGateOk = computed(() =>
  callSwitchOk.value && (engineCfgd(voiceCfg.value?.asr) || engineCfgd(voiceCfg.value?.tts)))

const fileInput = ref<HTMLInputElement | null>(null)

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
  } catch { /* 缺省"汐"即可，不拖垮聊天页 */ }
}

// ── 通话覆盖层接线（T3）──────────────────────────────────────────────────
/** 通话内文字草稿（与消息 draft 分离——通话逐句不进 messages，D15/D17） */
const callDraft = ref('')
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

// ── T7 D19 微信式「+」面板（design §2.4 / night-plan §2-T7.1）：点+上方展开
//    【图片、电话】；点外部/再点+/Esc 收起；打开面板失焦收软键盘（软键盘跟随
//    焦点，blur 即收）。麦克风不进面板（常驻触摸目标——面板收起会丢按住说话
//    的按压目标），发送钮照旧在右。 ─────────────────────────────────────
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

// ── W1 通话覆盖层语音回复开关（night-plan-polish §2-W1.3）：voice.tts.enabled
//    即时 POST /api/config（初值读 voiceCfg——本视图已拉 config）；服务端逐句
//    现读闸（ttsCall 每句 ttsGate），改后**下一句起生效**——提示语给生效时点。 ──
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

/** 附件按钮 → 打开文件选择（accept/multiple 在 input 属性上） */
function pickImages(): void {
  fileInput.value?.click()
}

/** 选文件落地：input 复位允许连选同一文件；逐个上传进暂存区（useUploads） */
async function onFilesPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  await addFiles(files)
}

/** 粘贴图片/音频：仅当剪贴板带媒体文件时拦截默认粘贴（纯文本粘贴不受影响） */
function onPaste(e: ClipboardEvent): void {
  const files = mediaFilesOf(Array.from(e.clipboardData?.files ?? []))
  if (!files.length) return
  e.preventDefault()
  void addFiles(files)
}

/* ── 拖拽上传（全屏遮罩 + 计数式 dragenter/leave，adapted from DeepSeek
   chat-demo src/components/chatInput/DragMask.tsx，MIT License ·
   Copyright (c) 2026 DeepSeek）：页面任意位置拖入图片即显示遮罩，松手
   交给 drop。dragenter/leave 在子元素间反复触发，用计数判断是否真正离开。 */
const dragging = ref(false)
let dragDepth = 0

function hasFiles(ev: DragEvent): boolean {
  return Array.from(ev.dataTransfer?.types ?? []).includes('Files')
}

function onDragEnter(ev: DragEvent): void {
  if (!hasFiles(ev)) return
  dragDepth++
  dragging.value = true
}

function onDragLeave(ev: DragEvent): void {
  if (hasFiles(ev) && --dragDepth <= 0) {
    dragDepth = 0
    dragging.value = false
  }
}

function onDragOver(ev: DragEvent): void {
  if (hasFiles(ev)) ev.preventDefault() // 允许 drop（否则浏览器打开文件）
}

function onDrop(ev: DragEvent): void {
  if (!hasFiles(ev)) return
  ev.preventDefault()
  dragDepth = 0
  dragging.value = false
  const all = Array.from(ev.dataTransfer?.files ?? [])
  const images = mediaFilesOf(all)
  if (!images.length && all.length) {
    uploadError.value = '只支持图片/音频文件'
    return
  }
  if (images.length) void addFiles(images)
}

onMounted(() => {
  void loadBotIdentity()
  document.addEventListener('dragenter', onDragEnter)
  document.addEventListener('dragleave', onDragLeave)
  document.addEventListener('dragover', onDragOver)
  document.addEventListener('drop', onDrop)
  // T7「+」面板：Esc 收起 + 点外部收起（挂 document，面板不持焦点也能收）
  document.addEventListener('keydown', onDocKeydown)
  document.addEventListener('pointerdown', onDocPointerdown)
  // T7 通话入口闸：/api/config 实读 voice 段全量（失败=闸关，电话项禁用不假装能拨）
  void fetchConfig()
    .then((c) => { voiceCfg.value = c?.voice ?? null })
    .catch(() => { voiceCfg.value = null })
})

onUnmounted(() => {
  document.removeEventListener('dragenter', onDragEnter)
  document.removeEventListener('dragleave', onDragLeave)
  document.removeEventListener('dragover', onDragOver)
  document.removeEventListener('drop', onDrop)
  document.removeEventListener('keydown', onDocKeydown)
  document.removeEventListener('pointerdown', onDocPointerdown)
})

// ── L5 输入区：textarea 自适应 1-4 行（Pwa 同款 JS autoGrow 手法）────────
const inputEl = ref<HTMLTextAreaElement | null>(null)
/** 4 行上限 ≈ line-height 21px（14px×1.5）×4 + 上下 padding 6px×2 → 96 */
const INPUT_MAX_H = 96

function autoGrow(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_H)}px`
}

// 草稿变化（输入/清空）都重算高度；nextTick 等程序化清空先落到 DOM
watch(draft, () => { void nextTick(autoGrow) })

/** 回车发送 / Shift+回车换行；输入法组字中的回车不上屏（isComposing） */
function onEnter(e: KeyboardEvent): void {
  if (e.shiftKey || e.isComposing) return
  e.preventDefault()
  void submitChat()
}

/** 发送（文本 + 暂存媒体）：先取走暂存项，发送失败按原序整项还回暂存区
 *  （Pwa 同口径）；发送即完成上一条的逐字显现（不打断回话动线）。
 *  V0 音频（spec §2.8）：暂存项带 kind 直接以 { id, kind } 形态透传
 *  （useChat.send → 后端，string 形态仍等价 image）。 */
async function submitChat(): Promise<void> {
  if (revealing.value) finishReveals()
  const items = [...staged.value]
  const payload = items.map((s) => ({ id: s.id, kind: s.kind }))
  staged.value = []
  const sent = await send(payload)
  if (!sent) {
    staged.value = [...items, ...staged.value]
    return
  }
  void nextTick(() => { inputEl.value?.focus() }) // ChatDemo ChatInput send 后回焦
}

/** 头部提示条点击：清除语音/上传错误提示（历史/发送错误归刷新按钮口径） */
function onNoteClick(): void {
  if (voiceIsError.value) {
    clearVoiceError()
    return
  }
  if (uploadError.value) clearError()
}
</script>

<template>
  <div class="chat-page">
    <div class="chat-head">
      <p
        class="head-note"
        :class="{ err: loadError || sendError || uploadError }"
        @click="onNoteClick"
      >
        <template v-if="loadError">历史加载失败：{{ loadError }}</template>
        <template v-else-if="sendError">发送失败：{{ sendError }}</template>
        <template v-else-if="voiceIsError">{{ voiceNote }}（点击清除）</template>
        <template v-else-if="voiceNote">{{ voiceNote }}</template>
        <template v-else-if="uploadError">{{ uploadError }}（点击清除）</template>
        <template v-else-if="loading">读取中…</template>
        <template v-else-if="uploading">图片上传中…</template>
        <template v-else>
          {{ entries.length }} 条 · {{ sseState === 'connected' ? '实时已连接' : '实时重连中…' }}
        </template>
      </p>
      <div class="head-actions">
        <!-- S2 设计稿二：三态连接状态点（绿=连接/琥珀=重连中/灰=离线），
             点击=手动重连一次（原「刷新」按钮与常亮琥珀「黄点」已移除——
             SSE 自动重连 + 断线恢复补拉已覆盖刷新语义；"N 条"计数保留在左侧） -->
        <button
          type="button"
          class="conn-dot"
          :class="sseState"
          :title="connTitle"
          aria-label="连接状态（点击重连）"
          @click="reconnect"
        ></button>
      </div>
    </div>

    <div ref="listEl" class="chat-list">
      <div v-if="!entries.length && !loading" class="chat-empty" :style="{ '--bot-name': `'${botName}'` }"><span>还没有消息，说点什么吧</span></div>
      <div v-else class="chat-list-inner">
        <template v-for="item in renderList" :key="item.kind === 'msg' ? `${cid}-${item.entry.id}` : item.key">
          <!-- 跨日居中分隔线（S2 设计稿二）：—— 昨天 · 11-16 —— -->
          <div v-if="item.kind === 'day'" class="day-sep">
            <span>{{ fmtDaySepLabel(item.ts) }}</span>
          </div>
          <!-- 微信式时间标签（5 分钟间隔；今天 HH:MM，更早 M月D日 HH:MM） -->
          <div v-else-if="item.kind === 'time'" class="time-sep">
            <span>{{ fmtSepTime(item.ts) }}</span>
          </div>

          <!-- 消息行：!self = 用户 = 右侧（L5 对齐 PWA/ChatDemo）；self = Xunxi = 左侧 -->
          <div
            v-else
            class="chat-row"
            :class="{ 'is-owner': !item.entry.self, 'is-grouped': item.grouped }"
          >
            <!-- T6 通话回想条（design §8.2）：self 行带 [通话 M:SS] 前缀 → 居中细条
                 带时长，非气泡；正文=回想内容（前缀由后端代码拼装，渲染端剥掉） -->
            <div
              v-if="item.entry.self && callRecallDuration(item.entry.text)"
              class="call-recall-bar"
              :data-time="fmtExactTime(item.entry.ts)"
            >
              <span class="call-recall-head">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 5c0-1 1-2 2-2h2c.8 0 1.5.5 1.8 1.3l.9 2.6c.2.7 0 1.5-.6 2l-1.3 1a12.5 12.5 0 0 0 5.3 5.3l1-1.3c.5-.6 1.3-.8 2-.6l2.6.9c.8.3 1.3 1 1.3 1.8v2c0 1-1 2-2 2A16.9 16.9 0 0 1 4 5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                </svg>
                <span>通话 {{ callRecallDuration(item.entry.text) }}</span>
              </span>
              <span v-if="callRecallBody(item.entry.text)" class="call-recall-text">{{ callRecallBody(item.entry.text) }}</span>
            </div>
            <div
              v-else
              class="bubble"
              :class="{
                'bubble-owner': !item.entry.self,
                'bubble-her': item.entry.self,
                pending: item.entry.pending,
              }"
              :data-time="fmtExactTime(item.entry.ts)"
            >
              <!-- W1 媒体层音频化·自绘播放键：置于句子前面（文本行上方独立一行，
                   Chat/Pwa 两视图同款组件；弃 <audio controls> 原生控件） -->
              <div v-if="entryAudioIds(item.entry).length" class="bubble-audio">
                <AudioBubblePlayer
                  v-for="id in entryAudioIds(item.entry)"
                  :key="id"
                  :src="`/api/media/${id}`"
                />
              </div>
              <p v-if="item.entry.text" class="bubble-text">{{ chatDisplayText(item.entry) }}</p>
              <!-- 媒体层：entryImageIds 归一（live mediaIds ∪ 历史 entry.media） -->
              <div v-if="entryImageIds(item.entry).length" class="bubble-media">
                <img
                  v-for="id in entryImageIds(item.entry)"
                  :key="id"
                  :src="`/api/media/${id}`"
                  alt="图片消息"
                  loading="lazy"
                />
              </div>
              <!-- 发送中标记（时间已移入间隔标签，气泡内只保留发送中状态） -->
              <span v-if="item.entry.pending" class="bubble-pending-badge">发送中…</span>
            </div>
          </div>
        </template>
      </div>
    </div>

    <div class="chat-typing-row" aria-live="polite">
      <span v-if="typingOn" class="typing" title="她正在输入…">
        <i></i><i></i><i></i>
      </span>
    </div>

    <!-- 输入区：ChatDemo ChatInput 式单卡（暂存条 + 正文 + 按钮行） -->
    <form class="chat-input-block" @submit.prevent="submitChat">
      <!-- L5 暂存区：已上传待发送媒体（V0 音频：音频件不渲染缩略图，出图标件） -->
      <div v-if="staged.length" class="chat-staged" aria-label="待发送媒体">
        <span v-for="s in staged" :key="s.id" class="chat-staged-item">
          <span v-if="s.kind === 'audio'" class="chat-staged-audio" title="待发送音频">♪</span>
          <img v-else :src="s.url" :alt="s.name || '待发送图片'" loading="lazy" />
          <button type="button" class="chat-staged-x" title="移除" @click="removeStaged(s.id)">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </span>
      </div>

      <!-- T7 D19 微信式「+」面板：点+上方展开【图片、电话】（design §2.4）；
           点外部/再点+/Esc 收起由 document 监听处理。 -->
      <transition name="plus-fade">
        <div v-if="plusOpen" ref="plusPanel" class="chat-plus-panel" role="menu" aria-label="更多功能">
          <button class="chat-plus-item" type="button" title="发送图片/音频（最多 10 个）" @click="onPanelImages">
            <span class="chat-plus-item-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.5"/>
                <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/>
                <path d="M3 15l5-5 4 4 2-2 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <span class="chat-plus-item-label">图片</span>
          </button>
          <!-- 电话项（V2 独立钮 T3 迁入面板——handoff §9-16 预告的重排）：
               闸关=禁用+「开发中」/「引擎未配置」标签，不假装能拨（T7 口径）。 -->
          <button
            class="chat-plus-item"
            type="button"
            :title="phoneTitle"
            :aria-label="phoneTitle"
            :disabled="!voiceGateOk"
            @click="onPanelCall"
          >
            <span class="chat-plus-item-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M7.1 3.6c.5 0 .9.3 1 .8l.7 3c.1.4 0 .8-.3 1.1L6.9 10c1 2.2 2.9 4.1 5.1 5.1l1.5-1.6c.3-.3.7-.4 1.1-.3l3 .7c.5.1.8.5.8 1v3.1c0 .6-.5 1-1 1C9.4 19 5 14.6 5 6.6c0-.5.4-1 1-1h1.1z" fill="currentColor"/>
              </svg>
            </span>
            <span class="chat-plus-item-label">{{ phoneLabel }}</span>
          </button>
        </div>
      </transition>

      <!-- T7 D19 微信式底栏：+（左）+文本输入+麦克风（右）+发送（右）；
           麦克风不进面板（design §2.4：按住说话需要常驻触摸目标）。 -->
      <div class="chat-input-row">
        <button
          ref="plusBtn"
          class="chat-icon-btn chat-plus-btn"
          type="button"
          title="更多：图片、电话"
          aria-label="更多功能（图片、电话）"
          :aria-expanded="plusOpen"
          @click="togglePlus"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
          class="chat-input"
          rows="1"
          placeholder="输入消息，回车发送；Shift+回车换行"
          autocomplete="off"
          :disabled="sending"
          @keydown.enter="onEnter"
          @paste="onPaste"
        ></textarea>

        <div class="chat-input-actions">
          <!-- S6 按住说话（asr-tts-design §2.1 站①）：按住录音/松开发送/移开
               取消（T1：setPointerCapture 锁按钮+距离阈值 48px 判定），≤60s
               自动截断；非安全上下文或无 MediaRecorder 时隐藏。
               pointerup/pointercancel/pointermove 在 useVoiceRec 内挂 window
               （capture 下重定向事件冒泡可达）；录得 blob 走 V0 上传链路
               （kind:'audio'）。 -->
          <button
            v-if="voiceSupported"
            class="chat-icon-btn chat-mic-btn"
            type="button"
            title="按住说话（松开发送，移开取消，最长 60 秒）"
            aria-label="按住说话"
            :class="{ 'is-rec': recState === 'recording', 'is-cancel': cancelPending }"
            :disabled="sending || voiceActive"
            @pointerdown.prevent="pressStart"
            @contextmenu.prevent
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="1.5"/>
              <path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M12 18v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
          <!-- 发送↔停止态互换（ChatDemo ChatInput.tsx:263-285 语义）：
               停止=跳过打字动画立即显示全文（纯渲染端） -->
          <button
            v-if="revealing"
            class="chat-send-btn is-stop"
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
            class="chat-send-btn"
            type="submit"
            :disabled="sending || (!draft.trim() && !staged.length)"
            title="发送"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 20V4M5 11l7-7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    </form>

    <!-- 拖拽遮罩（全屏，松手即传） -->
    <transition name="mask-fade">
      <div v-if="dragging" class="drag-mask">
        <div class="drag-card">
          <p class="drag-title">松开即发送图片</p>
          <p class="drag-desc">支持粘贴或拖入图片，一次最多 {{ MAX_ATTACHMENTS }} 张</p>
        </div>
      </div>
    </transition>

    <!-- T3 通话覆盖层（V2 前半场，spec §2.5）：状态行（呼叫中/准备声音/
         她在想…/她正在说…/通话中/已结束）+ 文字输入 → 她说话 + 挂断钮；
         text_fallback 降级行内嵌显示；audioBlocked（iOS 来电打断）出
         「点一下继续」手势按钮（design §13.1-③）。 -->
    <transition name="mask-fade">
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
/* ============================================================
   L5 桌面会话页（ChatDemo 对标，纸张风 token 内）：
   左右语义对齐 PWA（用户右·陶橙淡底 / Xunxi左·白卡面）、微信式时间标签、
   同发言者分组紧凑间距、气泡非对称切角（6px 基准 = radius-card 纪律）、
   输入区单卡（暂存条+正文+按钮行）、发送↔停止圆形图标钮。
   ============================================================ */
.chat-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-height: 0;
}

.chat-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  /* S2 设计稿五：阅读型页主列 1040（chat 在列；原「灯下」信笺 700px 被
     2026-11-17 拍板的设计稿五分级覆盖——偏差登记 handoff §10-14） */
  max-width: 1040px;
  margin: 0 auto;
}

.head-note {
  margin: 0;
  color: var(--ink-2);
  font-size: 12px;
}

.head-note.err {
  color: var(--accent);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

/* ── 连接状态点（S2 设计稿二）：三态可点按钮替代原「刷新」+常亮黄点 ──
   绿=连接 / 琥珀=重连中（脉冲）/ 灰=离线；hover 出"点击重连"提示（title） */
.conn-dot {
  appearance: none;
  padding: 0;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  cursor: pointer;
}

.conn-dot::after {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--line-strong);
  animation: conn-pulse 1.4s infinite ease-in-out;
  transition: background 0.15s ease;
}

.conn-dot.connected::after {
  background: var(--olive);
  animation: none;
}

.conn-dot.offline::after {
  background: var(--ink-2);
  opacity: 0.45;
  animation: none;
}

@keyframes conn-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.chat-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-1) 2px;
  scrollbar-gutter: stable; /* ChatDemo MessageList：滚动条出现不挤内容 */
}

.chat-list-inner {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  min-height: 100%;
  padding: var(--space-1) 0;
  /* 信笺窄栏（2026-11-16「灯下」）→ S2 设计稿五：阅读型 1040（覆盖登记 §10-14） */
  width: 100%;
  max-width: 1040px;
  margin: 0 auto;
}

/* ── 跨日居中分隔线（S2 设计稿二）：—— 昨天 · 11-16 ——（--ink-3 级小字，
   token 系统对应 --mist-3；线色 --line、上下呼吸间距 16px 口径） ──────── */
.day-sep {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin: 22px 0 14px;
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
  max-width: 160px;
  background: var(--line);
}

.day-sep:first-child {
  margin-top: 2px;
}

/* ── 时间标签：等宽 + 两侧细线（编辑式，不再是药丸） ──────── */
.time-sep {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: center;
  margin: 18px 0 10px;
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
  max-width: 120px;
  background: var(--line);
}

.time-sep span {
  font-family: var(--font-mono);
  color: var(--mist-3);
  letter-spacing: 0.08em;
}

/* ── 消息行：用户右（is-owner）/ Xunxi左；连续同侧紧凑分组 ───── */
.chat-row {
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  padding: 4px 0;
}

.chat-row.is-grouped {
  padding: 1px 0;
}

.chat-row.is-owner {
  justify-content: flex-end;
}

/* ── T6 通话回想条（design §8.2）：居中、细、带时长，非气泡——
   视觉同 day-sep 的居中淡字语言（--mist-3/衬线/hairline --line），不占气泡版式 ── */
.call-recall-bar {
  max-width: 78%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin: 2px 0;
  padding: 7px 16px;
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

/* ── 气泡：排版承担语义（衬线 = 她 / 无衬线 = 我 / 等宽 = 系统） ──
   W1 加宽：78%→84%（阅读型主列 1040 内 ≈874px；原 78%≈811px） */
.bubble {
  max-width: 84%;
  min-width: 48px;
  padding: 8px 12px;
  position: relative;
}

/* 汐（左侧）：陶土竖线 + 衬线，无卡面 —— 她的话直接落在纸上 */
.bubble-her {
  border-radius: 0;
  background: transparent;
  border: none;
  border-left: 2px solid var(--warm);
  padding-left: 18px;
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

/* ── 精确时间 tooltip（S2 设计稿二）：hover 气泡上浮显示（PWA 长按同款，
   由 .show-time 类触发）。底=--card（--bg-raised 对应 token）、字=--ink-2、
   4px 圆角、150ms 过渡；她=左对齐（竖线内），你=右对齐。 ── */
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
  left: 16px;
}

.bubble-owner::after {
  right: 0;
}

.bubble:hover::after {
  opacity: 1;
}

.bubble-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ink);
}

/* 她的话：衬线 + 宽行距；你的话：无衬线 */
.bubble-her .bubble-text {
  font-family: var(--font-serif);
  font-size: 17px;
  line-height: 1.95;
}

.bubble-owner .bubble-text {
  font-family: var(--font-sans);
  font-size: 14.5px;
  line-height: 1.75;
}

/* 媒体层：entryImageIds 归一渲染（PWA 同款限宽） */
.bubble-media {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.bubble-media img {
  display: block;
  max-width: min(260px, 72vw);
  max-height: 260px;
  border-radius: 6px;
  border: 1px solid var(--line);
}

/* W1 媒体层音频化·自绘播放键（组件自带按钮/时长样式）：行置于文本上方，
   间距改到行下（与后续文本行隔开） */
.bubble-audio {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 4px;
}

/* 发送中徽标（气泡内右下角，不占单独行） */
.bubble-pending-badge {
  display: block;
  margin-top: 3px;
  font-size: 10px;
  color: var(--ink-2);
  opacity: 0.7;
  text-align: right;
}

.chat-empty {
  position: relative;
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--mist-3);
  font-size: 13px;
}

/* 空状态：巨大的名字做水印（唯一一处大胆；名字读配置 botName，缺省"汐"） */
.chat-empty::before {
  content: var(--bot-name, "汐");
  position: absolute;
  font-family: var(--font-serif);
  font-weight: 300;
  font-size: 190px;
  line-height: 1;
  color: var(--warm);
  opacity: 0.09;
  pointer-events: none;
}

.chat-empty span {
  position: relative;
}

.chat-typing-row {
  flex: none;
  min-height: 18px;
  display: flex;
  align-items: center;
}

/* 三点动画：typingOn 起亮，首条 chat-message（打字机接管）收起 */
.typing {
  display: inline-flex;
  gap: 4px;
  padding: 0 4px;
}

.typing i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-2);
  animation: typing-blink 1.2s infinite ease-in-out;
}

.typing i:nth-child(2) {
  animation-delay: 0.2s;
}

.typing i:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes typing-blink {
  0%, 80%, 100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

/* ── 输入区单卡：ChatDemo ChatInput wrapper 结构（token 化重绘）──── */
.chat-input-block {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--card);
  box-shadow: var(--shadow);
  position: relative;   /* T7：「+」面板 absolute 锚点 */
  width: 100%;
  /* S2 设计稿五：阅读型 1040（覆盖登记 §10-14） */
  max-width: 1040px;
  margin: 0 auto;
}

/* 暂存区：已上传待发送图片缩略条 */
.chat-staged {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 2px 0;
}

.chat-staged-item {
  position: relative;
  flex: none;
}

.chat-staged-item img {
  display: block;
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--line);
}

/* V0 音频暂存件：不渲染缩略图，出音符字形件（与缩略图同尺寸盒） */
.chat-staged-audio {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 6px;
  border: 1px solid var(--line);
  color: var(--ink-2);
  font-size: 20px;
}

.chat-staged-x {
  position: absolute;
  top: -7px;
  right: -7px;
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink-2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.chat-staged-x:hover {
  color: var(--accent);
  border-color: var(--accent);
}

/* 正文：无边框融入卡面（focus 由卡面描边加亮承担） */
.chat-input {
  width: 100%;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--ink);
  resize: none;
  overflow-y: auto;
  max-height: 96px;
}

.chat-input:focus {
  outline: none;
}

.chat-input::placeholder {
  color: var(--ink-2);
  opacity: 0.65;
}

/* ── T7 D19 微信式底栏：+（左）+输入+麦克风（右）+发送（右）────────────── */
.chat-input-row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}

/* + 面板（点+上方展开【图片、电话】，design §2.4）：白卡圆角，横向排布，
   遮罩式投影与输入卡同语言；absolute 锚在输入卡上缘 */
.chat-plus-panel {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 60;
  display: flex;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--card);
  box-shadow: var(--shadow);
}

.chat-plus-item {
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
}

.chat-plus-item:hover:not(:disabled),
.chat-plus-item:active:not(:disabled) {
  background: var(--mist-1, rgba(0, 0, 0, 0.04));
  color: var(--accent);
}

.chat-plus-item-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  color: var(--ink-2);
}

.chat-plus-item:hover:not(:disabled) .chat-plus-item-icon,
.chat-plus-item:active:not(:disabled) .chat-plus-item-icon {
  border-color: var(--accent);
  color: var(--accent);
}

.chat-plus-item-label {
  font-size: 12px;
  color: var(--ink-2);
}

/* 电话项禁用态（闸关=「开发中」标签+不可点，T7「不假装能拨」） */
.chat-plus-item:disabled {
  opacity: 0.45;
  cursor: default;
  color: var(--ink-2);
}

.chat-plus-item:disabled .chat-plus-item-icon {
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

/* 按钮行：麦克风/发送右对齐（ChatDemo functionRow .right 同布局） */
.chat-input-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.chat-icon-btn {
  flex: none;
  width: 30px;
  height: 30px;
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
}

.chat-icon-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* T3 电话钮（T7 起迁入「+」面板为电话项，独立钮样式退役——
   .chat-phone-btn 类已不在模板，样式块随之移除；禁用语义由
   .chat-plus-item:disabled 承接） */

/* ── S6 按住说话：44px 圆钮（T1-2c 触摸目标下限，覆盖 .chat-icon-btn 的
   30px）+ ::after 外扩 8px 透明热区（伪元素命中计入按钮本体，
   getBoundingClientRect 仍取视觉 rect——useVoiceRec 取消判定基准不受热区
   影响）；录音中 accent 实底脉冲 / 移出阈值区=取消态红实底。
   touch-action:none 掐掉按住手势的滚动判定（pointercancel 不打断录音）；
   user-select/callout 防长按选中与 iOS 弹出放大镜。 ── */
.chat-mic-btn {
  position: relative;
  width: 44px;
  height: 44px;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

/* 外扩透明热区（命中测试计入按钮，无视觉变化） */
.chat-mic-btn::after {
  content: '';
  position: absolute;
  inset: -8px;
  border-radius: 50%;
}

.chat-mic-btn.is-rec {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  animation: mic-pulse 1.2s infinite ease-in-out;
}

.chat-mic-btn.is-cancel {
  background: #c0392b;
  border-color: #c0392b;
  color: #fff;
  animation: none;
}

.chat-mic-btn:disabled {
  cursor: default;
}

@keyframes mic-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.chat-send-btn {
  flex: none;
  width: 30px;
  height: 30px;
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
}

.chat-send-btn:hover:not(:disabled) {
  opacity: 0.88;
}

.chat-send-btn:active:not(:disabled) {
  transform: scale(0.93);
}

.chat-send-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

/* 停止态：同圆钮，墨黑底白方块（发送↔停止一眼可辨） */
.chat-send-btn.is-stop {
  background: var(--ink-strong);
}

/* ── 拖拽遮罩（token 纪律：无玻璃拟态——纸面半透明 + 虚线卡） ─── */
.drag-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: copy;
  pointer-events: none; /* 松手事件落到 document drop，遮罩不吃事件 */
  background: color-mix(in srgb, var(--paper) 80%, transparent);
}

.drag-card {
  padding: 20px 32px;
  border: 1px dashed var(--line-strong);
  border-radius: 6px;
  background: var(--card);
  text-align: center;
}

.drag-title {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 16px;
  color: var(--ink-strong);
}

.drag-desc {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--ink-2);
}

.mask-fade-enter-active,
.mask-fade-leave-active {
  transition: opacity 0.15s ease;
}

.mask-fade-enter-from,
.mask-fade-leave-to {
  opacity: 0;
}

/* ── T3 通话覆盖层（V2 前半场）：全屏遮罩 + 居中卡（纸张风 token 内）──── */
.call-mask {
  position: fixed;
  inset: 0;
  z-index: 1100; /* 高于拖拽遮罩（1000）：通话中拖拽上传不叠上来 */
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--paper) 88%, transparent);
}

.call-card {
  width: min(360px, calc(100vw - 48px));
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
  width: 64px;
  height: 64px;
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
  font-size: 13px;
  padding: 6px 16px;
  cursor: pointer;
}

.call-fallback {
  width: 100%;
  max-height: 180px;
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
}

/* W1 语音回复快捷开关（覆盖层内）：细边幽灵钮，不动通话卡主结构 */
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
  color: #c0392b; /* 同 .chat-mic-btn.is-cancel 的取消红（无 --danger token） */
}

.call-input-row {
  width: 100%;
  display: flex;
  gap: 8px;
}

.call-input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper);
  color: var(--ink);
  font-size: 14px;
}

.call-input:focus {
  outline: none;
  border-color: var(--accent);
}

.call-send {
  padding: 8px 16px;
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
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: none;
  background: #c0392b; /* 取消红同源（.chat-mic-btn.is-cancel） */
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

.call-dismiss {
  padding: 8px 24px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--ink-2);
  font-size: 14px;
  cursor: pointer;
}
</style>
