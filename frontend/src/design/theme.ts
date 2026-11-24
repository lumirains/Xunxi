// ============================================================
// 亮暗双主题状态（D49/D50，阶段 S-1）：
//   · 持久化：localStorage['xunxi-theme'] = 'light' | 'dark'
//   · 生效：根元素 <html> 挂 data-theme='dark' 属性 → tokens.css 的
//     :root[data-theme='dark'] 变量组整组替换（换肤协议 D50：只切属性，
//     本模块不碰任何变量值）
//   · theme 是模块级共享 ref：顶栏按钮（AppLayout）与设置页「主题」项
//     （Settings）绑定同一份状态，两处切换互相同步
//   · localStorage 不可用（隐私模式等）时降级为仅本次会话生效，不抛错
// ============================================================
import { ref } from 'vue'

export type ThemeName = 'light' | 'dark'

const STORAGE_KEY = 'xunxi-theme'

function readStored(): ThemeName {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** 当前主题（模块级共享：顶栏与设置页两处开关同源） */
export const theme = ref<ThemeName>(readStored())

/** 把主题应用到根元素属性（不改 localStorage，供启动时静默恢复用） */
export function applyTheme(t: ThemeName): void {
  const root = document.documentElement
  if (t === 'dark') root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')
}

/** 切换并持久化主题（顶栏 / 设置页两处开关共用的唯一写入口） */
export function setTheme(t: ThemeName): void {
  try {
    localStorage.setItem(STORAGE_KEY, t)
  } catch {
    // 存不了就只对本次会话生效，不打断交互
  }
  theme.value = t
  applyTheme(t)
}

/** 亮暗互切（顶栏按钮用），返回切换后的主题 */
export function toggleTheme(): ThemeName {
  setTheme(theme.value === 'dark' ? 'light' : 'dark')
  return theme.value
}

/** 应用启动时恢复上次选择（main.ts 在 mount 前调用） */
export function initTheme(): void {
  applyTheme(theme.value)
}
