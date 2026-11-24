<script setup lang="ts">
// 占位页：本阶段只落布局骨架；各页正文按里程碑落位（M1 会话 / M2 前额叶 / M3 其余）。
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const group = computed(() => route.meta.group)
const title = computed(() => route.meta.title)
const hint = computed(() => route.meta.hint)
</script>

<template>
  <section class="card placeholder">
    <p class="group">{{ group }}</p>
    <h2 class="title">{{ title }}</h2>
    <p class="hint">{{ hint }}</p>
    <p class="note">占位页 · 本阶段只落布局骨架</p>
  </section>
</template>

<style scoped>
.placeholder {
  max-width: 560px;
  padding: var(--space-3);
}

.group {
  margin: 0;
  color: var(--ink-2);
  font-size: 11px;
  letter-spacing: 0.35em;
}

.title {
  margin: var(--space-1) 0 0;
  font-size: 20px;
}

.hint {
  margin: var(--space-2) 0 0;
  color: var(--ink-2);
  font-size: 13px;
}

.note {
  margin: var(--space-3) 0 0;
  color: var(--accent);
  font-size: 12px;
}
</style>
