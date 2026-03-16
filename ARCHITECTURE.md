# DZMWebGameHost 项目架构

## 概述

Tauri 2 桌面客户端，内嵌 axum HTTP/WebSocket 服务器。用户启动服务后，同局域网设备通过浏览器访问 IP 进入游戏大厅。

**技术栈**：Tauri 2 + Vue 3 + Vite | Rust (axum + rusqlite + tokio)

## 核心流程

客户端启动服务 → axum 监听 `0.0.0.0:{port}` → 玩家浏览器访问 → HTTP 提供游戏页面 → WebSocket 实时通讯 → SQLite 持久化玩家数据

## 项目结构

```
DZMWebGameHost
│
├─ src/                                # Tauri 控制面板前端 (Vue 3)
│   ├─ main.js
│   ├─ App.vue
│   └─ components/
│       └─ ServerControl.vue           # 控制面板：启动/停止、IP显示、在线人数
│
├─ src-tauri/                          # Rust 后端
│   ├─ tauri.conf.json
│   ├─ Cargo.toml
│   └─ src/
│       ├─ lib.rs                      # Tauri 命令注册（7个命令）
│       ├─ state.rs                    # AppState
│       ├─ server/
│       │   ├─ mod.rs                  # start()/stop()
│       │   ├─ http.rs                 # axum 路由
│       │   ├─ websocket.rs            # WebSocket 消息处理（含房间消息）
│       │   └─ lobby.rs                # 玩家+房间内存管理
│       ├─ database/
│       │   ├─ mod.rs
│       │   └─ sqlite.rs               # 玩家持久化、随机昵称
│       └─ network/
│           └─ ip.rs
│
└─ game-pages/                         # 玩家浏览器页面（axum 静态服务）
    ├─ index.html                      # 游戏大厅（高端深色主题）
    ├─ room.html                       # 通用房间外壳
    ├─ css/
    │   ├─ lobby.css                   # 大厅样式
    │   └─ room.css                    # 房间样式
    ├─ js/
    │   ├─ ws-client.js                # WebSocket 客户端单例
    │   ├─ game-registry.js            # 游戏注册表（新增游戏只改此文件）
    │   ├─ lobby.js                    # 大厅逻辑（房间列表、创建、聊天）
    │   └─ room.js                     # 通用房间逻辑（不含游戏代码）
    └─ games/
        └─ chess/                      # 中国象棋（自治）
            ├─ game.js                 # ChessGameAdapter + ChessRules
            ├─ ai.js                   # AI（Minimax + Alpha-Beta，三档难度）
            └─ game.css
```

## 游戏插件化架构

### 核心原则

新增游戏只需：1）创建 `games/xxx/` 目录；2）在 `game-registry.js` 加一行。其余代码零改动。

### GameAdapter 标准接口

每款游戏的 `game.js` 必须暴露一个类并实现以下接口：

```js
class XxxGameAdapter {
  constructor(container, config)
  // config: { role, roomType, aiDifficulty, mySessionId, isSpectator }
  init()                    // 初始化渲染
  onGameStart(roomData)     // 游戏开始
  onRemoteAction(data)      // 收到对手操作（PvP）
  onOpponentLeave()         // 对手离开
  // 以下两个由 room.js 注入：
  // sendAction(data)       // 发送 game_action 给对手
  // notifyGameOver(result) // 通知游戏结束
}
```

## 房间系统

### 内存数据结构（lobby.rs）

```rust
Room {
  id: String,              // 6位随机ID（大写字母+数字）
  name: String,
  game: String,            // "chess" 等，与 GAME_REGISTRY key 对应
  max_players: usize,
  room_type: RoomType,     // Pvp | PvAI
  ai_difficulty: Option<AiDifficulty>,  // Easy | Normal | Hard
  allow_spectate: bool,
  state: RoomState,        // Waiting | Playing
  players: Vec<RoomPlayer>,
  spectators: Vec<usize>,
  surrender_votes: Vec<usize>,
}
```

### 房间规则

- 所有人离开 → 房间自动销毁
- 玩家位置满 → 状态自动变为 Playing
- 参战玩家离开 → 状态回退为 Waiting
- 双人游戏：任意一方认输即结束
- PvAI 模式：AI 逻辑在前端运行，服务端不参与计算

## WebSocket 消息协议

### 基础消息

| 类型 | 方向 | 字段 |
|------|------|------|
| `welcome` | 服→客 | player_id, session_id, name, online_count |
| `player_count` | 服→广播 | count |
| `chat` | 双向 | session_id, name, content |
| `set_name` | 客→服 | name |
| `server_stopping` | 服→广播 | — |

### 房间消息

| 类型 | 方向 | 字段 |
|------|------|------|
| `get_rooms` | 客→服 | — |
| `room_list` | 服→客 | rooms[] |
| `room_list_update` | 服→全播 | rooms[] |
| `create_room` | 客→服 | name, game, max_players, room_type, ai_difficulty, allow_spectate |
| `room_created` | 服→客 | room |
| `join_room` | 客→服 | room_id, as_spectator |
| `room_joined` | 服→客 | room |
| `leave_room` | 客→服 | — |
| `room_updated` | 服→房间广播 | room |
| `room_closed` | 服→房间 | room_id |
| `room_error` | 服→客 | message |
| `switch_role` | 客→服 | to_spectator |
| `surrender` | 客→服 | — |
| `game_action` | 双向转发 | action + 游戏数据（不透明） |
| `room_chat` | 双向 | content, name, system |
| `game_over` | 服→房间 | winner_role, reason |

## 关键配置

- 默认端口：`39527`
- 开发模式 game-pages 路径：`CARGO_MANIFEST_DIR/../game-pages`
- 生产模式 game-pages 路径：`resource_dir/game-pages`
