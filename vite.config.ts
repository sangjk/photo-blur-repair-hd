import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Tauri 2 约定：dev 端口固定 1420，host 设为 false（Tauri 用固定端口拉起前端）
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
    // V免签 API 开发代理：浏览器 dev 模式下把 /vmq/* 同源转发到支付网关，绕开 CORS。
    // 生产 Tauri 环境下不走此代理，改由 Rust 侧 vmq_proxy（reqwest）发起，同样无 CORS。
    proxy: {
      '/vmq': {
        target: 'https://laosanvmianqianzhuanyong1.ifama.top',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/vmq/, ''),
      },
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // 关闭自动清空：某些环境下 emptyDir 走的「安全删除」代理会超时导致构建失败。
    // 需要干净产物时，手动把 dist 改名/删除后再构建即可。
    emptyOutDir: false,
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})
