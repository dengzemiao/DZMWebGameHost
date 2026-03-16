/**
 * GameWSClient — 统一 WebSocket 客户端
 * 负责连接管理、消息分发、重连逻辑
 * 上层业务（lobby.js / room.js）通过 .on(event, cb) 监听感兴趣的消息类型
 */
class GameWSClient {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.playerId = null;
    this.playerName = '';
    this.onlineCount = 0;
    this.listeners = {};
    this.reconnectTimer = null;
    this.serverStopped = false;
    this._reconnectDelay = 3000;
  }

  // ── 连接管理 ───────────────────────────────────────────────────────────────

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/ws`);

    this.ws.onopen = () => {
      this._reconnectDelay = 3000;
      this._emit('connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this._handleMessage(data);
      } catch (e) {
        console.error('[WS] Parse error:', e);
      }
    };

    this.ws.onclose = () => {
      this._emit('disconnected');
      if (!this.serverStopped) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.ws && this.ws.close();
    };
  }

  disconnect() {
    this.serverStopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  // ── 事件监听 ───────────────────────────────────────────────────────────────

  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
    return this;
  }

  off(event, callback) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
  }

  // ── 消息分发 ───────────────────────────────────────────────────────────────

  _handleMessage(data) {
    switch (data.type) {
      case 'welcome':
        this.sessionId = data.session_id;
        this.playerId = data.player_id;
        this.playerName = data.name;
        this.onlineCount = data.online_count;
        this._emit('welcome', data);
        break;

      case 'player_count':
        this.onlineCount = data.count;
        this._emit('player_count', data.count);
        break;

      case 'chat':
        this._emit('chat', data);
        break;

      // ── 房间列表 ────────────────────────────────────────────────────────────
      case 'room_list':
        this._emit('room_list', data.rooms);
        break;

      case 'room_list_update':
        this._emit('room_list_update', data.rooms);
        break;

      // ── 房间操作响应 ────────────────────────────────────────────────────────
      case 'room_created':
        this._emit('room_created', data.room);
        break;

      case 'room_joined':
        this._emit('room_joined', data.room);
        break;

      case 'room_updated':
        this._emit('room_updated', data.room);
        break;

      case 'room_closed':
        this._emit('room_closed', data);
        break;

      case 'room_error':
        this._emit('room_error', data.message);
        break;

      // ── 游戏相关 ────────────────────────────────────────────────────────────
      case 'game_start':
        this._emit('game_start', data);
        break;

      case 'game_action':
        this._emit('game_action', data);
        break;

      case 'game_over':
        this._emit('game_over', data);
        break;

      case 'room_chat':
        this._emit('room_chat', data);
        break;

      // ── 服务端停止 ──────────────────────────────────────────────────────────
      case 'server_stopping':
        this.serverStopped = true;
        this._emit('server_stopping');
        if (this.ws) this.ws.close();
        break;

      default:
        this._emit('message', data);
        break;
    }
  }

  _emit(event, data) {
    (this.listeners[event] || []).forEach(cb => cb(data));
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 15000);
      this.connect();
    }, this._reconnectDelay);
  }
}

window.GameWSClient = GameWSClient;
// 每次页面加载创建新实例（页面跳转时旧 WS 已断开，需要全新的连接和监听器）
window.wsClient = new GameWSClient();
