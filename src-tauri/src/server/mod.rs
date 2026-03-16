pub mod http;
pub mod lobby;
pub mod websocket;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

use lobby::Lobby;

pub struct ServerInstance {
    pub shutdown_tx: tokio::sync::oneshot::Sender<()>,
    pub join_handle: tokio::task::JoinHandle<()>,
    pub broadcast_tx: tokio::sync::broadcast::Sender<String>,
}

pub async fn start(
    port: u16,
    game_pages_dir: String,
    db_path: PathBuf,
    online_count: Arc<AtomicUsize>,
) -> Result<ServerInstance, String> {
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("[Server] Starting on {} with game_pages: {}", addr, game_pages_dir);

    let lobby = Lobby::new(online_count, db_path);
    let broadcast_tx = lobby.broadcast_tx.clone();
    let app = http::create_router(lobby, game_pages_dir);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind port {}: {}", port, e))?;

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let join_handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await
        .ok();
    });

    Ok(ServerInstance {
        shutdown_tx,
        join_handle,
        broadcast_tx,
    })
}
