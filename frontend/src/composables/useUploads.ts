/* ============================================================
   useUploads —— 媒体上传/暂存共享逻辑（L5，night-plan-life §L5.1-4）：
   从 Pwa.vue 原样抽取（选图→逐张上传→暂存区→错误提示），P3 行为逐项保持：
   · 逐张单 POST /api/web/upload（单张失败不整批失败，已成功的保留）
   · ≤MAX_ATTACHMENTS 上限在选择阶段先挡（与后端 UPLOAD_MAX_FILES 对齐）
   · input.value 复位由视图层做（允许连选同一文件）
   · 暂存区还回由调用方按 send 返回值处理（composable 只管收发）
   L5 新增两个入口补差（上传链路同一）：
   · addFiles(files)——粘贴/拖拽入口（Chat.vue 桌面 + Pwa.vue 文本框粘贴），
     与文件选择共用同一校验与逐张上传；非图片文件过滤（链路语义=图片，
     entry.media 只有 kind:'image' 可渲染）。
   · 生命周期纪律同 useChat：须在视图 setup 内调用（staged/uploadError/
     uploading 为实例内 ref，两视图互不共享）。
   V0 媒体层音频化（asr-tts-v0-execution-spec §2.8，明确的临时件）：
   · imageFilesOf → mediaFilesOf（放行 audio/*，spec §2.8 明文允许改名）；
   · StagedMedia 增 kind（'image'|'audio'）——以上传响应 items[].kind 为准
     （后端魔数/白名单判定，比浏览器 file.type 可信：.webm 录音常被标
     video/webm），响应无 kind 时按 file.type 兜底；
   · 发送随 { id, kind } 映射（视图侧把 staged 项直接传 useChat.send）。
   ============================================================ */
import { ref } from 'vue'
import { api } from '../lib/api'
import { MAX_ATTACHMENTS } from './useChat'

export type StagedKind = 'image' | 'audio'
export interface StagedMedia { id: string; url: string; name: string; kind: StagedKind }

export function useUploads() {
  const staged = ref<StagedMedia[]>([])
  const uploadError = ref('')
  const uploading = ref(false)

  /** 过滤出图片/音频文件（粘贴/拖拽可能混入其它文件——上传链路
   *  accept=image/*,audio/* 同口径只收这两类；spec §2.8） */
  function mediaFilesOf(files: File[]): File[] {
    return files.filter((f) => f.type.startsWith('image/') || f.type.startsWith('audio/'))
  }

  /** 一批媒体文件入暂存区：逐张上传，单张失败不整批失败（uploadError 提示，
   *  已成功的保留）——Pwa.vue onFilesPicked 原实现平移，加非图片守卫；
   *  白名单外类型由后端逐项拒绝（错误文案区分图片/音频，spec §2.3）。 */
  async function addFiles(files: File[]): Promise<void> {
    if (!files.length) return
    const room = MAX_ATTACHMENTS - staged.value.length
    if (room <= 0) {
      uploadError.value = `一次最多 ${MAX_ATTACHMENTS} 个文件`
      return
    }
    if (files.length > room) uploadError.value = `一次最多 ${MAX_ATTACHMENTS} 个，已选取前 ${room} 个`
    uploading.value = true
    try {
      for (const f of files.slice(0, room)) {
        const fd = new FormData()
        fd.append('files', f, f.name)
        const data = await api<{ ok: boolean; items: Array<{ id?: string; url?: string; kind?: string; error?: string }> }>(
          '/api/web/upload',
          { method: 'POST', body: fd },
        )
        const item = data.items?.[0]
        if (item?.id) {
          // kind 以上传响应为准（后端魔数/白名单判定），响应缺省按 file.type 兜底
          const kind: StagedKind = item.kind === 'audio' ? 'audio' : item.kind === 'image' ? 'image' : f.type.startsWith('audio/') ? 'audio' : 'image'
          staged.value.push({ id: item.id, url: item.url || `/api/media/${item.id}`, name: f.name, kind })
        } else {
          uploadError.value = `文件上传失败：${item?.error || '未知错误'}`
        }
      }
    } catch (err) {
      uploadError.value = `文件上传失败：${err instanceof Error ? err.message : String(err)}`
    } finally {
      uploading.value = false
    }
  }

  /** 暂存区移除一张 */
  function removeStaged(id: string): void {
    staged.value = staged.value.filter((s) => s.id !== id)
  }

  /** 清除上传错误提示（提示条点击口径） */
  function clearError(): void {
    uploadError.value = ''
  }

  return { staged, uploadError, uploading, addFiles, removeStaged, clearError, mediaFilesOf }
}
