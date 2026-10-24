// 防止控制台窗口在 Windows release 下弹出
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 启动环境加固：**只保留 --no-first-run**。
///
/// ⚠️ 这里曾经把 `WEBVIEW2_USER_DATA_FOLDER` 强指到 `%LOCALAPPDATA%\EBWebView`，想修
/// 商店认证 10.1.2.10「启动即崩溃」——那是**已证伪的错误结论**（AGENT.md 踩坑 #16）：
/// Tauri 2 在 Windows 上已经把 WebView2 数据目录显式设为 `app_local_data_dir()/EBWebView`，
/// MSIX runFullTrust 下会被重定向到包自己的可写 LocalCache，本来就是可写的；强指固定目录
/// 反而让同机所有产品共用一个 UDF / 浏览器进程（选项不一致时 WebView2 以
/// ERROR_INVALID_STATE 创建失败），缓存与 cookie 互相串。改它 + 版本号重传后，第二轮
/// 以同一 code 被退回，白花一个认证周期。
///
/// 认证「启动即崩溃」的首要根因是 MSIX 清单 `Application@EntryPoint` 必须是
/// `Windows.FullTrustApplication`（踩坑 #17）。**禁止重新引入 UDF 覆盖**，
/// scripts/verify-msix.ps1（闸门 G1）会直接拦截。
fn init_webview_environment() {
    #[cfg(windows)]
    {
        // 无人值守（认证）环境：关闭首次运行欢迎页；追加而非覆盖已有值
        let existing =
            std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !existing.contains("--no-first-run") {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                if existing.trim().is_empty() {
                    "--no-first-run".into()
                } else {
                    format!("{existing} --no-first-run")
                },
            );
        }
    }
}

fn main() {
    init_webview_environment(); // 必须是第一行逻辑：先于任何 WebView2 初始化
    base_window_lib::run()
}
