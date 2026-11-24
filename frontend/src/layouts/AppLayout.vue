<script setup lang="ts">
// 三栏布局骨架（phase9-plan §2 布局图逐块落实）：
// 侧栏分组导航 │ 顶栏（当前区标题 + 面包屑）+ 主区 │ 右侧常驻状态栏
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import SideNav from './SideNav.vue'
import StatusRail from '../components/StatusRail.vue'
import { theme, toggleTheme } from '../design/theme'

const route = useRoute()
const group = computed(() => route.meta.group)
const title = computed(() => route.meta.title)
</script>

<template>
  <div class="shell">
    <SideNav />
    <div class="main-col">
      <header class="topbar">
        <!-- 品牌位：项目名 Xunxi（罗马字；中文名不出现在产品面——2026-11-21 所有者定） -->
        <div class="brand">
          <b>Xunxi</b>
          <small>XUNXI</small>
        </div>
        <nav class="crumb" aria-label="当前区">
          <span class="crumb-group">{{ group }}</span>
          <span class="crumb-sep" aria-hidden="true">/</span>
          <h1 class="crumb-title">{{ title }}</h1>
        </nav>
        <!-- 主题切换（与设置页「主题」项共用同一 theme 状态）：
             亮色版叫「潮涨」（亚麻纸底），暗色版叫「潮落」（冷底暖点）——2026-11-21 所有者定名。
             S2 设计稿五：🌙/☀️ 图标 + 文字（图标=点击后将去往的主题）+ 150ms 主题过渡（tokens.css body） -->
        <button
          class="btn theme-toggle"
          type="button"
          :title="theme === 'dark' ? '切换为潮涨（亮）' : '切换为潮落（暗）'"
          @click="toggleTheme"
        >
          <span class="theme-ico" aria-hidden="true">{{ theme === 'dark' ? '🌊' : '🌙' }}</span>{{ theme === 'dark' ? '潮涨' : '潮落' }}
        </button>
      </header>
      <main class="page">
        <RouterView />
      </main>
    </div>
    <StatusRail />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr) 340px;
  height: 100vh;
}

.main-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.topbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 58px;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--line);
  background: var(--paper);
}

/* 品牌位：Xunxi · XUNXI */
.brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: none;
  padding-right: var(--space-2);
  border-right: 1px solid var(--line);
}

.brand b {
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 17px;
  letter-spacing: 0.2em;
  color: var(--ink-strong);
}

.brand small {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.24em;
  color: var(--mist-3);
}

.crumb {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.crumb-group {
  color: var(--mist-3);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  white-space: nowrap;
}

.crumb-sep {
  color: var(--line-strong);
}

.crumb-title {
  font-size: 20px; /* D48：标题 ≥20px（18px → 20px） */
  color: var(--ink);
  letter-spacing: 0.06em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* D49：顶栏右侧亮暗切换按钮（贴右，不挤面包屑）
   S2 设计稿五：🌙/☀️ 图标与文字同排（图标随目标主题互换） */
.theme-toggle {
  margin-left: auto;
  flex: none;
}

.theme-ico {
  font-size: 13px;
  line-height: 1;
}

.page {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-3);
}

/* ── 窄窗适配（2026-11-16「灯下」重做时补）：
   三栏在窄窗口会被挤成竖排单字，这里逐级收窄侧栏与状态栏，
   保证主列至少还有可读的行宽。 ───────────────────────────── */
@media (max-width: 1240px) {
  .shell {
    grid-template-columns: 182px minmax(0, 1fr) 280px;
  }
}

@media (max-width: 1000px) {
  /* 状态栏移到主列下方（不藏她，只是换个位置） */
  .shell {
    grid-template-columns: 170px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }

  .shell > .rail {
    grid-column: 2;
    grid-row: 2;
    border-left: none;
    border-top: 1px solid var(--line);
    max-height: 40vh;
  }
}

@media (max-width: 720px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
  }

  .shell > .sidenav {
    display: none;
  }

  .shell > .rail {
    grid-column: 1;
  }

  .page {
    padding: var(--space-2);
  }
}
</style>
