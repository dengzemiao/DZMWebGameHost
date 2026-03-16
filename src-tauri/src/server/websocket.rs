use axum::{
    extract::{
        ws::{Message, WebSocket},
        ConnectInfo, State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;

use super::lobby::Lobby;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(lobby): State<Lobby>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, lobby, addr))
}

async fn handle_socket(socket: WebSocket, lobby: Lobby, addr: SocketAddr) {
    let (mut sender, mut receiver) = socket.split();

    let ip = addr.ip().to_string();
    let player = lobby.player_join(ip).await;
    let session_id = player.session_id;

    let welcome = serde_json::json!({
        "type": "welcome",
        "player_id": player.id,
        "session_id": session_id,
        "name": player.name,
        "online_count": lobby.online_count.load(std::sync::atomic::Ordering::Relaxed)
    });
    let _ = sender.send(Message::Text(welcome.to_string().into())).await;

    let mut broadcast_rx = lobby.broadcast_tx.subscribe();

    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = broadcast_rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let lobby_clone = lobby.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                        handle_message(&lobby_clone, session_id, parsed).await;
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

async fn handle_message(lobby: &Lobby, session_id: usize, msg: serde_json::Value) {
    let msg_type = msg.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match msg_type {
        "chat" => {
            let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
            let players = lobby.players.read().await;
            let name = players
                .get(&session_id)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| "未知".to_string());
            drop(players);

            let broadcast_msg = serde_json::json!({
                "type": "chat",
                "session_id": session_id,
                "name": name,
                "content": content
            });
            let _ = lobby.broadcast_tx.send(broadcast_msg.to_string());
        }
        "set_name" => {
            let name = msg
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("玩家");
            lobby.update_player_name(session_id, name).await;
        }
        _ => {
            let _ = lobby.broadcast_tx.send(msg.to_string());
        }
    }
}
