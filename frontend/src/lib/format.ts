/* ============================================================
   会话页展示口径 —— 全部照抄旧 UI / 后端源码（逐函数对照）：
   - STATUS_LABEL      旧 ui/app/00-core.js L478
   - fmtTime/fmtClock  旧 ui/app/00-core.js L400-411
   - fmtTokens         旧 ui/app/01-boot.js L73-76
   - formatChatTitle   旧 ui/app/06-settings-render.js L731-739
   - TOOL_META         旧 ui/app/00-core.js L306-327
   - surface 路由表    src/surfaces/registry.js L19-21（PREFIX_ROUTES /
                       DEFAULT_SURFACE，chatKey 前缀路由规则 D18）
   - 深度思考前缀      src/orchestrator.js:1226（原 plugins/detailed-thinking/index.js PREFIX 常量，Q15 收编核心）
   ============================================================ */
import type { ChatMeta, ToolCallItem } from './types'

/** 【深度思考】气泡前缀（src/orchestrator.js:1226 注入面原样；原 plugins/detailed-thinking/index.js PREFIX，Q15 收编核心） */
export const THINK_PREFIX = '【深度思考】'

export const STATUS_LABEL: Record<string, string> = {
  waiting: '等待中',
  done: '已发言',
  noreply: '未回复',
  running: '运行中',
  error: '出错',
  aborted: '中止',
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] || status
}

export function fmtTime(ts?: number | null): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fmtClock(ts?: number | null): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function fmtTokens(n?: number | null): string {
  const v = Number(n) || 0
  return v >= 10000 ? `${(v / 1000).toFixed(1)}k tok` : `${v} tok`
}

/* ============================================================
   M3 用量页展示口径（照抄旧 UI ui/app/00-core.js L280/L287-293）：
   - fmtTok   = 千分位整数（旧用量页 token/次数列口径，与 fmtTokens 不同）
   - fmtYuan  = 成本金额：0 → ¥0；<1 → 四位小数；否则两位
   ============================================================ */

export function fmtTok(n?: number | null): string {
  return (Number(n) || 0).toLocaleString('zh-CN')
}

export function fmtYuan(n?: number | null): string {
  const v = Number(n) || 0
  if (v === 0) return '¥0'
  if (Math.abs(v) < 1) return `¥${v.toFixed(4)}`
  return `¥${v.toFixed(2)}`
}

/** 身体路由表（src/surfaces/registry.js L19-21 原样）：改路由=后端改一行，前端照抄 */
const PREFIX_ROUTES: Readonly<Record<string, string>> = {
  'pet:': 'pet',
  'diary:': 'diary',
}
const DEFAULT_SURFACE = 'web'

/**
 * 会话归属的身体 surface：优先用载荷里真实的 surface 字段
 * （详情接口有，src/sessions.js L272），缺失时按 registry.route 同一套
 * 前缀规则从 chatKey 推导（无前缀含历史 group:/private:/web: → 默认 web，
 * 与后端 registry.js DEFAULT_SURFACE 同向——Q11 起 web 是唯一在册身体）。
 */
export function surfaceOf(chatKey: string, explicit?: string): string {
  const e = String(explicit ?? '').trim()
  if (e) return e
  const key = String(chatKey || '')
  for (const [prefix, surface] of Object.entries(PREFIX_ROUTES)) {
    if (key.startsWith(prefix)) return surface
  }
  return DEFAULT_SURFACE
}

/**
 * 会话显示名（名字来自 /api/chats 的 chatName；现网该字段恒空串——routes.js
 * 群名片概念随群聊摘除，显示退回 chatKey）。
 * group:/private: 分支是 QQ 时代历史留档键的兼容展示（只是把键美化，不新造 QQ 语义）；
 * 缺省分支只回原始 chatKey，身体中立——现网 'main' 即显示 'main'。
 */
export function formatChatTitle(chatKey: string, name = ''): string {
  const n = String(name || '').trim()
  if (n) return n
  const m = /^group:(\d+)$/.exec(String(chatKey || '')) // 历史数据兼容（QQ 群键）
  if (m) return `群 ${m[1]}`
  const p = /^private:(\d+)$/.exec(String(chatKey || '')) // 历史数据兼容（QQ 私聊键）
  if (p) return `私聊 ${p[1]}`
  return String(chatKey || '')
}

/** chatKey → 显示名（从 /api/chats 列表里找 chatName，拿不到退回兜底） */
export function chatNameOf(chatKey: string, chats: ChatMeta[]): string {
  const c = chats.find((x) => x.key === chatKey)
  return String(c?.chatName || '').trim()
}

/** 工具中文名与图标（旧 00-core.js TOOL_META 原样照抄） */
export const TOOL_META: Record<string, { name: string; cat: string; icon: string }> = {
  // 发言类
  send_message: { name: '发消息', cat: '发言', icon: '💬' },
  send_sticker: { name: '发表情包', cat: '发言', icon: '🎴' },
  send_poke: { name: '戳一戳', cat: '发言', icon: '👆' },
  // 查看类
  get_recent_messages: { name: '翻聊天记录', cat: '查看', icon: '📜' },
  get_message_detail: { name: '看消息详情', cat: '查看', icon: '🔍' },
  get_message_images: { name: '看图片', cat: '查看', icon: '🖼️' },
  get_active_members: { name: '看活跃群友', cat: '查看', icon: '👥' },
  // 表情包
  list_stickers: { name: '列表情库', cat: '表情', icon: '📚' },
  get_sticker_image: { name: '看表情图', cat: '表情', icon: '🖼️' },
  collect_sticker: { name: '收藏表情', cat: '表情', icon: '⭐' },
  sticker_note: { name: '备注表情', cat: '表情', icon: '📝' },
  // 联网
  web_search: { name: '联网搜索', cat: '联网', icon: '🌐' },
  web_fetch: { name: '抓网页', cat: '联网', icon: '🔗' },
  // 其他
  report_feedback: { name: '汇报反馈', cat: '其他', icon: '📣' },
  finish: { name: '结束本次', cat: '其他', icon: '🏁' },
}

export function toolIcon(name: string): string {
  return TOOL_META[name]?.icon || '⚒'
}

export function toolLabel(name: string): string {
  return TOOL_META[name]?.name || name
}

/** 工具行紧凑摘要：挑最常见的参数键拼一行，超长截断（旧 UI 展开体才是全量） */
export function toolSummary(item: ToolCallItem): string {
  const args =
    item.args && typeof item.args === 'object' && !Array.isArray(item.args)
      ? (item.args as Record<string, unknown>)
      : {}
  const keys = Object.keys(args)
  if (!keys.length) return '无参数'
  const preferred = ['text', 'query', 'keyword', 'url', 'target', 'id', 'count', 'note', 'reason']
  const parts: string[] = []
  for (const k of keys) {
    if (!preferred.includes(k)) continue
    const v = String(args[k] ?? '').replace(/\s+/g, ' ').trim()
    if (!v) continue
    parts.push(`${k}=${v.length > 48 ? `${v.slice(0, 48)}…` : v}`)
    if (parts.length >= 2) break
  }
  if (!parts.length) return `${keys.slice(0, 3).join(' ')}${keys.length > 3 ? ' …' : ''}`
  return parts.join(' · ')
}

/** 展开体里的参数 JSON（旧 UI 同口径：JSON.stringify(args, null, 1)） */
export function argsText(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}, null, 1)
  } catch {
    return String(args)
  }
}

/** assistant 气泡分类：深度思考（Q16 默认折叠）/ 正文草稿 */
export function isDeepThink(content: string): boolean {
  return String(content || '').startsWith(THINK_PREFIX)
}
