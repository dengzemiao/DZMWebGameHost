(function () {
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const onlineCount = document.getElementById("onlineCount");
  const chatBox = document.getElementById("chatBox");
  const chatInput = document.getElementById("chatInput");
  const nameInput = document.getElementById("nameInput");
  const sendBtn = document.getElementById("sendBtn");

  let ws = null;
  let mySessionId = null;
  let myName = "";
  let reconnectTimer = null;
  let serverStopped = false;

  function getWsUrl() {
    const loc = window.location;
    const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
    return protocol + "//" + loc.host + "/ws";
  }

  function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    ws = new WebSocket(getWsUrl());

    ws.onopen = function () {
      statusDot.classList.add("connected");
      statusText.textContent = "已连接";
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    ws.onmessage = function (event) {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (e) {
        console.error("Failed to parse message:", e);
      }
    };

    ws.onclose = function () {
      statusDot.classList.remove("connected");
      if (serverStopped) {
        statusText.textContent = "服务已停止";
      } else {
        statusText.textContent = "已断开，重连中...";
        scheduleReconnect();
      }
    };

    ws.onerror = function () {
      ws.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, 3000);
  }

  function handleMessage(data) {
    switch (data.type) {
      case "welcome":
        mySessionId = data.session_id;
        myName = data.name;
        onlineCount.textContent = data.online_count;
        nameInput.value = myName;
        appendSystemMsg("已加入大厅，你的昵称: " + myName);
        break;

      case "player_count":
        onlineCount.textContent = data.count;
        break;

      case "chat":
        appendChatMsg(data.session_id, data.name, data.content);
        break;

      case "server_stopping":
        serverStopped = true;
        appendSystemMsg("服务已停止，请联系主机重新开启。");
        statusDot.classList.remove("connected");
        statusText.textContent = "服务已停止";
        if (ws) ws.close();
        break;

      default:
        break;
    }
  }

  function appendSystemMsg(text) {
    const div = document.createElement("div");
    div.className = "msg system";
    div.textContent = text;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function appendChatMsg(sessionId, name, content) {
    const div = document.createElement("div");
    div.className = "msg";

    const nameSpan = document.createElement("span");
    nameSpan.className = "name";
    const isMe = sessionId === mySessionId;
    nameSpan.textContent = (isMe ? name + "(我)" : name) + ": ";

    div.appendChild(nameSpan);
    div.appendChild(document.createTextNode(content));
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "chat", content: text }));
    chatInput.value = "";
  }

  sendBtn.addEventListener("click", sendChat);
  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") sendChat();
  });

  nameInput.addEventListener("change", function () {
    const name = nameInput.value.trim();
    if (name && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_name", name: name }));
      myName = name;
    }
  });

  connect();
})();
