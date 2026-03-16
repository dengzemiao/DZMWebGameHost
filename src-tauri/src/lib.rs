mod database;
mod network;
mod server;
mod state;

use state::AppState;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::Manager;

#[tauri::command]
async fn start_server(
    app_state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let mut handle = app_state.server_handle.lock().await;
    if handle.is_some() {
        return Err("Server is already running".to_string());
    }

    let port = *app_state.port.lock().await;
    let game_pages_dir = app_state.game_pages_dir.to_string_lossy().to_string();
    let db_path = app_state.data_dir.join("game.db");
    let online_count = app_state.online_count.clone();

    let instance = server::start(port, game_pages_dir, db_path, online_count).await?;

    app_state.running.store(true, Ordering::Relaxed);
    *handle = Some(state::ServerHandle {
        join_handle: instance.join_handle,
        shutdown_tx: instance.shutdown_tx,
        broadcast_tx: instance.broadcast_tx,
    });

    let ip = network::ip::get_local_ipv4();
    Ok(format!("http://{}:{}", ip, port))
}

#[tauri::command]
async fn stop_server(
    app_state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut handle = app_state.server_handle.lock().await;
    if let Some(server_handle) = handle.take() {
        // 先广播停止通知，让客户端第一时间感知
        let stop_msg = serde_json::json!({ "type": "server_stopping" }).to_string();
        let _ = server_handle.broadcast_tx.send(stop_msg);
        // 短暂等待客户端收到广播后再关闭
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        let _ = server_handle.shutdown_tx.send(());
        let _ = server_handle.join_handle.await;
        app_state.running.store(false, Ordering::Relaxed);
        app_state.online_count.store(0, Ordering::Relaxed);
        Ok(())
    } else {
        Err("Server is not running".to_string())
    }
}

#[derive(serde::Serialize)]
struct ServerStatus {
    running: bool,
    online_count: usize,
    address: String,
    port: u16,
    local_ip: String,
}

#[tauri::command]
async fn get_server_status(
    app_state: tauri::State<'_, Arc<AppState>>,
) -> Result<ServerStatus, String> {
    let running = app_state.running.load(Ordering::Relaxed);
    let online_count = app_state.online_count.load(Ordering::Relaxed);
    let port = *app_state.port.lock().await;
    let ip = network::ip::get_local_ipv4();

    Ok(ServerStatus {
        running,
        online_count,
        address: if running {
            format!("http://{}:{}", ip, port)
        } else {
            String::new()
        },
        port,
        local_ip: ip,
    })
}

#[tauri::command]
fn get_local_ip() -> String {
    network::ip::get_local_ipv4()
}

#[tauri::command]
async fn set_port(
    app_state: tauri::State<'_, Arc<AppState>>,
    port: u16,
) -> Result<(), String> {
    let running = app_state.running.load(Ordering::Relaxed);
    if running {
        return Err("Cannot change port while server is running".to_string());
    }
    *app_state.port.lock().await = port;
    Ok(())
}

#[tauri::command]
async fn open_data_dir(
    app_state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let data_dir = &app_state.data_dir;
    open::that(data_dir).map_err(|e| format!("Failed to open data dir: {}", e))
}

#[tauri::command]
async fn get_online_count(
    app_state: tauri::State<'_, Arc<AppState>>,
) -> Result<usize, String> {
    Ok(app_state.online_count.load(Ordering::Relaxed))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");

            let game_pages_dir = if cfg!(debug_assertions) {
                // 开发模式：game-pages 在项目根目录（src-tauri 的上级目录）
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .expect("Failed to get project root")
                    .join("game-pages")
            } else {
                // 生产模式：game-pages 被打包到 resource 目录中
                app.path()
                    .resource_dir()
                    .expect("Failed to get resource dir")
                    .join("game-pages")
            };

            println!("[DZMWebGameHost] game_pages_dir: {:?}", game_pages_dir);

            database::init(&data_dir).expect("Failed to init database");

            let app_state = Arc::new(AppState::new(data_dir, game_pages_dir));
            app.manage(app_state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_server,
            stop_server,
            get_server_status,
            get_local_ip,
            set_port,
            open_data_dir,
            get_online_count,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
