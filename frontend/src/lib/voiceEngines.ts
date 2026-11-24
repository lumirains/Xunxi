/* ============================================================
   本地语音引擎「拉起」结果的统一文案（2026-11-20）。
   背景：Settings 的 W1 快捷开关只在「关闭→打开」时调 /api/voice/ensure；
   重开应用后配置仍是 enabled=true，不会再触发拉起。新增的「拉起本地引擎」
   按钮直接调同一端点，这里把 asr/tts/warmup 结果整理成一句人话，
   Sessions（整理记忆按钮旁）与 Settings（状态卡）共用，避免两套口径。
   ============================================================ */
import type { VoiceEnsureResult } from './api'

export interface EngineLaunchSummary {
  /** ok=至少一个已就绪；info=没配置/无返回；bad=配置了但未就绪 */
  kind: 'ok' | 'info' | 'bad'
  text: string
  configured: boolean
}

export function describeEnsureResult(result?: VoiceEnsureResult | null): EngineLaunchSummary {
  if (!result) return { kind: 'info', text: '引擎联动没有返回结果，稍后再试一次', configured: false }

  const asr = result.asr
  const tts = result.tts
  const configured = Boolean(asr?.configured || tts?.configured)
  if (!configured) {
    return {
      kind: 'info',
      text: '没有可拉起的本地引擎：先到「设置 → 语音电话」配好 ASR/TTS，并确认语音总开关与对应引擎开关已打开',
      configured: false,
    }
  }

  const parts: string[] = []
  let bad = false
  for (const [label, st] of [['ASR', asr], ['TTS', tts]] as const) {
    if (!st?.configured) {
      parts.push(`${label} 未配置`)
      continue
    }
    if (st.ok) {
      parts.push(`${label} ${st.spawned ? '已拉起' : '已在运行'}`)
    } else {
      bad = true
      parts.push(`${label} 未就绪：${st.reason || '未知原因'}`)
    }
  }

  if (result.warmup) {
    parts.push(result.warmup.ok
      ? `TTS 预热 ✓ ${result.warmup.ms ?? 0}ms`
      : 'TTS 预热未完成（不碍使用，首句稍慢）')
  }
  if (result.bothDown) parts.push('双引擎都不可用')

  return {
    kind: bad ? 'bad' : 'ok',
    text: `本地引擎：${parts.join('；')}`,
    configured: true,
  }
}
