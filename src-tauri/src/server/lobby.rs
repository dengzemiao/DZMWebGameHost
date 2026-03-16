use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

use crate::database::sqlite;

#[derive(Debug, Clone, serde::Serialize)]
pub struct PlayerInfo {
    pub id: i64,
    pub session_id: usize,
    pub name: String,
    pub ip: String,
}

static NEXT_SESSION_ID: AtomicUsize = AtomicUsize::new(1);

#[derive(Clone)]
pub struct Lobby {
    /// session_id -> PlayerInfo (in-memory online players)
    pub players: Arc<RwLock<HashMap<usize, PlayerInfo>>>,
    pub online_count: Arc<AtomicUsize>,
    pub broadcast_tx: broadcast::Sender<String>,
    pub db_path: PathBuf,
}

impl Lobby {
    pub fn new(online_count: Arc<AtomicUsize>, db_path: PathBuf) -> Self {
        let (broadcast_tx, _) = broadcast::channel(256);
        Self {
            players: Arc::new(RwLock::new(HashMap::new())),
            online_count,
            broadcast_tx,
            db_path,
        }
    }

    pub async fn player_join(&self, ip: String) -> PlayerInfo {
        let db_player = sqlite::find_or_create_player(&self.db_path, &ip)
            .unwrap_or_else(|e| {
                eprintln!("[Lobby] DB error: {}, using fallback", e);
                sqlite::DbPlayer {
                    id: 0,
                    name: format!("玩家{}", ip),
                    ip_address: ip.clone(),
                }
            });

        let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        let player = PlayerInfo {
            id: db_player.id,
            session_id,
            name: db_player.name,
            ip,
        };

        self.players.write().await.insert(session_id, player.clone());
        self.online_count.fetch_add(1, Ordering::Relaxed);
        self.broadcast_player_count().await;

        player
    }

    pub async fn player_leave(&self, session_id: usize) {
        self.players.write().await.remove(&session_id);
        self.online_count.fetch_sub(1, Ordering::Relaxed);
        self.broadcast_player_count().await;
    }

    pub async fn update_player_name(&self, session_id: usize, name: &str) {
        let mut players = self.players.write().await;
        if let Some(player) = players.get_mut(&session_id) {
            player.name = name.to_string();
            let _ = sqlite::update_player_name(&self.db_path, player.id, name);
        }
    }

    pub async fn get_player_list(&self) -> Vec<PlayerInfo> {
        self.players.read().await.values().cloned().collect()
    }

    async fn broadcast_player_count(&self) {
        let count = self.online_count.load(Ordering::Relaxed);
        let msg = serde_json::json!({
            "type": "player_count",
            "count": count
        });
        let _ = self.broadcast_tx.send(msg.to_string());
    }
}
