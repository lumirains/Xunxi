<script setup lang="ts">
// 侧栏分组导航 = 架构分层可视化（phase9-plan §2）：大脑 / 身体 / 系统。
// M2 起大脑组为前额叶页群（D43）→ 2026-11-21 所有者更名「她」：心绪/记忆（卡片库，含巩固历史）/事件流；
// 旧 /mind /memory /consolidation 占位路径经 router 重定向兜底。
// M3（D44）落位：用量/设置两页为真视图；Q2（qq-exit Step 1）QQ 空间页与
// 进程管理页两页随 QQ 载体摘除（页名清单见 handoff §4 Q2），「身体」分组清空撤除。
// W6（night-plan-web-body D4）：大脑组加「对话」（/chat，web 身体聊天页）。
// 当前项样式 = D41：墨黑底 + 橙色左线。
interface NavItem {
  title: string
  to: string
}
interface NavGroup {
  name: string
  items: NavItem[]
}

const groups: NavGroup[] = [
  {
    name: '表达感情的心',
    items: [
      { title: '会话', to: '/' },
      { title: '对话', to: '/chat' },
      { title: '心绪', to: '/mood' },
      { title: '记忆', to: '/cards' },
      { title: '事件流', to: '/events' },
      { title: '用量', to: '/usage' },
    ],
  },
  {
    name: '系统',
    items: [
      { title: '设置', to: '/settings' },
    ],
  },
]
</script>

<template>
  <aside class="sidenav">
    <section v-for="g in groups" :key="g.name" class="nav-group">
      <p class="group-label">{{ g.name }}</p>
      <RouterLink
        v-for="item in g.items"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        exact-active-class="is-current"
      >
        {{ item.title }}
      </RouterLink>
    </section>
  </aside>
</template>

<style scoped>
.sidenav {
  padding: var(--space-3) 0;
  border-right: 1px solid var(--line);
  background: var(--paper);
  overflow: auto;
}

.nav-group + .nav-group {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--line);
}

.group-label {
  margin: 0 0 var(--space-1);
  padding: 0 var(--space-3);
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.22em;
}

.nav-item {
  display: block;
  padding: 6px var(--space-3);
  border-left: 2px solid transparent;
  color: var(--ink-2);
  font-size: 13.5px;
  line-height: 1.6;
  transition: color 0.15s ease;
}

.nav-item:hover {
  color: var(--ink);
}

/* 当前项（2026-11-16 重做）：一条琥珀的线 + 极淡的暖底 + 亮字。
   旧版是「墨黑底色块」——在暗色主题下会变成一块刺眼白板。 */
.nav-item.is-current {
  color: var(--ink);
  border-left-color: var(--accent);
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 14%, transparent), transparent 74%);
}
</style>
