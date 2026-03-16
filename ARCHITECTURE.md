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
│   ├─ main.js                         # Vue 入口
│   ├─ App.vue                         # 根组件，挂载 ServerControl
│   └─ components/
│       └─ ServerControl.vue           # 控制面板：启动/停止、IP显示、在线人数、打开数据目录
│
├─ src-tauri/                          # Rust 后端
│   ├─ tauri.conf.json                 # Tauri 配置（identifier: com.dengzemiao.webgamehost）
│   ├─ Cargo.toml                      # Rust 依赖（axum, rusqlite, tokio, tower-http, local-ip-address）
│   ├─ capabilities/
│   │   └─ default.json                # 权限配置
│   └─ src/
│       ├─ main.rs                     # 入口，调用 lib::run()
│       ├─ lib.rs                      # Tauri 命令注册 + setup（7个命令）
│       ├─ state.rs                    # AppState 全局状态（server_handle, online_count, port, data_dir）
│       │
│       ├─ server/                     # 内嵌 Web 服务器
│       │   ├─ mod.rs                  # start()/stop() 入口，管理 ServerInstance
│       │   ├─ http.rs                 # axum 路由：/api/status, /api/players, fallback 静态文件
│       │   ├─ websocket.rs            # /ws 处理：连接、消息收发、断开
│       │   └─ lobby.rs                # 在线玩家管理、广播、DB 交互
│       │
│       ├─ database/                   # 数据层
│       │   ├─ mod.rs                  # init() 初始化数据目录和数据库
│       │   └─ sqlite.rs              # SQLite 建表、find_or_create_player(ip)、随机中文昵称生成
│       │
│       └─ network/
│           └─ ip.rs                   # 获取局域网 IP（local-ip-address crate）
│
└─ game-pages/                         # 玩家浏览器访问的页面（axum 静态文件服务）
    ├─ index.html                      # 游戏大厅
    ├─ css/style.css                   # 大厅样式
    ├─ js/lobby.js                     # WebSocket 连接、聊天、状态管理
    └─ games/example-game/index.html   # 示例游戏占位页
```

## Tauri 命令（lib.rs → Vue invoke 调用）

| 命令 | 功能 |
|------|------|
| `start_server` | 启动 axum 服务器，返回访问地址 |
| `stop_server` | 广播 server_stopping → 关闭服务器 |
| `get_server_status` | 返回 { running, online_count, address, port, local_ip } |
| `get_local_ip` | 获取局域网 IP |
| `set_port` | 修改端口（服务未运行时） |
| `open_data_dir` | 打开数据存储目录 |
| `get_online_count` | 获取在线人数 |

## 数据存储

- **位置**：Tauri `app_data_dir`（macOS: `~/Library/Application Support/com.dengzemiao.webgamehost/`）
- **数据库**：`game.db`（SQLite，bundled 编译，免安装）
- **表结构**：players（id, name, ip_address UNIQUE, connected_at, last_active）、game_records、server_config
- **玩家识别**：按 IP 唯一识别，首次连接自动生成随机中文昵称（如"霸气剑客42"），再次连接复用

## WebSocket 消息协议

| 类型 | 方向 | 字段 |
|------|------|------|
| `welcome` | 服务端→客户端 | player_id, session_id, name, online_count |
| `player_count` | 服务端→广播 | count |
| `chat` | 双向 | session_id, name, content |
| `set_name` | 客户端→服务端 | name |
| `server_stopping` | 服务端→广播 | （客户端收到后停止重连） |

## 关键配置

- 默认端口：`39527`（state.rs + ServerControl.vue）
- 开发模式 game-pages 路径：`CARGO_MANIFEST_DIR/../game-pages`
- 生产模式 game-pages 路径：`resource_dir/game-pages`（tauri.conf.json resources 打包）
