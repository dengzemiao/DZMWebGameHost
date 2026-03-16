use axum::{extract::State, response::Json, routing::get, Router};
use std::sync::atomic::Ordering;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

use super::lobby::Lobby;
use super::websocket::ws_handler;

pub fn create_router(lobby: Lobby, game_pages_dir: String) -> Router {
    let api_routes = Router::new()
        .route("/api/status", get(api_status))
        .route("/api/players", get(api_players))
        .with_state(lobby.clone());

    let ws_route = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(lobby);

    Router::new()
        .merge(api_routes)
        .merge(ws_route)
        .fallback_service(ServeDir::new(game_pages_dir))
        .layer(CorsLayer::permissive())
}

async fn api_status(
    State(lobby): State<Lobby>,
) -> Json<serde_json::Value> {
    let count = lobby.online_count.load(Ordering::Relaxed);
    Json(serde_json::json!({
        "online_count": count,
        "status": "running"
    }))
}

async fn api_players(
    State(lobby): State<Lobby>,
) -> Json<serde_json::Value> {
    let players = lobby.get_player_list().await;
    Json(serde_json::json!({
        "players": players
    }))
}
