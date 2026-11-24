<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import AppLayout from './layouts/AppLayout.vue'
// E6（R2）：App 级登录浮层——api() 收 401 时弹出（authGate.visible），
// 挂在 RouterView 之外，/chat、/pwa 等全部页面自动继承。
import AuthOverlay from './components/AuthOverlay.vue'

// P1（night-plan-pwa §P1/§1 产品形态定稿）：/pwa = chat-only 独立壳——
// 无 SideNav/顶栏/StatusRail，按路由名直接渲染视图本体；其余路由照旧走
// AppLayout 三栏（桌面控制台零变化）。AuthOverlay 保持平级（App 级），
// /pwa 自动继承登录浮层（handoff §29-3 前提）。
const route = useRoute()
const bare = computed(() => route.name === 'pwa')

// 浏览器标签页跟随她的名字（2026-11-21 所有者：Xunxi · 汐；botName 缺省汐）
onMounted(async () => {
  try {
    const res = await fetch('/api/person/state', { headers: { Accept: 'application/json' } })
    if (!res.ok) return
    const s = await res.json() as { botName?: string }
    document.title = `Xunxi · ${s.botName?.trim() || '汐'}`
  } catch { /* 静默：标签页保持静态 Xunxi */ }
})
</script>

<template>
  <AppLayout v-if="!bare" />
  <RouterView v-else />
  <AuthOverlay />
</template>
