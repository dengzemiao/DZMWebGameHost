use axum::{
    extract::{
        ws::{Message, WebSocket},
        ConnectInfo, State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::lobby::{AiDifficulty, Lobby, RoomType};

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(lobby): State<Lobby>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, lobby, addr))
}

async fn handle_socket(socket: WebSocket, lobby: Lobby, addr: SocketAddr) {
    let (sender, mut receiver) = socket.split();
    let sender = Arc::new(Mutex::new(sender));

    let ip = addr.ip().to_string();
    let player = lobby.player_join(ip.clone()).await;
    let session_id = player.session_id;

    // 发送欢迎消息
    let welcome = serde_json::json!({
        "type": "welcome",
        "player_id": player.id,
        "session_id": session_id,
        "name": player.name,
        "online_count": lobby.online_count.load(std::sync::atomic::Ordering::Relaxed)
    });
    {
        let mut s = sender.lock().await;
        let _ = s.send(Message::Text(welcome.to_string().into())).await;
    }

    // 发送当前房间列表
    let rooms = lobby.get_room_list().await;
    let room_list_msg = serde_json::json!({
        "type": "room_list",
        "rooms": rooms
    });
    {
        let mut s = sender.lock().await;
        let _ = s.send(Message::Text(room_list_msg.to_string().into())).await;
    }

    // 订阅广播频道
    let mut broadcast_rx = lobby.broadcast_tx.subscribe();

    // 发送任务：监听广播频道，过滤定向消息后下发
    let sender_clone = sender.clone();
    let mut send_task = tokio::spawn(async move {
        while let Ok(raw) = broadcast_rx.recv().await {
            // 判断是否为定向消息（含 _targets 字段）
            let msg_to_send = if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(targets) = v.get("_targets") {
                    // 定向消息：检查当前 session_id 是否在目标列表中
                    let in_targets = targets
                        .as_array()
                        .map(|arr| arr.iter().any(|t| t.as_u64() == Some(session_id as u64)))
                        .unwrap_or(false);
                    if !in_targets {
                        continue;
                    }
                    // 提取真实 payload
                    v.get("_payload")
                        .and_then(|p| p.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or(raw)
                } else {
                    raw
                }
            } else {
                raw
            };

            let mut s = sender_clone.lock().await;
            if s.send(Message::Text(msg_to_send.into())).await.is_err() {
                break;
            }
        }
    });

    // 接收任务：处理客户端消息（需要 ip 信息传给房间操作）
    let lobby_clone = lobby.clone();
    let ip_clone = ip.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                        handle_message(&lobby_clone, session_id, ip_clone.clone(), parsed).await;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    };

    lobby.player_leave(session_id).await;
}

async fn handle_message(lobby: &Lobby, session_id: usize, ip: String, msg: serde_json::Value) {
    let msg_type = msg.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match msg_type {
        // ── 聊天（大厅公共） ──────────────────────────────────────────────────
        "chat" => {
            let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
            let name = get_player_name(lobby, session_id).await;
            let broadcast_msg = serde_json::json!({
                "type": "chat",
                "session_id": session_id,
                "name": name,
                "content": content
            });
            let _ = lobby.broadcast_tx.send(broadcast_msg.to_string());
        }

        // ── 修改昵称 ──────────────────────────────────────────────────────────
        "set_name" => {
            let name = msg.get("name").and_then(|n| n.as_str()).unwrap_or("玩家");
            lobby.update_player_name(session_id, name).await;
        }

        // ── 获取房间列表 ──────────────────────────────────────────────────────
        "get_rooms" => {
            let rooms = lobby.get_room_list().await;
            let resp = serde_json::json!({
                "type": "room_list",
                "rooms": rooms
            }).to_string();
            lobby.broadcast_to_sessions(&[session_id], &resp).await;
        }

        // ── 创建房间 ──────────────────────────────────────────────────────────
        "create_room" => {
            let name = msg.get("name").and_then(|v| v.as_str()).unwrap_or("新房间").to_string();
            let game = msg.get("game").and_then(|v| v.as_str()).unwrap_or("chess").to_string();
            let max_players = msg.get("max_players").and_then(|v| v.as_u64()).unwrap_or(2) as usize;
            let room_type = parse_room_type(msg.get("room_type").and_then(|v| v.as_str()));
            let ai_difficulty = parse_ai_difficulty(msg.get("ai_difficulty").and_then(|v| v.as_str()));
            let allow_spectate = msg.get("allow_spectate").and_then(|v| v.as_bool()).unwrap_or(true);

            match lobby.create_room(session_id, ip.clone(), name, game, max_players, room_type, ai_difficulty, allow_spectate).await {
                Ok(room) => {
                    let resp = serde_json::json!({
                        "type": "room_created",
                        "room": room
                    }).to_string();
                    lobby.broadcast_to_sessions(&[session_id], &resp).await;
                }
                Err(e) => send_error(lobby, session_id, &e).await,
            }
        }

        // ── 加入房间 ──────────────────────────────────────────────────────────
        "join_room" => {
            let room_id = match msg.get("room_id").and_then(|v| v.as_str()) {
                Some(id) => id.to_string(),
                None => { send_error(lobby, session_id, "缺少 room_id").await; return; }
            };
            let as_spectator = msg.get("as_spectator").and_then(|v| v.as_bool()).unwrap_or(false);

            match lobby.join_room(session_id, ip.clone(), &room_id, as_spectator).await {
                Ok(room) => {
                    let resp = serde_json::json!({
                        "type": "room_joined",
                        "room": room
                    }).to_string();
                    lobby.broadcast_to_sessions(&[session_id], &resp).await;

                    // 通知房间内其他在线成员
                    let name = get_player_name(lobby, session_id).await;
                    let notice = serde_json::json!({
                        "type": "room_chat",
                        "system": true,
                        "content": format!("{}加入了房间", name)
                    }).to_string();
                    lobby.broadcast_to_room(&room_id, &notice).await;
                }
                Err(e) => send_error(lobby, session_id, &e).await,
            }
        }

        // ── 离开房间 ──────────────────────────────────────────────────────────
        "leave_room" => {
            // 先广播离开通知给房间成员
            let room_id = {
                let sr = lobby.session_rooms.read().await;
                sr.get(&session_id).cloned()
            };
            if let Some(rid) = room_id {
                let name = get_player_name(lobby, session_id).await;
                let notice = serde_json::json!({
                    "type": "room_chat",
                    "system": true,
                    "content": format!("{}离开了房间", name)
                }).to_string();
                lobby.broadcast_to_room(&rid, &notice).await;
            }
            lobby.leave_room(session_id).await;
        }

        // ── 切换观战/参战 ─────────────────────────────────────────────────────
        "switch_role" => {
            let to_spectator = msg.get("to_spectator").and_then(|v| v.as_bool()).unwrap_or(true);
            match lobby.switch_role(session_id, ip.clone(), to_spectator).await {
                Ok(room) => {
                    let name = get_player_name(lobby, session_id).await;
                    let action = if to_spectator { "切换为观战" } else { "切换为参战" };
                    let notice = serde_json::json!({
                        "type": "room_chat",
                        "system": true,
                        "content": format!("{}{}", name, action)
                    }).to_string();
                    lobby.broadcast_to_room(&room.id, &notice).await;
                }
                Err(e) => send_error(lobby, session_id, &e).await,
            }
        }

        // ── 认输 ──────────────────────────────────────────────────────────────
        "surrender" => {
            lobby.vote_surrender(session_id).await;
        }

        // ── 游戏动作（转发给同房间其他成员） ─────────────────────────────────
        "game_action" => {
            let room_id = {
                let sr = lobby.session_rooms.read().await;
                sr.get(&session_id).cloned()
            };
            if let Some(rid) = room_id {
                let mut payload = msg.clone();
                if let Some(obj) = payload.as_object_mut() {
                    obj.insert("from_session".to_string(), serde_json::json!(session_id));
                }
                // 转发给同房间其他成员（不含自己）
                let targets: Vec<usize> = {
                    let rooms = lobby.rooms.read().await;
                    rooms.get(&rid)
                        .map(|r| r.get_all_session_ids().into_iter().filter(|&s| s != session_id).collect())
                        .unwrap_or_default()
                };
                lobby.broadcast_to_sessions(&targets, &payload.to_string()).await;
            }
        }

        // ── 房间内聊天 ────────────────────────────────────────────────────────
        "room_chat" => {
            let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
            let name = get_player_name(lobby, session_id).await;
            let room_id = {
                let sr = lobby.session_rooms.read().await;
                sr.get(&session_id).cloned()
            };
            if let Some(rid) = room_id {
                let broadcast_msg = serde_json::json!({
                    "type": "room_chat",
                    "session_id": session_id,
                    "name": name,
                    "content": content,
                    "system": false
                }).to_string();
                lobby.broadcast_to_room(&rid, &broadcast_msg).await;
            }
        }

        // ── 未知消息 ──────────────────────────────────────────────────────────
        _ => {
            eprintln!("[WS] Unknown message type: {}", msg_type);
        }
    }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

async fn get_player_name(lobby: &Lobby, session_id: usize) -> String {
    lobby.players.read().await
        .get(&session_id)
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "未知".to_string())
}

async fn send_error(lobby: &Lobby, session_id: usize, message: &str) {
    let msg = serde_json::json!({
        "type": "room_error",
        "message": message
    }).to_string();
    lobby.broadcast_to_sessions(&[session_id], &msg).await;
}

fn parse_room_type(s: Option<&str>) -> RoomType {
    match s {
        Some("pv_ai") | Some("pvai") => RoomType::PvAI,
        _ => RoomType::Pvp,
    }
}

fn parse_ai_difficulty(s: Option<&str>) -> Option<AiDifficulty> {
    match s {
        Some("easy") => Some(AiDifficulty::Easy),
        Some("normal") => Some(AiDifficulty::Normal),
        Some("hard") => Some(AiDifficulty::Hard),
        _ => None,
    }
}
