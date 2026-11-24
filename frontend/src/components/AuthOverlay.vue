<script setup lang="ts">
// E6（R2）App 级登录浮层：任何 api() 调用收 401 时弹出（authGate.visible）。
// 输入 server.token → POST /api/auth/login（后端免检端点，Set-Cookie HttpOnly）
// → 成功后 api.ts 重试原请求一次。挂在 App.vue（RouterView 之外），
// /chat、/pwa 等全部页面自动继承，各页不重复实现鉴权（night-plan-pwa §0-8）。
// 样式口径对齐 Settings.vue .field（标签 ink-2 12px / 输入 13px line-strong 描边
// / focus 走 --accent），按钮复用全局 .btn / .btn-accent（design/tokens.css）。
import { nextTick, ref, watch } from 'vue'
import { authGate, cancelLogin, submitLogin } from '../lib/consoleAuth'

const token = ref('')
const input = ref<HTMLInputElement | null>(null)

// 每次弹出清空上一次输入并聚焦（浮层是复用实例，v-if 重建亦可触发 focus）
watch(
  () => authGate.visible,
  (visible) => {
    if (visible) {
      token.value = ''
      authGate.error = ''
      void nextTick(() => input.value?.focus())
    }
  },
)

async function submit(): Promise<void> {
  if (!token.value || authGate.submitting) return
  // 成功 → consoleAuth 已放行等待者并关浮层；失败 → 错误留在 authGate.error
  await submitLogin(token.value)
}
</script>

<template>
  <div v-if="authGate.visible" class="auth-overlay" role="dialog" aria-modal="true" aria-label="控制台登录">
    <div class="auth-card">
      <h2 class="auth-title">需要配对令牌</h2>
      <p class="auth-note">
        本控制台开启了访问令牌（config.server.token）。输入一次即可，凭证存于
        HttpOnly Cookie，之后所有请求（含消息流）自动携带。
      </p>
      <form class="field" @submit.prevent="submit">
        <span>访问令牌</span>
        <input
          ref="input"
          v-model="token"
          type="password"
          autocomplete="current-password"
          :disabled="authGate.submitting"
          placeholder="server.token"
        />
        <p v-if="authGate.error" class="err">{{ authGate.error }}</p>
        <div class="auth-actions">
          <button type="button" class="btn" :disabled="authGate.submitting" @click="cancelLogin">取消</button>
          <button type="submit" class="btn btn-accent" :disabled="authGate.submitting || !token">登录</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.auth-overlay {
  position: fixed;
  inset: 0;
  z-index: 100; /* Usage.vue 的常驻层是 40，浮层必须盖过一切页面内容 */
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-2);
}

.auth-card {
  width: min(360px, 100%);
  background: var(--card);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-card);
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.auth-title {
  margin: 0;
  font-size: 15px;
  color: var(--ink);
}

.auth-note {
  margin: 0;
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1.6;
}

/* —— 对齐 Settings.vue .field 口径 —— */
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field > span {
  color: var(--ink-2);
  font-size: 12px;
}

.field input[type='password'] {
  font-family: var(--font-sans);
  font-size: 13px;
  padding: 5px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: var(--card);
  color: var(--ink);
}

.field input[type='password']:focus {
  outline: none;
  border-color: var(--accent);
}

/* 错误文案口径同 Settings.vue .head-note.err */
.err {
  margin: 0;
  color: var(--accent);
  font-size: 12px;
}

.auth-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
