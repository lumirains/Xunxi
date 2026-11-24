import { createApp } from 'vue'
import './design/tokens.css'
import { initTheme } from './design/theme'
import App from './App.vue'
import { router } from './router'

// D49：挂载前恢复上次选的亮暗主题（localStorage → 根元素 data-theme）
initTheme()

createApp(App).use(router).mount('#app')
