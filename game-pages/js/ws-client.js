class GameWSClient {
  constructor() {
    this.ws = null;
    this.playerId = null;
    this.onlineCount = 0;
    this.listeners = {};
    this.reconnectTimer = null;
  }

  connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("[WS] Connected");
      this._emit("connected");

      const playerName = localStorage.getItem("playerName") || "Player";
      this.send({ type: "set_name", name: playerName });
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this._handleMessage(data);
      } catch (e) {
        console.error("[WS] Parse error:", e);
      }
    };

    this.ws.onclose = () => {
      console.log("[WS] Disconnected");
      this._emit("disconnected");
      this._scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error("[WS] Error:", err);
    };
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  _emit(event, data) {
    const callbacks = this.listeners[event] || [];
    callbacks.forEach((cb) => cb(data));
  }

  _handleMessage(data) {
    switch (data.type) {
      case "welcome":
        this.playerId = data.player_id;
        this.onlineCount = data.online_count;
        this._emit("welcome", data);
        break;
      case "player_count":
        this.onlineCount = data.count;
        this._emit("player_count", data.count);
        break;
      case "chat":
        this._emit("chat", data);
        break;
      default:
        this._emit("message", data);
        break;
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

window.GameWSClient = GameWSClient;
