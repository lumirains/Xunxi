<!-- ============================================================
     AudioBubblePlayer —— W1 消息语音条自绘播放键（night-plan-polish §2-W1.1）
     弃 <audio controls> 原生控件：自绘 ▶/⏸ 圆形小按钮 + 时长文本，置于句子
     前面（气泡内文本行上方独立一行，Chat/Pwa 两视图同款组件）。
     播放面 = 隐藏控件 <audio> 元素 + 按钮驱动 play/pause（iOS Safari 兼容
     路径——元素静态挂模板、按组件实例复用，useVoiceCall elPlayer 同款纪律；
     桌面同路径=实现最简）。点击播放期间再点 = 暂停/恢复；ended 后再点 = 重播。
     缓冲/加载态：waiting → 圈圈；playing/canplay 清除。加载失败（404/网络）
     → 禁用态 + 「无法播放」。
     刷新后可播：src=/api/media/<id> 存档 URL 不变，无任何会话状态。
     iOS 静音解锁（useVoiceCall SILENT_AUDIO 同款）：play() 被拒（手势外/系统
     打断）时，同一手势窗口内先播 100ms 静音段解锁元素，再回真实 src 重试一次。
     ============================================================ -->
<template>
  <div class="abp-row">
    <button
      type="button"
      class="abp-btn"
      :class="{ playing: playing }"
      :disabled="failed"
      :title="btnTitle"
      :aria-label="btnTitle"
      @click="toggle"
    >
      <svg v-if="loading" class="abp-spin" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.6" />
        <path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <svg v-else-if="playing" width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
        <rect x="2" y="1.5" width="3" height="9" rx="0.8" fill="currentColor" />
        <rect x="7" y="1.5" width="3" height="9" rx="0.8" fill="currentColor" />
      </svg>
      <svg v-else width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.5 1.5v9l8-4.5z" fill="currentColor" />
      </svg>
    </button>
    <span class="abp-dur">{{ durText }}</span>
    <span v-if="failed" class="abp-err">无法播放</span>
    <!-- 隐藏音频元素（W1：controls 移除、驱动全在按钮）；preload=metadata 取时长 -->
    <audio
      ref="el"
      class="abp-audio"
      :src="src"
      preload="metadata"
      @loadedmetadata="onMeta"
      @ended="onEnded"
      @pause="onPause"
      @error="onErr"
    ></audio>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
// iOS 静音解锁同件常量 SILENT_AUDIO 从 useVoiceCall.ts 导出复用（单一事实源）
import { SILENT_AUDIO } from '../composables/useVoiceCall'

const props = defineProps<{ src: string }>()

const el = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const loading = ref(false)
const failed = ref(false)
/** 时长（秒；-1 = 元数据未就绪——个别容器读不到时显示占位文案） */
const seconds = ref(-1)

const durText = computed(() => {
  const s = seconds.value
  if (s < 0 || !Number.isFinite(s)) return '语音'
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return `${m}:${String(r).padStart(2, '0')}`
})

const btnTitle = computed(() => {
  if (failed.value) return '音频无法播放'
  return playing.value ? '暂停' : '播放语音'
})

function onMeta(): void {
  const d = el.value?.duration
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) seconds.value = d
}
function onEnded(): void {
  playing.value = false
  loading.value = false
}
function onPause(): void {
  playing.value = false
  loading.value = false
}
function onErr(): void {
  // 加载期失败（404/坏件）才置错误禁用态；播放中被打断的失败走 play() catch
  if (!playing.value) failed.value = true
  loading.value = false
}

/** 点击：播放中 = 暂停（再点恢复）；否则起播。iOS：play 在点击手势内直接放行；
 *  被拒时同一手势窗口内先播静音段解锁（SILENT 解锁同款）再回真实 src 重试一次。 */
async function toggle(): Promise<void> {
  const a = el.value
  if (!a || failed.value) return
  if (playing.value) {
    a.pause()   // @pause 置态
    return
  }
  loading.value = true
  try {
    await a.play()
    playing.value = true
    loading.value = false
  } catch {
    try {
      a.src = SILENT_AUDIO
      await a.play()
      a.src = props.src
      await a.play()
      playing.value = true
      loading.value = false
    } catch {
      // 仍被拒：回 ▶ 态，下次点击是新的手势
      playing.value = false
      loading.value = false
    }
  }
}
</script>

<style scoped>
.abp-row {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.abp-btn {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--card);
  color: var(--ink);
  cursor: pointer;
}

.abp-btn.playing {
  color: var(--warm);
}

.abp-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.abp-spin {
  width: 12px;
  height: 12px;
  animation: abp-rot 0.8s linear infinite;
}

@keyframes abp-rot {
  to {
    transform: rotate(360deg);
  }
}

.abp-dur {
  font-size: 11px;
  color: var(--ink-2);
  letter-spacing: 0.03em;
  font-variant-numeric: tabular-nums;
}

.abp-err {
  font-size: 10px;
  color: var(--ink-2);
  opacity: 0.8;
}

.abp-audio {
  display: none;
}
</style>
