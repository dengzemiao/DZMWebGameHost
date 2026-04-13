use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, oneshot, RwLock};

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
    #[serde(rename = "pv_ai")]
    PvAI,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AiDifficulty {
    Easy,
    Normal,
    Hard,
    Hell,
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
    /// 游戏内角色，由游戏定义（如象棋: "red"/"black"；文字找茬: "player1".."player12"）
    pub role: String,
    /// 玩家 IP，用于断线重连时恢复房间归属
    pub ip: String,
    /// 是否当前离线（WS 断开但未主动离开）
    pub disconnected: bool,
}

// ─── 文字找茬游戏结构 ─────────────────────────────────────────────────────────

/// 文字找茬：单个玩家本轮进度
#[derive(Debug, Clone, serde::Serialize)]
pub struct PlayerLevelProgress {
    pub session_id: usize,
    pub name: String,
    /// 已完成关数
    pub current_level: usize,
    /// 累计用时（毫秒）
    pub elapsed_ms: u64,
    /// 是否完成所有关卡
    pub finished: bool,
    /// 是否中途退出/切换观战（算弃赛）
    pub dropped: bool,
}

/// 文字找茬：本轮运行状态（不放 Room，单独存在 Lobby.round_states）
#[derive(Debug)]
pub struct GameRoundState {
    pub seed: u64,
    pub difficulty: String,
    pub total_levels: usize,
    pub total_duration_ms: u64,
    /// 开始时间（Unix 毫秒时间戳）
    pub started_at_ms: u64,
    /// 参战玩家进度，key = session_id
    pub players: HashMap<usize, PlayerLevelProgress>,
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
    /// 当前一局游戏状态（棋盘、回合等），由客户端在走棋时上报，用于新人/重连恢复战局
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_state: Option<serde_json::Value>,
    /// 游戏配置（如文字找茬的总关数、每关时长）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_config: Option<serde_json::Value>,
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

    fn assign_role(game: &str, existing_players: &[RoomPlayer]) -> String {
        match game {
            "chess" => {
                // 象棋：红方先手，优先分配红方
                let has_red = existing_players.iter().any(|p| p.role == "red");
                if !has_red { "red".to_string() } else { "black".to_string() }
            }
            "gomoku" | "go" => {
                // 五子棋/围棋：黑方先手，优先分配黑方
                let has_black = existing_players.iter().any(|p| p.role == "black");
                if !has_black { "black".to_string() } else { "white".to_string() }
            }
            "word_spot" | "color_lines" => {
                // 找最小可用编号（填补空缺），保证 player1 始终被优先占满
                let mut num = 1usize;
                loop {
                    let role = format!("player{}", num);
                    if !existing_players.iter().any(|p| p.role == role) {
                        return role;
                    }
                    num += 1;
                }
            }
            _ => format!("player{}", existing_players.len() + 1),
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
    /// 按房间号缓存的当前一局游戏状态（内存临时存储，房间销毁时移除）
    pub room_game_state: Arc<RwLock<HashMap<String, serde_json::Value>>>,
    /// 文字找茬：按房间号存储本轮运行状态
    pub round_states: Arc<RwLock<HashMap<String, GameRoundState>>>,
    /// 文字找茬：按房间号存储倒计时取消发送端
    pub round_cancel_txs: Arc<RwLock<HashMap<String, oneshot::Sender<()>>>>,
    /// 文字找茬：缓存最近一局 round_ended 完整 payload，供后来观战/参战者查看
    pub round_final_leaderboards: Arc<RwLock<HashMap<String, serde_json::Value>>>,
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
            room_game_state: Arc::new(RwLock::new(HashMap::new())),
            round_states: Arc::new(RwLock::new(HashMap::new())),
            round_cancel_txs: Arc::new(RwLock::new(HashMap::new())),
            round_final_leaderboards: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 获取房间当前一局的游戏状态（用于加入/重连时下发给客户端）
    pub async fn get_room_game_state(&self, room_id: &str) -> Option<serde_json::Value> {
        self.room_game_state.read().await.get(room_id).cloned()
    }

    /// 记录房间当前局游戏状态（由 game_action 上报时调用）
    pub async fn record_game_state(&self, room_id: &str, state: serde_json::Value) {
        self.room_game_state.write().await.insert(room_id.to_string(), state);
    }

    /// 清空房间当前局游戏状态（再来一局 / 房间销毁时调用）
    pub async fn clear_room_game_state(&self, room_id: &str) {
        self.room_game_state.write().await.remove(room_id);
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

                    let mut snap = room.clone();
                    drop(rooms);
                    snap.game_state = self.get_room_game_state(rid).await;
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
            let mut snap = room.clone();
            drop(rooms);

            // 更新 session_rooms
            {
                let mut sr = self.session_rooms.write().await;
                sr.remove(&old_sid);
                sr.insert(new_session_id, room_id.clone());
            }

            snap.game_state = self.get_room_game_state(&room_id).await;

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
                let mut snap = room.clone();
                drop(rooms);
                snap.game_state = self.get_room_game_state(&rid).await;
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
        game_config: Option<serde_json::Value>,
    ) -> Result<Room, String> {
        // 若已在某个房间，先主动离开
        self.leave_room(session_id).await;

        let player_name = {
            let players = self.players.read().await;
            players.get(&session_id).map(|p| p.name.clone()).unwrap_or_else(|| "玩家".to_string())
        };

        let room_id = generate_room_id();
        let role = Room::assign_role(&game, &[]);
        
        // PvAI 模式：创建时就开始游戏；word_spot 需要房主手动开始；PvP 模式：等待玩家加入
        let initial_state = if room_type == RoomType::PvAI {
            RoomState::Playing
        } else {
            RoomState::Waiting
        };
        
        // 提前判断是否需要广播 game_restart（避免 room_type 被移动）
        let should_broadcast_restart = room_type == RoomType::PvAI;
        
        let room = Room {
            id: room_id.clone(),
            name,
            game,
            max_players,
            room_type,
            ai_difficulty,
            allow_spectate,
            state: initial_state,
            players: vec![RoomPlayer { session_id, name: player_name, role, ip: ip.clone(), disconnected: false }],
            spectators: vec![],
            created_by: session_id,
            surrender_votes: vec![],
            game_state: None,
            game_config,
        };

        self.rooms.write().await.insert(room_id.clone(), room.clone());
        self.session_rooms.write().await.insert(session_id, room_id.clone());
        self.ip_rooms.write().await.insert(ip, room_id);

        // PvAI 模式：创建时广播 game_restart，通知游戏开始
        if should_broadcast_restart {
            let restart_msg = serde_json::json!({
                "type": "game_restart"
            }).to_string();
            let all_ids = vec![session_id];
            self.broadcast_to_sessions(&all_ids, &restart_msg).await;
        }

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
        // 若已在此房间（重连场景），直接返回当前房间状态（包含最新游戏状态）
        {
            let sr = self.session_rooms.read().await;
            if sr.get(&session_id).map(|r| r.as_str()) == Some(room_id) {
                let rooms = self.rooms.read().await;
                if let Some(room) = rooms.get(room_id) {
                    let mut room_snapshot = room.clone();
                    drop(rooms);
                    // 获取当前局游戏状态，用于刷新页面后恢复棋盘
                    room_snapshot.game_state = self.get_room_game_state(room_id).await;
                    return Ok(room_snapshot);
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
        
        let was_playing = room.state == RoomState::Playing;

        if as_spectator {
            if !room.allow_spectate {
                return Err("该房间不允许观战".to_string());
            }
            if room.spectators.contains(&session_id) {
                return Err("已在观战列表中".to_string());
            }
            room.spectators.push(session_id);
        } else {
            // 文字找茬/超级方块：游戏进行中不允许新玩家加入参战，强制切换为观战
            if (room.game == "word_spot" || room.game == "color_lines") && room.state == RoomState::Playing {
                if !room.allow_spectate {
                    return Err("进行中不能加入".to_string());
                }
                if !room.spectators.contains(&session_id) {
                    room.spectators.push(session_id);
                }
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
                    let role = Room::assign_role(&room.game, &room.players);
                    room.players.push(RoomPlayer { session_id, name: player_name, role, ip: ip.clone(), disconnected: false });

                    // PvAI 模式：第 1 个玩家加入就开始游戏；PvP 模式：人数满时才开始
                    // word_spot/color_lines 需要房主手动开始，不自动 Playing
                    if room.room_type == RoomType::PvAI || (room.game != "word_spot" && room.game != "color_lines" && room.players.len() >= room.max_players) {
                        room.state = RoomState::Playing;
                    }
                }
            }
        }

        let mut room_snapshot = room.clone();
        drop(rooms);

        self.session_rooms.write().await.insert(session_id, room_id.to_string());
        if !as_spectator {
            self.ip_rooms.write().await.insert(ip, room_id.to_string());
        }

        // 获取当前局状态附给新加入的玩家（用于恢复战局）
        room_snapshot.game_state = self.get_room_game_state(room_id).await;
        
        // 仅通知新加入的玩家（带 game_state），其他成员只接收房间更新
        let join_msg = serde_json::json!({
            "type": "room_joined",
            "room": room_snapshot
        }).to_string();
        self.broadcast_to_sessions(&[session_id], &join_msg).await;
        
        // 通知房间内其他在线成员：房间有更新（不含 game_state，避免触发重置）
        let update_msg = serde_json::json!({
            "type": "room_updated",
            "room": {
                "id": room_snapshot.id,
                "name": room_snapshot.name,
                "game": room_snapshot.game,
                "max_players": room_snapshot.max_players,
                "room_type": room_snapshot.room_type,
                "ai_difficulty": room_snapshot.ai_difficulty,
                "allow_spectate": room_snapshot.allow_spectate,
                "state": room_snapshot.state,
                "players": room_snapshot.players,
                "spectators": room_snapshot.spectators,
                "created_by": room_snapshot.created_by,
                "surrender_votes": room_snapshot.surrender_votes
            }
        }).to_string();
        self.broadcast_to_room(room_id, &update_msg).await;
        
        self.broadcast_room_list().await;

        // PvAI 模式：第 1 个玩家加入时，广播 game_restart 通知游戏开始
        // PvP 模式：若从 waiting 变为 playing（第二位玩家加入），广播 game_restart 通知双方游戏开始
        // 注意：必须在 room_updated 之后发送，确保客户端先更新房间状态
        if (room_snapshot.room_type == RoomType::PvAI && !was_playing && room_snapshot.state == RoomState::Playing) ||
           (room_snapshot.room_type == RoomType::Pvp && !was_playing && room_snapshot.state == RoomState::Playing) {
            // 延迟一小段时间，确保 room_updated 先被处理
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            
            let restart_msg = serde_json::json!({
                "type": "game_restart"
            }).to_string();
            let all_ids = room_snapshot.get_all_session_ids();
            self.broadcast_to_sessions(&all_ids, &restart_msg).await;
        }
        
        // 观战者加入且游戏已在进行中，额外同步一次当前游戏状态（确保观战者能看到最新棋盘）
        if as_spectator && was_playing && room_snapshot.game_state.is_some() {
            let sync_msg = serde_json::json!({
                "type": "game_action",
                "action": "sync_state",
                "game_state": room_snapshot.game_state
            }).to_string();
            self.broadcast_to_sessions(&[session_id], &sync_msg).await;
        }

        // 文字找茬：如果游戏进行中，同步本轮状态给新加入者（排行榜+剩余时间）
        if was_playing && room_snapshot.game == "word_spot" {
            let round_state_opt = self.round_states.read().await;
            if let Some(rs) = round_state_opt.get(room_id) {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let elapsed = now_ms.saturating_sub(rs.started_at_ms);
                let remaining_ms = rs.total_duration_ms.saturating_sub(elapsed);
                let leaderboard: Vec<&PlayerLevelProgress> = rs.players.values().collect();
                let sync_msg = serde_json::json!({
                    "type": "game_started",
                    "seed": rs.seed,
                    "difficulty": rs.difficulty,
                    "total_levels": rs.total_levels,
                    "total_duration_ms": rs.total_duration_ms,
                    "remaining_ms": remaining_ms,
                    "leaderboard": leaderboard,
                    "reconnect": true
                }).to_string();
                drop(round_state_opt);
                self.broadcast_to_sessions(&[session_id], &sync_msg).await;
            }
        }

        // 文字找茬：游戏未在进行中，但有缓存的最终榜单，下发给新加入者（让其看到上局结果）
        if !was_playing && room_snapshot.game == "word_spot" {
            let final_lb_opt = self.round_final_leaderboards.read().await;
            if let Some(payload) = final_lb_opt.get(room_id) {
                let msg = payload.to_string();
                drop(final_lb_opt);
                self.broadcast_to_sessions(&[session_id], &msg).await;
            }
        }

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

        // 文字找茬/超级方块：游戏进行中离开的特殊处理
        let is_start_game_driven_playing = (room.game == "word_spot" || room.game == "color_lines") && room.state == RoomState::Playing;
        let player_in_game = is_start_game_driven_playing && room.players.iter().any(|p| p.session_id == session_id);
        
        room.players.retain(|p| p.session_id != session_id);
        room.spectators.retain(|&s| s != session_id);
        room.surrender_votes.retain(|&s| s != session_id);

        // 文字找茬/超级方块：重新分配剩余参战玩家角色，保证 player1 始终存在
        if room.game == "word_spot" || room.game == "color_lines" {
            reassign_word_spot_roles(&mut room.players);
        }

        // 清理 IP → 房间映射
        if let Some(ref ip) = ip {
            self.ip_rooms.write().await.remove(ip);
        }

        if room.is_empty() {
            rooms.remove(&room_id);
            drop(rooms);
            self.clear_room_game_state(&room_id).await;
            // 取消倒计时
            if let Some(tx) = self.round_cancel_txs.write().await.remove(&room_id) {
                let _ = tx.send(());
            }
            self.round_states.write().await.remove(&room_id);
            self.round_final_leaderboards.write().await.remove(&room_id);
            // 通知所有人（大厅+其他房间）房间已消失
            self.broadcast_room_list().await;
        } else if is_start_game_driven_playing && player_in_game && room.game == "word_spot" {
            // 文字找茬游戏中玩家退出：标记为弃赛，不改房间状态
            let snapshot = room.clone();
            drop(rooms);
            
            // 标记该玩家为弃赛，并取出最新排行榜用于广播
            let (should_end, leaderboard_snapshot, total_levels) = {
                let mut rs_map = self.round_states.write().await;
                if let Some(rs) = rs_map.get_mut(&room_id) {
                    if let Some(prog) = rs.players.get_mut(&session_id) {
                        prog.dropped = true;
                    }
                    let all_done = rs.players.values().all(|p| p.finished || p.dropped);
                    let mut lb: Vec<PlayerLevelProgress> = rs.players.values().cloned().collect();
                    lb.sort_by(|a, b| {
                        b.current_level.cmp(&a.current_level)
                            .then(a.elapsed_ms.cmp(&b.elapsed_ms))
                    });
                    let total = rs.total_levels;
                    (all_done, Some(lb), total)
                } else {
                    (false, None, 0)
                }
            };

            // 广播弃赛后的排行榜更新
            if let Some(lb) = leaderboard_snapshot {
                let all_ids = snapshot.get_all_session_ids();
                let lb_msg = serde_json::json!({
                    "type": "leaderboard_update",
                    "leaderboard": lb,
                    "total_levels": total_levels
                }).to_string();
                self.broadcast_to_sessions(&all_ids, &lb_msg).await;
            }

            self.broadcast_room_update(&snapshot).await;
            self.broadcast_room_list().await;
            
            if should_end {
                self.end_round(&room_id, "all_done").await;
            }
        } else if room.game == "color_lines" && room.state == RoomState::Playing && !player_in_game {
            // 超级方块：观战者离开不影响游戏，仅广播房间更新
            let mut snapshot = room.clone();
            drop(rooms);
            snapshot.game_state = self.get_room_game_state(&room_id).await;
            self.broadcast_room_update(&snapshot).await;
            self.broadcast_room_list().await;
        } else {
            let was_playing = room.state == RoomState::Playing;
            
            if room.state == RoomState::Playing {
                room.state = RoomState::Waiting;
            }
            
            let mut snapshot = room.clone();
            drop(rooms);
            snapshot.game_state = self.get_room_game_state(&room_id).await;
            
            // 通知房间内其他在线成员
            self.broadcast_room_update(&snapshot).await;
            
            // 若游戏原本在进行中，通知所有在线成员游戏已结束（玩家离开导致）
            if was_playing && snapshot.room_type == RoomType::Pvp {
                let all_ids = snapshot.get_all_session_ids();
                let game_over_msg = serde_json::json!({
                    "type": "game_over",
                    "reason": "opponent_leave",
                    "message": "对手已离开"
                }).to_string();
                self.broadcast_to_sessions(&all_ids, &game_over_msg).await;
            }

            self.broadcast_room_list().await;
        }
    }

    // ── 文字找茬：回合管理 ─────────────────────────────────────────────────────────────

    /// 超级方块：房主(player1)发起开始游戏
    pub async fn start_color_lines(&self, session_id: usize, difficulty: String) -> Result<(), String> {
        let room_id = {
            let sr = self.session_rooms.read().await;
            sr.get(&session_id).cloned().ok_or_else(|| "不在任何房间中".to_string())?
        };

        let all_player_ids = {
            let mut rooms = self.rooms.write().await;
            let room = rooms.get_mut(&room_id).ok_or_else(|| "房间不存在".to_string())?;

            if room.game != "color_lines" {
                return Err("不是超级方块房间".to_string());
            }
            let is_host = room.players.iter().any(|p| p.session_id == session_id && p.role == "player1");
            if !is_host {
                return Err("只有房主可以开始游戏".to_string());
            }
            if room.players.is_empty() {
                return Err("至少需要 1 个参战玩家".to_string());
            }
            if room.state == RoomState::Playing {
                return Err("游戏已在进行中".to_string());
            }

            room.state = RoomState::Playing;
            room.get_all_session_ids()
        };

        // 广播开始消息（纯客户端游戏，不需要服务端管理 round_state）
        let start_msg = serde_json::json!({
            "type": "game_started",
            "difficulty": difficulty
        }).to_string();
        self.broadcast_to_sessions(&all_player_ids, &start_msg).await;

        // 同步广播 room_updated
        {
            let rooms = self.rooms.read().await;
            if let Some(room) = rooms.get(&room_id) {
                let snap = room.clone();
                drop(rooms);
                self.broadcast_room_update(&snap).await;
                self.broadcast_room_list().await;
            }
        }

        Ok(())
    }

    /// 房主(player1)发起开始游戏（文字找茬）
    pub async fn start_round(&self, session_id: usize, difficulty: String) -> Result<(), String> {
        let room_id = {
            let sr = self.session_rooms.read().await;
            sr.get(&session_id).cloned().ok_or_else(|| "不在任何房间中".to_string())?
        };

        // 获取房间信息并验证权限
        let (total_levels, time_per_level_secs, all_player_ids) = {
            let mut rooms = self.rooms.write().await;
            let room = rooms.get_mut(&room_id).ok_or_else(|| "房间不存在".to_string())?;
            
            if room.game != "word_spot" {
                return Err("不是文字找茬房间".to_string());
            }
            // 验证是否是 player1
            let is_host = room.players.iter().any(|p| p.session_id == session_id && p.role == "player1");
            if !is_host {
                return Err("只有房主可以开始游戏".to_string());
            }
            if room.players.is_empty() {
                return Err("至少需要 1 个参战玩家".to_string());
            }
            if room.state == RoomState::Playing {
                return Err("游戏已在进行中".to_string());
            }
            
            // 读取游戏配置
            let cfg = room.game_config.as_ref();
            let total_levels = cfg
                .and_then(|c| c.get("total_levels"))
                .and_then(|v| v.as_u64())
                .unwrap_or(10) as usize;
            let total_levels = total_levels.clamp(1, 30);
            let time_per_level_secs = cfg
                .and_then(|c| c.get("time_per_level_secs"))
                .and_then(|v| v.as_u64())
                .unwrap_or(30);
            let time_per_level_secs = time_per_level_secs.clamp(10, 120);
            
            room.state = RoomState::Playing;
            let all_ids = room.get_all_session_ids();
            (total_levels, time_per_level_secs, all_ids)
        };

        // 生成种子
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let started_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let total_duration_ms = total_levels as u64 * time_per_level_secs * 1000;

        // 构建参战玩家初始进度
        let player_progress: HashMap<usize, PlayerLevelProgress> = {
            let rooms = self.rooms.read().await;
            if let Some(room) = rooms.get(&room_id) {
                room.players.iter().map(|p| {
                    (p.session_id, PlayerLevelProgress {
                        session_id: p.session_id,
                        name: p.name.clone(),
                        current_level: 0,
                        elapsed_ms: 0,
                        finished: false,
                        dropped: false,
                    })
                }).collect()
            } else {
                HashMap::new()
            }
        };

        // 存储本轮状态
        {
            let mut rs_map = self.round_states.write().await;
            rs_map.insert(room_id.clone(), GameRoundState {
                seed,
                difficulty: difficulty.clone(),
                total_levels,
                total_duration_ms,
                started_at_ms,
                players: player_progress,
            });
        }

        // 广播开始消息
        let start_msg = serde_json::json!({
            "type": "game_started",
            "seed": seed,
            "difficulty": difficulty,
            "total_levels": total_levels,
            "total_duration_ms": total_duration_ms,
            "remaining_ms": total_duration_ms,
            "leaderboard": [],
            "reconnect": false
        }).to_string();
        self.broadcast_to_sessions(&all_player_ids, &start_msg).await;

        // 同步广播 room_updated
        {
            let rooms = self.rooms.read().await;
            if let Some(room) = rooms.get(&room_id) {
                let snap = room.clone();
                drop(rooms);
                self.broadcast_room_update(&snap).await;
                self.broadcast_room_list().await;
            }
        }

        // 开启倒计时任务
        let lobby_clone = self.clone();
        let rid_clone = room_id.clone();
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        {
            self.round_cancel_txs.write().await.insert(room_id.clone(), cancel_tx);
        }
        tokio::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(total_duration_ms)) => {
                    lobby_clone.end_round(&rid_clone, "timeout").await;
                }
                _ = cancel_rx => {
                    // 已提前结束
                }
            }
        });

        Ok(())
    }

    /// 结束本轮（超时或所有人完成/弃赛）
    pub async fn end_round(&self, room_id: &str, reason: &str) {
        // 取消倒计时
        if let Some(tx) = self.round_cancel_txs.write().await.remove(room_id) {
            let _ = tx.send(());
        }

        // 取出本轮状态
        let round_state = self.round_states.write().await.remove(room_id);
        let Some(rs) = round_state else { return };

        // 将房间状态改回 Waiting
        let all_ids = {
            let mut rooms = self.rooms.write().await;
            if let Some(room) = rooms.get_mut(room_id) {
                room.state = RoomState::Waiting;
                room.get_all_session_ids()
            } else {
                vec![]
            }
        };

        if all_ids.is_empty() { return; }

        // 构建排行榜（按完成关数降序，同则耐时少者高）
        let mut leaderboard: Vec<&PlayerLevelProgress> = rs.players.values().collect();
        leaderboard.sort_by(|a, b| {
            b.current_level.cmp(&a.current_level)
                .then(a.elapsed_ms.cmp(&b.elapsed_ms))
        });

        // 构建 round_ended payload
        let end_payload = serde_json::json!({
            "type": "round_ended",
            "reason": reason,
            "leaderboard": leaderboard
        });
        let end_msg = end_payload.to_string();

        // 缓存最终榜单，供后来观战/参战者查看
        self.round_final_leaderboards.write().await
            .insert(room_id.to_string(), end_payload);

        // 广播 round_ended
        self.broadcast_to_sessions(&all_ids, &end_msg).await;

        // 同步 room_updated
        let rooms = self.rooms.read().await;
        if let Some(room) = rooms.get(room_id) {
            let snap = room.clone();
            drop(rooms);
            self.broadcast_room_update(&snap).await;
            self.broadcast_room_list().await;
        }
    }

    /// 玩家完成一关
    pub async fn record_level_complete(&self, session_id: usize, level: usize, _client_elapsed_ms: u64) {
        let room_id = {
            let sr = self.session_rooms.read().await;
            match sr.get(&session_id).cloned() {
                Some(id) => id,
                None => return,
            }
        };

        // 服务端计算开局到现在的消耗时间（不信任客户端上报的値）
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let (should_end, leaderboard_snapshot, total_levels) = {
            let mut rs_map = self.round_states.write().await;
            let Some(rs) = rs_map.get_mut(&room_id) else { return };
            
            let total_levels = rs.total_levels;
            let started_at_ms = rs.started_at_ms;
            if let Some(prog) = rs.players.get_mut(&session_id) {
                prog.current_level = level;
                // 使用服务端时间戳计算，避免客户端伪造耐时
                prog.elapsed_ms = now_ms.saturating_sub(started_at_ms);
                if level >= total_levels {
                    prog.finished = true;
                }
            }
            
            let all_done = rs.players.values().all(|p| p.finished || p.dropped);
            let mut lb: Vec<PlayerLevelProgress> = rs.players.values().cloned().collect();
            lb.sort_by(|a, b| {
                b.current_level.cmp(&a.current_level)
                    .then(a.elapsed_ms.cmp(&b.elapsed_ms))
            });
            (all_done, lb, total_levels)
        };

        // 广播排行榜更新
        let all_ids: Vec<usize> = {
            let rooms = self.rooms.read().await;
            rooms.get(&room_id)
                .map(|r| r.get_all_session_ids())
                .unwrap_or_default()
        };
        let lb_msg = serde_json::json!({
            "type": "leaderboard_update",
            "leaderboard": leaderboard_snapshot,
            "total_levels": total_levels
        }).to_string();
        self.broadcast_to_sessions(&all_ids, &lb_msg).await;

        if should_end {
            self.end_round(&room_id, "all_done").await;
        }
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
            let is_word_spot_playing = room.game == "word_spot" && room.state == RoomState::Playing;
            let is_color_lines_playing = room.game == "color_lines" && room.state == RoomState::Playing;
            let was_player = room.players.iter().any(|p| p.session_id == session_id);
            
            room.players.retain(|p| p.session_id != session_id);
            if !room.spectators.contains(&session_id) {
                room.spectators.push(session_id);
            }
            // 文字找茬游戏中切换观战：不改房间状态，视为弃赛处理
            // 超级方块游戏中切换观战：回到等待状态
            if is_color_lines_playing {
                room.state = RoomState::Waiting;
            } else if !is_word_spot_playing && room.state == RoomState::Playing {
                room.state = RoomState::Waiting;
            }
            // 文字找茬/超级方块：重新分配剩余参战玩家角色，保证 player1 始终存在
            if room.game == "word_spot" || room.game == "color_lines" {
                reassign_word_spot_roles(&mut room.players);
            }
            // 清除 IP 房间映射（不再占席位）
            drop(rooms);
            self.ip_rooms.write().await.remove(&ip);
            
            // 文字找茬：游戏中将参战玩家标记为弃赛，并广播排行榜更新
            if is_word_spot_playing && was_player {
                let (should_end, leaderboard_snapshot, total_levels) = {
                    let mut rs_map = self.round_states.write().await;
                    if let Some(rs) = rs_map.get_mut(&room_id) {
                        if let Some(prog) = rs.players.get_mut(&session_id) {
                            prog.dropped = true;
                        }
                        let all_done = rs.players.values().all(|p| p.finished || p.dropped);
                        let mut lb: Vec<PlayerLevelProgress> = rs.players.values().cloned().collect();
                        lb.sort_by(|a, b| {
                            b.current_level.cmp(&a.current_level)
                                .then(a.elapsed_ms.cmp(&b.elapsed_ms))
                        });
                        let total = rs.total_levels;
                        (all_done, Some(lb), total)
                    } else {
                        (false, None, 0)
                    }
                };

                // 广播弃赛后的排行榜更新（含弃赛标记），让所有成员实时看到
                if let Some(lb) = leaderboard_snapshot {
                    let snap_for_lb = {
                        let rooms = self.rooms.read().await;
                        rooms.get(&room_id).map(|r| r.get_all_session_ids()).unwrap_or_default()
                    };
                    let lb_msg = serde_json::json!({
                        "type": "leaderboard_update",
                        "leaderboard": lb,
                        "total_levels": total_levels
                    }).to_string();
                    self.broadcast_to_sessions(&snap_for_lb, &lb_msg).await;
                }

                if should_end {
                    self.end_round(&room_id, "all_done").await;
                }
            }
        } else {
            // 文字找茬/超级方块：游戏进行中不允许申请参战
            if (room.game == "word_spot" || room.game == "color_lines") && room.state == RoomState::Playing {
                drop(rooms);
                return Err("游戏进行中，本轮结束后才可申请参战".to_string());
            }
            if room.is_full() {
                return Err("参战席位已满".to_string());
            }
            room.spectators.retain(|&s| s != session_id);
            let role = Room::assign_role(&room.game, &room.players);
            room.players.push(RoomPlayer { session_id, name: player_name, role, ip: ip.clone(), disconnected: false });

            if room.game != "word_spot" && room.game != "color_lines" && room.players.len() >= room.max_players {
                room.state = RoomState::Playing;
            }
            drop(rooms);
            self.ip_rooms.write().await.insert(ip, room_id.clone());
        }

        let snap = {
            let rooms = self.rooms.read().await;
            rooms.get(&room_id).cloned()
        };
        let mut snap = snap.ok_or_else(|| "房间不存在".to_string())?;
        snap.game_state = self.get_room_game_state(&room_id).await;

        self.broadcast_room_update(&snap).await;
        self.broadcast_room_list().await;
        Ok(snap)
    }

    /// PvP 换位：参战玩家点击空位时，将己方角色换到目标空位（如红/黑）
    pub async fn switch_seat(&self, session_id: usize, target_role: &str) -> Result<Room, String> {
        let room_id = {
            let sr = self.session_rooms.read().await;
            sr.get(&session_id).cloned().ok_or_else(|| "不在任何房间中".to_string())?
        };

        let mut rooms = self.rooms.write().await;
        let room = rooms.get_mut(&room_id).ok_or_else(|| "房间不存在".to_string())?;

        if room.room_type == RoomType::PvAI {
            drop(rooms);
            return Err("人机模式不可换位".to_string());
        }

        if room.game == "word_spot" || room.game == "color_lines" {
            drop(rooms);
            return Err("该游戏席位由服务端自动分配，不支持手动换座".to_string());
        }

        let me = room.players.iter().find(|p| p.session_id == session_id);
        let _me = me.ok_or_else(|| "仅参战玩家可换位".to_string())?;

        let game = room.game.as_str();
        let valid = match game {
            "chess" => target_role == "red" || target_role == "black",
            _ => true,
        };
        if !valid {
            drop(rooms);
            return Err("无效的目标位置".to_string());
        }

        let occupied = room.players.iter().any(|p| p.role == target_role);
        if occupied {
            drop(rooms);
            return Err("该位置已有玩家".to_string());
        }

        for p in room.players.iter_mut() {
            if p.session_id == session_id {
                p.role = target_role.to_string();
                break;
            }
        }

        let mut snap = room.clone();
        drop(rooms);
        snap.game_state = self.get_room_game_state(&room_id).await;
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

    /// 再来一局：重置房间状态，清除投降票，广播 game_restart
    pub async fn restart_game(&self, session_id: usize) -> Option<Room> {
        let room_id = {
            let sr = self.session_rooms.read().await;
            sr.get(&session_id).cloned()?
        };

        // 预检查：获取游戏类型和玩家身份
        let (is_start_game_driven, is_valid) = {
            let rooms = self.rooms.read().await;
            if let Some(room) = rooms.get(&room_id) {
                let is_sgd = room.game == "word_spot" || room.game == "color_lines";
                let valid = if is_sgd {
                    // word_spot/color_lines 仅房主（player1）可重置
                    room.players.iter().any(|p| p.session_id == session_id && p.role == "player1")
                } else {
                    // 其他游戏任意参战玩家可重置
                    room.players.iter().any(|p| p.session_id == session_id)
                };
                (is_sgd, valid)
            } else {
                return None;
            }
        };

        if !is_valid { return None; }

        // word_spot：在获取 rooms 写锁前，先取消倒计时并清理回合状态（避免死锁）
        if is_start_game_driven {
            if let Some(tx) = self.round_cancel_txs.write().await.remove(&room_id) {
                let _ = tx.send(());
            }
            self.round_states.write().await.remove(&room_id);
        }

        let mut rooms = self.rooms.write().await;
        let room = rooms.get_mut(&room_id)?;

        room.surrender_votes.clear();
        // word_spot/color_lines 始终回到 Waiting（房主需重新点击开始）
        // PvAI 模式：始终设为 Playing；PvP 模式：人数满时设为 Playing，否则 Waiting
        if is_start_game_driven {
            room.state = RoomState::Waiting;
        } else if room.room_type == RoomType::PvAI || room.players.len() >= room.max_players {
            room.state = RoomState::Playing;
        } else {
            room.state = RoomState::Waiting;
        }

        self.clear_room_game_state(&room_id).await;
        // 清除最终榜单缓存，开启新一局
        self.round_final_leaderboards.write().await.remove(&room_id);

        let mut snap = room.clone();
        snap.game_state = None;
        let all_ids = snap.get_all_session_ids();
        drop(rooms);

        // 广播 game_restart 给房间所有人（包含观战者）
        let msg = serde_json::json!({
            "type": "game_restart"
        }).to_string();
        self.broadcast_to_sessions(&all_ids, &msg).await;

        // 同步广播 room_updated
        self.broadcast_room_update(&snap).await;
        self.broadcast_room_list().await;

        Some(snap)
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

/// 文字找茬：玩家离开/切换观战后，将剩余参战玩家按当前顺序重编角色
/// 保证 player1 始终是房主（拥有开始/重开权限）
fn reassign_word_spot_roles(players: &mut Vec<RoomPlayer>) {
    for (i, p) in players.iter_mut().enumerate() {
        p.role = format!("player{}", i + 1);
    }
}

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
