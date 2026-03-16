use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

pub struct ServerHandle {
    pub join_handle: JoinHandle<()>,
    pub shutdown_tx: tokio::sync::oneshot::Sender<()>,
    pub broadcast_tx: tokio::sync::broadcast::Sender<String>,
}

pub struct AppState {
    pub server_handle: Mutex<Option<ServerHandle>>,
    pub online_count: Arc<AtomicUsize>,
    pub running: Arc<AtomicBool>,
    pub port: Mutex<u16>,
    pub data_dir: PathBuf,
    pub game_pages_dir: PathBuf,
}

impl AppState {
    pub fn new(data_dir: PathBuf, game_pages_dir: PathBuf) -> Self {
        Self {
            server_handle: Mutex::new(None),
            online_count: Arc::new(AtomicUsize::new(0)),
            running: Arc::new(AtomicBool::new(false)),
            port: Mutex::new(3000),
            data_dir,
            game_pages_dir,
        }
    }
}
