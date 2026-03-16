use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

use crate::database::sqlite;

// ─── 玩家信息 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct PlayerInfo {
    pub id: i64,
    pub session_id: usize,
    pub name: String,
    pub ip: String,
}

static NEXT_SESSION_ID: AtomicUsize = AtomicUsize::new(1);

// ─── 房间相关类型 ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RoomType {
    Pvp,
    PvAI,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AiDifficulty {
    Easy,
    Normal,
    Hard,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RoomState {
    Waiting,
    Playing,
}

/// 参战玩家席位
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RoomPlayer {
    pub session_id: usize,
    pub name: String,
    /// 游戏内角色，由游戏定义（如象棋: "red"/"black"）
    pub role: String,
    /// 玩家 IP，用于断线重连时恢复房间归属
    pub ip: String,
    /// 是否当前离线（WS 断开但未主动离开）
    pub disconnected: bool,
}

/// 房间
#[derive(Debug, Clone, serde::Serialize)]
pub struct Room {
    pub id: String,
    pub name: String,
    /// 游戏标识符，与前端 GAME_REGISTRY key 对应（如 "chess"）
    pub game: String,
    pub max_players: usize,
    pub room_type: RoomType,
    pub ai_difficulty: Option<AiDifficulty>,
    pub allow_spectate: bool,
    pub state: RoomState,
    pub players: Vec<RoomPlayer>,
    pub spectators: Vec<usize>,
    pub created_by: usize,
    /// 认输票（session_id 列表）
    pub surrender_votes: Vec<usize>,
}

impl Room {
    /// 有效参战人数（包含离线玩家，席位仍保留）
    pub fn player_count(&self) -> usize {
        self.players.len()
    }

    /// 在线参战人数
    pub fn online_player_count(&self) -> usize {
        self.players.iter().filter(|p| !p.disconnected).count()
    }

    pub fn is_full(&self) -> bool {
        self.players.len() >= self.max_players
    }

    /// 真正空房间：无参战玩家（含离线）且无观战
    pub fn is_empty(&self) -> bool {
        self.players.is_empty() && self.spectators.is_empty()
    }

    pub fn get_all_session_ids(&self) -> Vec<usize> {
        let mut ids: Vec<usize> = self.players.iter()
            .filter(|p| !p.disconnected)
            .map(|p| p.session_id)
            .collect();
        ids.extend(self.spectators.iter().copied());
        ids
    }

    fn assign_role(game: &str, index: usize) -> String {
        match game {
            "chess" => if index == 0 { "red".to_string() } else { "black".to_string() },
            _ => format!("player{}", index + 1),
        }
    }
}

// ─── 大厅 ─────────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct Lobby {
    pub players: Arc<RwLock<HashMap<usize, PlayerInfo>>>,
    pub online_count: Arc<AtomicUsize>,
    pub broadcast_tx: broadcast::Sender<String>,
    pub db_path: PathBuf,
    /// 全量房间表
    pub rooms: Arc<RwLock<HashMap<String, Room>>>,
    /// session_id → room_id（当前连接的映射，断线后清除）
    pub session_rooms: Arc<RwLock<HashMap<usize, String>>>,
    /// ip → room_id（跨连接持久，断线重连后恢复用）
    pub ip_rooms: Arc<RwLock<HashMap<String, String>>>,
}

impl Lobby {
    pub fn new(online_count: Arc<AtomicUsize>, db_path: PathBuf) -> Self {
        let (broadcast_tx, _) = broadcast::channel(512);
        Self {
            players: Arc::new(RwLock::new(HashMap::new())),
            online_count,
            broadcast_tx,
            db_path,
            rooms: Arc::new(RwLock::new(HashMap::new())),
            session_rooms: Arc::new(RwLock::new(HashMap::new())),
            ip_rooms: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    // ── 玩家连接/断开 ─────────────────────────────────────────────────────────

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
            ip: ip.clone(),
        };

        self.players.write().await.insert(session_id, player.clone());
        self.online_count.fetch_add(1, Ordering::Relaxed);
        self.broadcast_player_count().await;

        // 检查此 IP 是否有断线前的房间归属，若有则自动恢复
        self.restore_room_session(&ip, session_id).await;

        player
    }

    /// 当 WS 连接断开时调用：仅从 players 中移除，不销毁房间
    /// 房间中的 RoomPlayer 标记为 disconnected，席位保留等待重连
    pub async fn player_leave(&self, session_id: usize) {
        // 找到该 session 的 IP，将房间中对应席位标记为离线
        let ip = {
            let p = self.players.read().await;
            p.get(&session_id).map(|pi| pi.ip.clone())
        };

        if let Some(ref ip) = ip {
            let room_id = {
                let sr = self.session_rooms.read().await;
                sr.get(&session_id).cloned()
            };
            if let Some(ref rid) = room_id {
                let mut rooms = self.rooms.write().await;
                if let Some(room) = rooms.get_mut(rid) {
                    for p in room.players.iter_mut() {
                        if p.ip == *ip {
                            p.disconnected = true;
                            break;
                        }
                    }
                    // 同时清理该 session 的观战记录
                    room.spectators.retain(|&s| s != session_id);

                    let snap = room.clone();
                    drop(rooms);
                    // 通知房间内其他在线成员
                    self.broadcast_room_update(&snap).await;
                    self.broadcast_room_list().await;
                }
            }
        }

        // 清除 session 级别的映射（IP 级别的 ip_rooms 保留）
        self.session_rooms.write().await.remove(&session_id);
        self.players.write().await.remove(&session_id);
        self.online_count.fetch_sub(1, Ordering::Relaxed);
        self.broadcast_player_count().await;
    }

    /// 断线重连：将房间中 disconnected 的席位更新为新 session，并通知客户端
    async fn restore_room_session(&self, ip: &str, new_session_id: usize) {
        let room_id = {
            let ir = self.ip_rooms.read().await;
            ir.get(ip).cloned()
        };
        let Some(room_id) = room_id else { return };

        let mut rooms = self.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else {
            // 房间已不存在，清理 ip_rooms
            drop(rooms);
            self.ip_rooms.write().await.remove(ip);
            return;
        };

        let old_session_id = room.players.iter()
            .find(|p| p.ip == ip)
            .map(|p| p.session_id);

        if let Some(old_sid) = old_session_id {
            // 更新席位的 session_id，恢复在线状态
            for p in room.players.iter_mut() {
                if p.ip == ip {
                    p.session_id = new_session_id;
                    p.disconnected = false;
                    break;
                }
            }

            // 若游戏在进行中且人数重新满了，保持 Playing
            let snap = room.clone();
            drop(rooms);

            // 更新 session_rooms
            {
                let mut sr = self.session_rooms.write().await;
                sr.remove(&old_sid);
                sr.insert(new_session_id, room_id.clone());
            }

            // 把房间完整数据发给重连的玩家
            let msg = serde_json::json!({
                "type": "room_joined",
                "room": snap,
                "reconnected": true
            }).to_string();
            self.broadcast_to_sessions(&[new_session_id], &msg).await;

            // 通知其他房间成员
            self.broadcast_room_update(&snap).await;
            self.broadcast_room_list().await;
        }
    }

    pub async fn update_player_name(&self, session_id: usize, name: &str) {
        let mut players = self.players.write().await;
        if let Some(player) = players.get_mut(&session_id) {
            player.name = name.to_string();
            let _ = sqlite::update_player_name(&self.db_path, player.id, name);
        }
        drop(players);

        // 同步更新房间中的玩家名
        let room_id = {
            let sr = self.session_rooms.read().await;
            sr.get(&session_id).cloned()
        };
        if let Some(rid) = room_id {
            let mut rooms = self.rooms.write().await;
            if let Some(room) = rooms.get_mut(&rid) {
                for p in room.players.iter_mut() {
                    if p.session_id == session_id {
                        p.name = name.to_string();
                        break;
                    }
                }
                let snap = room.clone();
                drop(rooms);
                self.broadcast_room_update(&snap).await;
            }
        }
    }

    pub async fn get_player_list(&self) -> Vec<PlayerInfo> {
        self.players.read().await.values().cloned().collect()
    }

    // ── 房间管理 ──────────────────────────────────────────────────────────────

    pub async fn create_room(
        &self,
        session_id: usize,
        ip: String,
        name: String,
        game: String,
        max_players: usize,
        room_type: RoomType,
        ai_difficulty: Option<AiDifficulty>,
        allow_spectate: bool,
    ) -> Result<Room, String> {
        // 若已在某个房间，先主动离开
        self.leave_room(session_id).await;

        let player_name = {
            let players = self.players.read().await;
            players.get(&session_id).map(|p| p.name.clone()).unwrap_or_else(|| "玩家".to_string())
        };

        let room_id = generate_room_id();
        let role = Room::assign_role(&game, 0);
        let room = Room {
            id: room_id.clone(),
            name,
            game,
            max_players,
            room_type,
            ai_difficulty,
            allow_spectate,
            state: RoomState::Waiting,
            players: vec![RoomPlayer { session_id, name: player_name, role, ip: ip.clone(), disconnected: false }],
            spectators: vec![],
            created_by: session_id,
            surrender_votes: vec![],
        };

        self.rooms.write().await.insert(room_id.clone(), room.clone());
        self.session_rooms.write().await.insert(session_id, room_id.clone());
        self.ip_rooms.write().await.insert(ip, room_id);

        self.broadcast_room_list().await;
        Ok(room)
    }

    pub async fn join_room(
        &self,
        session_id: usize,
        ip: String,
        room_id: &str,
        as_spectator: bool,
    ) -> Result<Room, String> {
        // 若已在此房间（重连场景），直接返回当前房间状态
        {
            let sr = self.session_rooms.read().await;
            if sr.get(&session_id).map(|r| r.as_str()) == Some(room_id) {
                let rooms = self.rooms.read().await;
                if let Some(room) = rooms.get(room_id) {
                    return Ok(room.clone());
                }
            }
        }

        // 若已在其他房间，先离开
        self.leave_room(session_id).await;

        let player_name = {
            let players = self.players.read().await;
            players.get(&session_id).map(|p| p.name.clone()).unwrap_or_else(|| "玩家".to_string())
        };

        let mut rooms = self.rooms.write().await;
        let room = rooms.get_mut(room_id).ok_or_else(|| "房间不存在".to_string())?;

        if as_spectator {
            if !room.allow_spectate {
                return Err("该房间不允许观战".to_string());
            }
            if room.spectators.contains(&session_id) {
                return Err("已在观战列表中".to_string());
            }
            room.spectators.push(session_id);
        } else {
            // 检查是否同 IP 已有席位（断线未恢复的情况）
            let has_seat = room.players.iter().any(|p| p.ip == ip);
            if has_seat {
                // 更新 session_id，恢复席位
                for p in room.players.iter_mut() {
                    if p.ip == ip {
                        p.session_id = session_id;
                        p.disconnected = false;
                        break;
                    }
                }
            } else if room.is_full() {
                return Err("房间已满，可以选择观战".to_string());
            } else {
                let index = room.players.len();
                let role = Room::assign_role(&room.game, index);
                room.players.push(RoomPlayer { session_id, name: player_name, role, ip: ip.clone(), disconnected: false });

                if room.players.len() >= room.max_players {
                    room.state = RoomState::Playing;
                }
            }
        }

        let room_snapshot = room.clone();
        drop(rooms);

        self.session_rooms.write().await.insert(session_id, room_id.to_string());
        if !as_spectator {
            self.ip_rooms.write().await.insert(ip, room_id.to_string());
        }

        self.broadcast_room_update(&room_snapshot).await;
        self.broadcast_room_list().await;

        Ok(room_snapshot)
    }

    /// 主动离开房间（仅由显式 leave_room 消息调用）
    pub async fn leave_room(&self, session_id: usize) {
        let room_id = {
            let mut sr = self.session_rooms.write().await;
            sr.remove(&session_id)
        };
        let Some(room_id) = room_id else { return };

        let mut rooms = self.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else { return };

        // 找到该 session 的 IP，清理 ip_rooms
        let ip = room.players.iter()
            .find(|p| p.session_id == session_id)
            .map(|p| p.ip.clone());

        room.players.retain(|p| p.session_id != session_id);
        room.spectators.retain(|&s| s != session_id);
        room.surrender_votes.retain(|&s| s != session_id);

        // 清理 IP → 房间映射
        if let Some(ref ip) = ip {
            self.ip_rooms.write().await.remove(ip);
        }

        if room.is_empty() {
            rooms.remove(&room_id);
            drop(rooms);
        } else {
            if room.state == RoomState::Playing {
                room.state = RoomState::Waiting;
            }
            let snapshot = room.clone();
            drop(rooms);
            self.broadcast_room_update(&snapshot).await;
        }

        self.broadcast_room_list().await;
    }

    pub async fn switch_role(&self, session_id: usize, ip: String, to_spectator: bool) -> Result<Room, String> {
        let room_id = {
            let sr = self.session_rooms.read().await;
            sr.get(&session_id).cloned().ok_or_else(|| "不在任何房间中".to_string())?
        };

        let player_name = {
            let players = self.players.read().await;
            players.get(&session_id).map(|p| p.name.clone()).unwrap_or_else(|| "玩家".to_string())
        };

        let mut rooms = self.rooms.write().await;
        let room = rooms.get_mut(&room_id).ok_or_else(|| "房间不存在".to_string())?;

        if to_spectator {
            room.players.retain(|p| p.session_id != session_id);
            if !room.spectators.contains(&session_id) {
                room.spectators.push(session_id);
            }
            if room.state == RoomState::Playing {
                room.state = RoomState::Waiting;
            }
            // 清除 IP 房间映射（不再占席位）
            drop(rooms);
            self.ip_rooms.write().await.remove(&ip);
        } else {
            if room.is_full() {
                return Err("参战席位已满".to_string());
            }
            room.spectators.retain(|&s| s != session_id);
            let index = room.players.len();
            let role = Room::assign_role(&room.game, index);
            room.players.push(RoomPlayer { session_id, name: player_name, role, ip: ip.clone(), disconnected: false });

            if room.players.len() >= room.max_players {
                room.state = RoomState::Playing;
            }
            drop(rooms);
            self.ip_rooms.write().await.insert(ip, room_id.clone());
        }

        let snap = {
            let rooms = self.rooms.read().await;
            rooms.get(&room_id).cloned()
        };
        let snap = snap.ok_or_else(|| "房间不存在".to_string())?;

        self.broadcast_room_update(&snap).await;
        self.broadcast_room_list().await;
        Ok(snap)
    }

    pub async fn vote_surrender(&self, session_id: usize) -> Option<String> {
        let room_id = {
            let sr = self.session_rooms.read().await;
            sr.get(&session_id).cloned()?
        };

        let mut rooms = self.rooms.write().await;
        let room = rooms.get_mut(&room_id)?;

        if !room.surrender_votes.contains(&session_id) {
            room.surrender_votes.push(session_id);
        }

        if room.max_players <= 2 || !room.surrender_votes.is_empty() {
            let winner_role = room.players.iter()
                .find(|p| p.session_id != session_id)
                .map(|p| p.role.clone())
                .unwrap_or_else(|| "unknown".to_string());

            let all_ids = room.get_all_session_ids();
            drop(rooms);

            let msg = serde_json::json!({
                "type": "game_over",
                "reason": "surrender",
                "winner_role": winner_role
            }).to_string();
            self.broadcast_to_sessions(&all_ids, &msg).await;
            return Some(room_id);
        }

        None
    }

    pub async fn get_room_list(&self) -> Vec<serde_json::Value> {
        let rooms = self.rooms.read().await;
        rooms.values().map(|r| serde_json::json!({
            "id": r.id,
            "name": r.name,
            "game": r.game,
            "room_type": r.room_type,
            "ai_difficulty": r.ai_difficulty,
            "allow_spectate": r.allow_spectate,
            "state": r.state,
            "player_count": r.player_count(),
            "online_player_count": r.online_player_count(),
            "max_players": r.max_players,
            "spectator_count": r.spectators.len(),
        })).collect()
    }

    // ── 广播工具 ──────────────────────────────────────────────────────────────

    pub async fn broadcast_to_room(&self, room_id: &str, msg: &str) {
        let sessions = {
            let rooms = self.rooms.read().await;
            rooms.get(room_id).map(|r| r.get_all_session_ids()).unwrap_or_default()
        };
        self.broadcast_to_sessions(&sessions, msg).await;
    }

    pub async fn broadcast_to_sessions(&self, sessions: &[usize], msg: &str) {
        let wrapped = serde_json::json!({
            "_targets": sessions,
            "_payload": msg
        }).to_string();
        let _ = self.broadcast_tx.send(wrapped);
    }

    pub async fn broadcast_room_update(&self, room: &Room) {
        let msg = serde_json::json!({
            "type": "room_updated",
            "room": room
        }).to_string();
        self.broadcast_to_room(&room.id, &msg).await;
    }

    pub async fn broadcast_room_list(&self) {
        let rooms = self.get_room_list().await;
        let msg = serde_json::json!({
            "type": "room_list_update",
            "rooms": rooms
        }).to_string();
        let _ = self.broadcast_tx.send(msg);
    }

    async fn broadcast_player_count(&self) {
        let count = self.online_count.load(Ordering::Relaxed);
        let msg = serde_json::json!({
            "type": "player_count",
            "count": count
        }).to_string();
        let _ = self.broadcast_tx.send(msg);
    }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

fn generate_room_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut id = String::with_capacity(6);
    let mut n = seed;
    for _ in 0..6 {
        id.push(CHARS[(n as usize) % CHARS.len()] as char);
        n = n.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    }
    id
}
