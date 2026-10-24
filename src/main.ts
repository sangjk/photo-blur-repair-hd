import { createApp } from 'vue'
import '@fortawesome/fontawesome-free/css/all.min.css'
import './style.css'
import App from './App.vue'
import { appReady } from './tauri'

const app = createApp(App)

// 全局错误兜底：未捕获的渲染/组件错误不再静默吞掉，避免「白屏却查不到原因」
app.config.errorHandler = (err, _instance, info) => {
  console.error('[App] 运行时错误:', info, err)
}

app.mount('#app')

// 启动白屏优化：窗口以 visible:false 启动，首帧渲染完成后通知 Rust 显示窗口。
// 双重 rAF 确保首帧已真正绘制再显示；浏览器/dev 环境下 appReady 静默返回 null。
// ⚠️ 本调用不得删除或提前——删了窗口会等 5 秒兜底才出现，提前了会重新出现白屏。
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    void appReady()
  })
})
