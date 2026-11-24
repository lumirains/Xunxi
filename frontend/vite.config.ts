import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// 开发代理（phase9-plan §2）：/api → 本机后端 127.0.0.1:3210。
// SSE 不缓冲：http-proxy 默认即流式透传；这里对 event-stream 响应补
// no-cache / no-transform / x-accel-buffering=no，防任何中间层聚合分片。
// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3210',
        changeOrigin: true,
        ws: true, // T3 通话 WS /api/voice 升级转发（生产同源直连不经代理，此行只服务 dev）
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            const contentType = String(proxyRes.headers['content-type'] ?? '')
            if (contentType.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform'
              proxyRes.headers['x-accel-buffering'] = 'no'
            }
          })
        },
      },
    },
  },
})
