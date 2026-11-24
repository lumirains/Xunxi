import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
// 清债夜1（评审 P2-8）：全部路由视图改懒加载（() => import）——首包只含
// router 壳 + 布局，各页成独立 chunk（/pwa 先例照抄，dist 可 grep 实证）。
// PlaceholderPage 组件保留在 components/ 备查；D44 落位后路由表已无占位路由

declare module 'vue-router' {
  interface RouteMeta {
    /** 顶栏标题（当前区标题） */
    title: string
    /** 所属分组：大脑 / 身体 / 系统 */
    group: string
    /** 占位页提示 */
    hint: string
  }
}

// M1 会话页落位（phase9-plan §3）：/ 由占位页换成 Sessions.vue；
// 其余 M2/M3 页面仍为占位路由。
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'session',
    component: () => import('./views/Sessions.vue'),
    meta: {
      group: '表达感情的心',
      title: '会话',
      hint: '',
    },
  },
  // W6（night-plan §4 W6 / plan Step 6 + D4）：web 身体对话页。
  // 数据源 GET /api/web/messages + POST /api/web/send + SSE chat-message/chat-typing。
  {
    path: '/chat',
    name: 'chat',
    component: () => import('./views/Chat.vue'),
    meta: {
      group: '表达感情的心',
      title: '对话',
      hint: '',
    },
  },
  // P1（night-plan-pwa §P1）：PWA 移动聊天壳（chat-only 独立入口）。
  // meta 同 RouteMeta 现有格式（title/group/hint）；**不进 SideNav**——
  // SideNav groups 硬编码不含 /pwa（handoff §29-3 实锚），App.vue 按路由名
  // 豁免 AppLayout（无侧栏/顶栏/状态栏的独立壳，AuthOverlay 仍自动继承）。
  // 懒加载：手机首屏只拉主包，Pwa 代码成独立 chunk（dist 可 grep 实证）。
  {
    path: '/pwa',
    name: 'pwa',
    component: () => import('./views/Pwa.vue'),
    meta: {
      group: '表达感情的心',
      title: '对话',
      hint: '',
    },
  },
  // （M2 15a 她的自我路由已随 2026-11-21 self 面丢弃移除——旧 /self、/mind 占位重定向均改指 /mood。）
  {
    path: '/self',
    redirect: '/mood',
  },
  {
    path: '/mind',
    redirect: '/mood',
  },
  // M2 15b（D43）：心绪时间线。
  {
    path: '/mood',
    name: 'mood',
    component: () => import('./views/Mood.vue'),
    meta: {
      group: '表达感情的心',
      title: '心绪时间线',
      hint: '',
    },
  },
  // （M2 15c 关系仪表路由已随 2026-11-21 relationship 数值丢弃移除）
  // M2 15d+15e（D43）：记忆卡片库（巩固历史并入本页）。
  {
    path: '/cards',
    name: 'cards',
    component: () => import('./views/Cards.vue'),
    meta: {
      group: '表达感情的心',
      title: '记忆卡片库',
      hint: '',
    },
  },
  {
    path: '/memory',
    redirect: '/cards',
  },
  {
    path: '/consolidation',
    redirect: '/cards',
  },
  // M2 15f（D43）：事件流直播。
  {
    path: '/events',
    name: 'events',
    component: () => import('./views/Events.vue'),
    meta: {
      group: '表达感情的心',
      title: '事件流',
      hint: '',
    },
  },
  // M3（D44）：用量。Q17 按动作分类保守降级——现有维度 + 页内注记（见 Usage.vue 头注）。
  {
    path: '/usage',
    name: 'usage',
    component: () => import('./views/Usage.vue'),
    meta: {
      group: '表达感情的心',
      title: '用量',
      hint: '',
    },
  },
  // Q2（qq-exit Step 1）：/qq 与进程管理页两页随 QQ 载体摘除（视图原件移
  // legacy/frontend-views/ 留对照）。
  // M3（D44）：设置（核心项读写；保存=POST /api/config 深合并 patch，旧 UI 同语义）。
  {
    path: '/settings',
    name: 'settings',
    component: () => import('./views/Settings.vue'),
    meta: {
      group: '系统',
      title: '设置',
      hint: '',
    },
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
