/// 通用窗口外壳的 Rust 入口。
///
/// 本文件集中实现「会在本地落盘 / 接触密钥」的所有能力，前端只通过 invoke 拿到结果，
/// 永远看不到 V免签 appSecret，也不会直接写文件系统（避免把密钥/路径逻辑泄漏到 JS 层）。
///
/// 提供的指令（与 src/tauri.ts 一一对应）：
///   - vmq_public_config  对外公开配置（不含 appSecret）
///   - vmq_sign          用 appSecret 计算签名（密钥不离开 Rust）
///   - license_save/load/clear  授权凭证：绑定机器码、防篡改、重启不丢
///   - window_save/load_state    窗口位置/尺寸记忆
///   - settings_save/load        关闭行为（最小化到托盘 / 直接退出）+ 界面语言
///   - set_app_locale            前端切换语言 → 重建托盘菜单（托盘文案不硬编码）
///   - open_devtools     供 F12 / 右键菜单调用（release 下空操作）
///   - vmq_proxy         转发 V免签 API（Rust 侧 reqwest 发起，绕开 WebView/浏览器 CORS 限制）
///
/// 另外在 run() 内：启动时恢复窗口状态、建系统托盘、拦截关闭事件实现「最小化到托盘」。
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    Manager, WebviewWindow, WindowEvent,
};

// ── V免签 默认凭据（生产可通过环境变量 VMQ_APP_ID / VMQ_APP_SECRET / VMQ_API_HOST 注入）──
// 注意：TASK.md 第 3 项未更新（仍是模板示例值 app_aad7d7f284e6）时必须保留本默认值，不得替换——
// 示例值在 V免签服务端无效，替换成示例值会导致「创建订单失败」。
struct VmqConfig {
    api_host: String,
    app_id: String,
    app_secret: String,
}
fn vmq_config() -> VmqConfig {
    VmqConfig {
        api_host: std::env::var("VMQ_API_HOST").unwrap_or_else(|_| "https://laosanvmianqianzhuanyong1.ifama.top".into()),
        app_id: std::env::var("VMQ_APP_ID").unwrap_or_else(|_| "app_1a81bec92e7e".into()),
        app_secret: std::env::var("VMQ_APP_SECRET").unwrap_or_else(|_| "bb1e58459236f006f5f7e518dca91b06".into()),
    }
}

/// 授权签名盐值：用于把「订单号 + 机器码」绑成不可伪造的凭证（非加密，仅防小白篡改/拷贝）
const LICENSE_SALT: &str = "basewindow-license-salt";

// 关键：Tauri 对命令【返回值】不做字段名转换，serde 按字段原样输出 snake_case，
// 而前端 TS 全部按 camelCase 读取——错位会让前端拿到 undefined（如 cfg.appId），
// JSON.stringify 直接丢弃该字段 → V免签 返回「参数不完整（需要 appId, payId, type, sign）」。
// 所有返回给前端的结构体必须 rename_all = "camelCase"（新增命令同样遵守）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VmqPublicConfig {
    api_host: String,
    app_id: String,
}

// 标准 MD5（与前端 vmq.ts 的 md5 实现产出一致，V免签 服务端按此校验）
fn md5_hex(input: &str) -> String {
    let digest = md5::compute(input.as_bytes());
    digest.0.iter().map(|b| format!("{:02x}", b)).collect()
}

#[tauri::command]
fn open_devtools(window: WebviewWindow) {
    #[cfg(debug_assertions)]
    {
        window.open_devtools();
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = window;
    }
}

/// 前端首帧渲染完成 → 显示主窗口（配合 tauri.conf.json 的 visible:false，消除启动白屏）
#[tauri::command]
fn app_ready(window: WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// 对外公开配置：不返回 appSecret，前端拿不到密钥原文
#[tauri::command]
fn vmq_public_config() -> VmqPublicConfig {
    let cfg = vmq_config();
    VmqPublicConfig { api_host: cfg.api_host, app_id: cfg.app_id }
}

/// 用 appSecret 计算签名（密钥不离开 Rust）。
/// kind=create => params=[payId, param, type, amount]，拼接 payId+param+type+amount+secret
/// kind=check|close => params=[orderId]，拼接 orderId+secret
#[tauri::command]
fn vmq_sign(kind: String, params: Vec<String>) -> String {
    let cfg = vmq_config();
    let joined = match kind.as_str() {
        "create" => {
            let pay_id = params.get(0).cloned().unwrap_or_default();
            let param = params.get(1).cloned().unwrap_or_default();
            let typ = params.get(2).cloned().unwrap_or_default();
            let amount = params.get(3).cloned().unwrap_or_default();
            format!("{pay_id}{param}{typ}{amount}{}", cfg.app_secret)
        }
        "check" | "close" => {
            let order = params.get(0).cloned().unwrap_or_default();
            format!("{order}{}", cfg.app_secret)
        }
        _ => String::new(),
    };
    md5_hex(&joined)
}

/// V免签 API 转发：由 Rust 侧用 reqwest 发出，彻底绕开 WebView/浏览器对跨域（CORS）的限制。
/// 前端只拿回原始 HTTP status + body；仅转发到 vmq_config() 配置的 api_host，不接受任意外部地址（防 SSRF）。
#[derive(Serialize)]
struct VmqProxyResp {
    status: u16,
    body: String,
}

#[tauri::command]
async fn vmq_proxy(
    path: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<VmqProxyResp, String> {
    let cfg = vmq_config();
    let base = if cfg.api_host.starts_with("http://") || cfg.api_host.starts_with("https://") {
        cfg.api_host.clone()
    } else {
        format!("https://{}", cfg.api_host)
    };
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    // 15s 超时：与前端浏览器分支一致，避免 V免签 服务挂起时下单/查询一直卡死
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("V免签客户端初始化失败: {e}"))?;
    let m = method.unwrap_or_else(|| "GET".into()).to_uppercase();
    let mut req = match m.as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };
    if let Some(h) = headers {
        for (k, v) in h {
            req = req.header(&k, &v);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let resp = req.send().await.map_err(|e| format!("V免签转发请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let body_text = resp.text().await.map_err(|e| format!("V免签响应读取失败: {e}"))?;
    Ok(VmqProxyResp { status, body: body_text })
}

// ── 导出落盘：把前端生成的内容写到用户「下载」目录 ────────────────────────
// 为什么放在 Rust：WebView2 下 <a download> 的下载行为不受应用控制，
// 由 Rust 直接落盘可以确定性地拿到保存路径并回显给用户。
// 注意：这里不使用 base64 第三方 crate（避免动 Cargo.lock），自带极简解码器。

/// 极简标准 base64 解码（忽略空白与 '=' 填充）
fn b64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lut = [255u8; 256];
    for (i, c) in TABLE.iter().enumerate() {
        lut[*c as usize] = i as u8;
    }
    let mut out: Vec<u8> = Vec::with_capacity(input.len() * 3 / 4 + 3);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for b in input.bytes() {
        if b == b'=' || b.is_ascii_whitespace() {
            continue;
        }
        let v = lut[b as usize];
        if v == 255 {
            return Err(format!("base64 含非法字符: {}", b as char));
        }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Ok(out)
}

/// 导出目录：优先「下载」，其次应用数据目录，最后系统临时目录
fn export_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().download_dir() {
        return dir;
    }
    if let Ok(dir) = app.path().app_data_dir() {
        return dir;
    }
    std::env::temp_dir()
}

/// 清理文件名：去掉路径分隔符与非法字符，空则回退 export
fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().to_string();
    if trimmed.is_empty() {
        "export".to_string()
    } else {
        trimmed
    }
}

#[tauri::command]
fn save_text_file(file_name: String, content: String, app: tauri::AppHandle) -> Result<String, String> {
    let path = export_dir(&app).join(sanitize_file_name(&file_name));
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, content.as_bytes()).map_err(|e| format!("保存失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn save_binary_file(file_name: String, base64: String, app: tauri::AppHandle) -> Result<String, String> {
    let bytes = b64_decode(&base64)?;
    let path = export_dir(&app).join(sanitize_file_name(&file_name));
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, &bytes).map_err(|e| format!("保存失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 导出到用户通过保存对话框选择的完整路径（含文件名）。
/// 与 save_binary_file 的区别：路径由前端经 dialog 插件取得，不再写死「下载」目录。
#[tauri::command]
fn save_binary_file_to(file_path: String, base64: String) -> Result<String, String> {
    let bytes = b64_decode(&base64)?;
    let path = PathBuf::from(&file_path);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, &bytes).map_err(|e| format!("保存失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

// ── 授权凭证 ─────────────────────────────────────────────────────────────
// camelCase 输出（orderId/createdAt），alias 兼容旧 snake_case 落盘文件
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LicenseRecord {
    #[serde(alias = "order_id")]
    order_id: String,
    machine: String,
    signature: String,
    #[serde(alias = "created_at")]
    created_at: i64,
}

#[tauri::command]
fn license_save(order_id: String, app: tauri::AppHandle) -> Result<(), String> {
    let machine = machine_id(&app);
    let signature = md5_hex(&format!("{}{}{}", order_id, machine, LICENSE_SALT));
    let record = LicenseRecord {
        order_id,
        machine,
        signature,
        created_at: now_secs(),
    };
    write_json(&data_file(&app, "license.json"), &record)
}

#[tauri::command]
fn license_load(app: tauri::AppHandle) -> Option<LicenseRecord> {
    let record: LicenseRecord = read_json(data_file(&app, "license.json"))?;
    // 校验机器绑定 + 签名：拷贝到其他机器或手工改文件都会失效
    let machine = machine_id(&app);
    if record.machine != machine {
        return None;
    }
    let expected = md5_hex(&format!("{}{}{}", record.order_id, record.machine, LICENSE_SALT));
    if record.signature != expected {
        return None;
    }
    Some(record)
}

#[tauri::command]
fn license_clear(app: tauri::AppHandle) -> Result<(), String> {
    let path = data_file(&app, "license.json");
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── 窗口状态记忆 ─────────────────────────────────────────────────────────
#[derive(Serialize, Deserialize)]
struct WindowState {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    maximized: bool,
}

#[tauri::command]
fn window_save_state(x: i32, y: i32, w: i32, h: i32, maximized: bool, app: tauri::AppHandle) -> Result<(), String> {
    write_json(
        &data_file(&app, "window.json"),
        &WindowState { x, y, w, h, maximized },
    )
}

#[tauri::command]
fn window_load_state(app: tauri::AppHandle) -> Option<WindowState> {
    read_json(data_file(&app, "window.json"))
}

// ── 应用设置（关闭行为 + 界面语言，后者供托盘菜单使用）──────────────────
#[derive(Serialize, Deserialize, Clone)]
struct AppSettings {
    // 输出 closeBehavior 供前端 TS 读取；alias 兼容旧 settings.json 的 close_behavior
    #[serde(default, rename = "closeBehavior", alias = "close_behavior")]
    close_behavior: String, // "tray" | "quit"
    #[serde(default = "default_locale")]
    locale: String, // "zh-CN" | "en-US"，由前端 set_app_locale 同步
}
impl Default for AppSettings {
    fn default() -> Self {
        Self { close_behavior: String::new(), locale: default_locale() }
    }
}
fn default_locale() -> String {
    "zh-CN".into()
}

#[tauri::command]
fn settings_save(close_behavior: String, app: tauri::AppHandle) -> Result<(), String> {
    // 只更新 close_behavior，保留 locale（旧设置文件向后兼容）
    let mut s: AppSettings = read_json(data_file(&app, "settings.json")).unwrap_or_default();
    s.close_behavior = close_behavior;
    write_json(&data_file(&app, "settings.json"), &s)
}

#[tauri::command]
fn settings_load(app: tauri::AppHandle) -> AppSettings {
    read_json(data_file(&app, "settings.json")).unwrap_or_default()
}

/// 前端切换界面语言时调用：写入设置并即时重建托盘菜单（托盘文案不硬编码，跟随 locale）
#[tauri::command]
fn set_app_locale(locale: String, app: tauri::AppHandle) -> Result<(), String> {
    if locale != "zh-CN" && locale != "en-US" {
        return Err(format!("unsupported locale: {locale}"));
    }
    let mut s: AppSettings = read_json(data_file(&app, "settings.json")).unwrap_or_default();
    s.locale = locale;
    write_json(&data_file(&app, "settings.json"), &s)?;
    let state = app.state::<AppState>();
    if let Some(tray) = &state.tray {
        let menu = tray_menu_for(&app, &s.locale).map_err(|e| e.to_string())?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── 工具函数 ─────────────────────────────────────────────────────────────
fn data_file(app: &tauri::AppHandle, name: &str) -> PathBuf {
    match app.path().app_data_dir() {
        Ok(dir) => dir.join(name),
        Err(_) => PathBuf::from(name),
    }
}

fn write_json<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let s = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, s).map_err(|e| e.to_string())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: PathBuf) -> Option<T> {
    let s = fs::read_to_string(path).ok()?;
    serde_json::from_str(&s).ok()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 稳定的「机器码」：首次运行随机生成并落盘，之后读缓存；用于把授权绑到本机
fn machine_id(app: &tauri::AppHandle) -> String {
    let path = data_file(app, "machine.json");
    if let Some(id) = read_json::<String>(path.clone()) {
        return id;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = write_json(&path, &id);
    id
}

fn save_window_state(window: &tauri::Window) {
    let app = window.app_handle();
    let pos = window.outer_position().unwrap_or_default();
    let size = window.outer_size().unwrap_or_default();
    let state = WindowState {
        x: pos.x,
        y: pos.y,
        w: size.width as i32,
        h: size.height as i32,
        maximized: window.is_maximized().unwrap_or(false),
    };
    let _ = write_json(&data_file(&app, "window.json"), &state);
}

// ── 托盘 ─────────────────────────────────────────────────────────────────
// 托盘菜单文案跟随 locale（settings.json，由前端 set_app_locale 同步），
// 切换语言即时重建菜单；新增 Rust 侧 UI 文案必须同样 locale 化，禁止硬编码。

/// 托盘句柄托管：语言切换时重建托盘菜单用
struct AppState {
    tray: Option<TrayIcon>,
}

fn tray_menu_for(app: &tauri::AppHandle, locale: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let zh = locale != "en-US";
    let (show_text, quit_text) = if zh { ("显示主窗口", "退出") } else { ("Show Main Window", "Exit") };
    let show = MenuItem::with_id(app, "show", show_text, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit_text, true, None::<&str>)?;
    Menu::with_items(app, &[&show, &quit])
}

fn current_locale(app: &tauri::AppHandle) -> String {
    read_json::<AppSettings>(data_file(app, "settings.json"))
        .map(|s| s.locale)
        .unwrap_or_else(default_locale)
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<TrayIcon> {
    let menu = tray_menu_for(app, &current_locale(app))?;
    let icon = app
        .default_window_icon()
        .cloned()
        .expect("缺少默认窗口图标（请在 tauri.conf.json 的 bundle.icon 配置）");
    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(tray)
}

pub fn run() {
    tauri::Builder::default()
        // 单实例：二次启动不新开窗口，唤起已有主窗口（避免多开并发写坏状态文件）
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        // 系统保存对话框：导出时让用户选择保存位置（不写死下载目录）
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 1) 启动恢复窗口位置/尺寸（Tauri 2 用 maximize()/unmaximize()，无 set_maximized）
            if let Some(win) = app.get_webview_window("main") {
                if let Some(st) = read_json::<WindowState>(data_file(&app.app_handle(), "window.json")) {
                    if st.maximized {
                        let _ = win.maximize();
                    } else {
                        let _ = win.unmaximize();
                        let _ = win.set_position(tauri::LogicalPosition::new(st.x, st.y));
                        let _ = win.set_size(tauri::LogicalSize::new(st.w, st.h));
                    }
                }
            }
            // 2) 系统托盘（文案跟随 locale）+ 句柄托管供语言切换时重建菜单
            let tray = build_tray(app.handle())?;
            app.manage(AppState { tray: Some(tray) });
            // 3) 显示兜底：5 秒内未收到前端 app_ready 也强制显示窗口
            //    （防止前端异常时窗口永远隐藏；正常路径由前端首帧后立即显示）
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if let Some(w) = handle.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_devtools,
            app_ready,
            vmq_public_config,
            vmq_sign,
            vmq_proxy,
            save_text_file,
            save_binary_file,
            save_binary_file_to,
            license_save,
            license_load,
            license_clear,
            window_save_state,
            window_load_state,
            settings_save,
            settings_load,
            set_app_locale
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                // 移动 / 缩放：实时保存窗口状态（夹回屏幕内的逻辑交给恢复时处理）
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    save_window_state(window);
                }
                // 关闭：先保存最终位置，再按「关闭行为」决定退出还是最小化到托盘
                WindowEvent::CloseRequested { api, .. } => {
                    save_window_state(window);
                    let settings: AppSettings =
                        read_json(data_file(&window.app_handle(), "settings.json")).unwrap_or_default();
                    if settings.close_behavior == "tray" {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
