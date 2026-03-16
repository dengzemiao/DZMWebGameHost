/**
 * room.js — 通用房间外壳逻辑
 * 不包含任何游戏逻辑，通过 GameAdapter 标准接口驱动具体游戏
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // ── URL 参数 ───────────────────────────────────────────────────────────────
  const params     = new URLSearchParams(location.search);
  const ACTION     = params.get('action');   // 'create' 或 null
  const ROOM_ID    = params.get('id');       // 加入时的房间ID
  const AS_SPEC    = params.get('spectator') === '1';

  // 必须有 action=create 或 id=xxx
  if (!ACTION && !ROOM_ID) { location.href = 'index.html'; return; }

  // 创建房间时，从 sessionStorage 读取配置
  const pendingCreate = ACTION === 'create'
    ? JSON.parse(sessionStorage.getItem('pendingCreateRoom') || 'null')
    : null;

  if (ACTION === 'create' && !pendingCreate) {
    location.href = 'index.html';
    return;
  }

  // ── 状态 ──────────────────────────────────────────────────────────────────
  let roomData    = null;   // 当前房间完整数据
  let currentRoomId = ROOM_ID || null;
  let gameAdapter = null;   // 游戏适配器实例
  let isSpectator = false;
  let isPlayer    = false;
  let hasJoined   = false;  // 避免重复加入

  const ws = window.wsClient;

  // ── 入房操作（在 welcome 后调用） ─────────────────────────────────────────
  function enterRoom() {
    if (currentRoomId) {
      // 已有房间ID：无论是首次加入还是断线重连，都发 join_room
      // 服务端会通过 IP 识别是否是席位恢复（断线重连）
      ws.send({ type: 'join_room', room_id: currentRoomId, as_spectator: AS_SPEC });
    } else if (ACTION === 'create' && pendingCreate) {
      // 首次创建：发 create_room，服务端返回 room_created 后 currentRoomId 会被设置
      sessionStorage.removeItem('pendingCreateRoom');
      ws.send({ type: 'create_room', ...pendingCreate });
    }
  }

  // ── WebSocket 事件绑定 ────────────────────────────────────────────────────
  ws.on('connected', () => {
    $('statusDot').classList.add('connected');
    $('statusPill').classList.add('connected');
    $('statusText').textContent = '已连接';
  });

  ws.on('disconnected', () => {
    $('statusDot').classList.remove('connected');
    $('statusPill').classList.remove('connected');
    $('statusText').textContent = ws.serverStopped ? '服务已停止' : '重连中...';
    hasJoined = false;
  });

  // welcome 是新连接后服务端第一条消息，在此发起入房请求
  ws.on('welcome', () => {
    if (!hasJoined) {
      hasJoined = true;
      enterRoom();
    }
  });

  // 创建房间成功 → 记录房间ID，后续重连用 join_room
  ws.on('room_created', (room) => {
    currentRoomId = room.id;
    // 更新 URL，后续重连/刷新时直接用 ?id=xxx 加入
    history.replaceState(null, '', `room.html?id=${room.id}`);
    roomData = room;
    applyRoomData(room);
    appendRoomSystem(`房间已创建，等待玩家加入...`);
    maybeLoadGame(room);
  });

  ws.on('room_joined', (room) => {
    currentRoomId = room.id;
    roomData = room;
    applyRoomData(room);
    appendRoomSystem(`已加入房间`);
    maybeLoadGame(room);
  });

  ws.on('room_closed', () => {
    appendRoomSystem('房间已关闭，将返回大厅...');
    setTimeout(() => location.href = 'index.html', 2000);
  });

  ws.on('room_error', (msg) => {
    appendRoomSystem(`错误：${msg}`);
    if (msg === '房间不存在' || msg.includes('不存在')) {
      setTimeout(() => location.href = 'index.html', 2000);
    }
  });

  ws.on('room_chat', (data) => {
    if (data.system) {
      appendRoomSystem(data.content);
    } else {
      appendRoomChatMsg(data.session_id, data.name, data.content);
    }
  });

  ws.on('room_updated', (room) => {
    roomData = room;
    applyRoomData(room);
    if (gameAdapter && room.state === 'playing') {
      gameAdapter.onGameStart && gameAdapter.onGameStart(room);
    }
  });

  ws.on('game_action', (data) => {
    if (gameAdapter && typeof gameAdapter.onRemoteAction === 'function') {
      gameAdapter.onRemoteAction(data);
    }
  });

  ws.on('game_over', (data) => {
    handleGameOver(data);
  });

  ws.on('server_stopping', () => {
    appendRoomSystem('服务已停止。');
  });

  // 发起连接，welcome 收到后会调用 enterRoom()
  ws.connect();

  // ── 渲染房间信息 ──────────────────────────────────────────────────────────
  function applyRoomData(room) {
    const game = window.getGame(room.game) || { name: room.game, icon: '🎮' };

    $('roomGameIcon').textContent = game.icon;
    $('roomName').textContent = room.name;
    $('roomIdLabel').textContent = room.id;

    const typeLabel = room.room_type === 'pv_ai' ? '人机对战' : '玩家对战';
    $('roomTypeLabel').textContent = typeLabel;

    const stateEl = $('roomStateBadge');
    stateEl.textContent = room.state === 'playing' ? '对战中' : '等待中';
    stateEl.className = `room-state-badge ${room.state === 'playing' ? 'playing' : 'waiting'}`;

    document.title = `${room.name} — 游戏大厅`;

    renderSeats(room);
    renderSpectators(room);
    updateActionButtons(room);
    updateWaitingHint(room);
    renderAiInfo(room);
  }

  function renderSeats(room) {
    const container = $('playerSeats');
    const isPvAI = room.room_type === 'pv_ai';
    const maxPlayers = isPvAI ? 2 : (room.max_players || 2); // PvAI 始终展示2个席位
    const slots = [];
    const diffMap = { easy: '简单', normal: '普通', hard: '困难' };

    for (let i = 0; i < maxPlayers; i++) {
      const p = room.players[i];
      if (p) {
        const isMe = p.session_id === ws.sessionId;
        const roleLabel = getRoleLabel(room.game, p.role);
        const roleClass = p.role === 'red' ? 'red' : p.role === 'black' ? 'black' : '';
        slots.push(`
          <div class="seat filled ${isMe ? 'me' : ''}">
            <div class="seat-avatar">${p.name.charAt(0).toUpperCase()}</div>
            <div class="seat-info">
              <div class="seat-name">${escHtml(p.name)}${isMe ? ' (我)' : ''}</div>
              <div class="seat-role ${roleClass}">${roleLabel}</div>
            </div>
          </div>`);
      } else if (isPvAI && i === 1) {
        // PvAI 模式下第二个席位固定显示 AI
        // 优先从 gameAdapter.role 读取当前玩家角色（swapRole 后保持同步）
        const playerRole = (gameAdapter && gameAdapter.role) || (room.players[0] && room.players[0].role) || 'red';
        const aiRole = playerRole === 'red' ? 'black' : 'red';
        const aiRoleLabel = getRoleLabel(room.game, aiRole);
        const aiRoleClass = aiRole === 'red' ? 'red' : 'black';
        const diffLabel = diffMap[room.ai_difficulty] || '普通';
        slots.push(`
          <div class="seat filled ai-seat" id="aiSeatCard" title="点击切换执棋方" style="cursor:pointer;">
            <div class="seat-avatar ai-avatar">🤖</div>
            <div class="seat-info">
              <div class="seat-name">AI（${diffLabel}）</div>
              <div class="seat-role ${aiRoleClass}">${aiRoleLabel} · 点击换边</div>
            </div>
          </div>`);
      } else {
        slots.push(`
          <div class="seat empty">
            <div class="seat-avatar empty-avatar">?</div>
            <div class="seat-info">
              <div class="seat-name" style="color:var(--text-sec)">空位</div>
              <div class="seat-role">等待加入</div>
            </div>
          </div>`);
      }
    }
    container.innerHTML = slots.join('');

    // 绑定 AI 席位点击 → 切换角色
    const aiCard = $('aiSeatCard');
    if (aiCard) {
      aiCard.addEventListener('click', () => {
        if (gameAdapter && typeof gameAdapter.swapRole === 'function') {
          gameAdapter.swapRole();
          // 重新渲染席位以反映新角色
          if (roomData) renderSeats(roomData);
        }
      });
    }
  }

  function renderSpectators(room) {
    const section = $('spectatorSection');
    const list    = $('spectatorList');
    const countEl = $('spectatorCount');

    if (!room.allow_spectate || room.spectators.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    countEl.textContent = room.spectators.length;
    list.innerHTML = room.spectators.map(sid => {
      const isMe = sid === ws.sessionId;
      return `<div class="spectator-item">
        <div class="spec-avatar">${isMe ? '我' : '👁'}</div>
        <span>${isMe ? '我（观战中）' : '观战者'}</span>
      </div>`;
    }).join('');
  }

  function updateActionButtons(room) {
    const mySessionId = ws.sessionId;
    const amPlayer    = room.players.some(p => p.session_id === mySessionId);
    const amSpectator = room.spectators.includes(mySessionId);

    isPlayer    = amPlayer;
    isSpectator = amSpectator;

    const btnSpectate    = $('btnSpectate');
    const btnParticipate = $('btnParticipate');
    const btnSurrender   = $('btnSurrender');

    const isPvAI = room.room_type === 'pv_ai';

    // PvAI 模式下：没有观战/参战切换（单人对机），直接隐藏这两个按钮
    btnSpectate.style.display = (!isPvAI && amPlayer && room.allow_spectate) ? '' : 'none';
    btnParticipate.style.display = (!isPvAI && amSpectator && !room.is_full) ? '' : 'none';
    // 认输按钮：参战中且游戏进行中时显示（PvAI 模式游戏已在前端启动，不依赖 state）
    btnSurrender.style.display = (amPlayer && (room.state === 'playing' || isPvAI)) ? '' : 'none';
  }

  function updateWaitingHint(room) {
    const waiting = $('gameWaiting');
    if (room.state === 'playing' || (room.room_type === 'pv_ai' && room.players.length >= 1)) {
      waiting.style.display = 'none';
      return;
    }
    const need = (room.max_players || 2) - room.players.length;
    $('waitingNeed').textContent = need;
    waiting.style.display = 'flex';
  }

  function renderAiInfo(room) {
    const aiInfo = $('aiInfo');
    if (room.room_type !== 'pv_ai') {
      aiInfo.style.display = 'none';
      return;
    }
    aiInfo.style.display = 'flex';
    const map = { easy: '简单难度', normal: '普通难度', hard: '困难难度' };
    $('aiLevelLabel').textContent = map[room.ai_difficulty] || '普通难度';
  }

  // ── 游戏加载 ──────────────────────────────────────────────────────────────
  function maybeLoadGame(room) {
    const game = window.getGame(room.game);
    if (!game) { appendRoomSystem(`未找到游戏: ${room.game}`); return; }

    if (gameAdapter) return; // 已加载

    // 动态注入 CSS
    if (game.cssPath && !document.querySelector(`link[data-game="${room.game}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = game.cssPath;
      link.dataset.game = room.game;
      document.head.appendChild(link);
    }

    // 动态注入 JS
    const script = document.createElement('script');
    script.src = game.scriptPath;
    script.dataset.game = room.game;
    script.onload = () => initGameAdapter(room, game);
    script.onerror = () => appendRoomSystem(`游戏脚本加载失败: ${game.scriptPath}`);
    document.body.appendChild(script);
  }

  function initGameAdapter(room, gameMeta) {
    const AdapterClass = window[`${gameMeta.key.charAt(0).toUpperCase()}${gameMeta.key.slice(1)}GameAdapter`]
      || window.GameAdapter;

    if (typeof AdapterClass !== 'function') {
      appendRoomSystem(`GameAdapter 未找到，请检查 ${gameMeta.scriptPath}`);
      return;
    }

    const myPlayer = room.players.find(p => p.session_id === ws.sessionId);
    const config = {
      role:          myPlayer ? myPlayer.role : 'spectator',
      roomType:      room.room_type,
      aiDifficulty:  room.ai_difficulty || 'normal',
      mySessionId:   ws.sessionId,
      isSpectator:   !myPlayer,
    };

    const container = $('gameContainer');
    // 移除等待占位
    const waiting = $('gameWaiting');
    if (waiting) waiting.remove();

    gameAdapter = new AdapterClass(container, config);

    // 注入两个回调：游戏内部调用
    gameAdapter.sendAction = (data) => {
      ws.send({ type: 'game_action', ...data });
    };
    gameAdapter.notifyGameOver = (result) => {
      // PvAI 模式在前端本地触发游戏结束
      handleGameOver(result);
    };

    gameAdapter.init();

    // 若已是 playing 状态，直接启动
    if (room.state === 'playing' || room.room_type === 'pv_ai') {
      gameAdapter.onGameStart && gameAdapter.onGameStart(room);
    }

    appendRoomSystem(`${gameMeta.name} 已加载，${config.isSpectator ? '观战模式' : '你执' + getRoleLabel(room.game, config.role)}`);
  }

  // ── 游戏结束处理 ──────────────────────────────────────────────────────────
  function handleGameOver(data) {
    const modal    = $('gameOverModal');
    const title    = $('gameOverTitle');
    const icon     = $('gameOverIcon');
    const msg      = $('gameOverMsg');
    const sub      = $('gameOverSub');

    const myPlayer = roomData && roomData.players.find(p => p.session_id === ws.sessionId);
    const myRole   = myPlayer ? myPlayer.role : null;

    if (data.reason === 'surrender') {
      const iWin = data.winner_role === myRole;
      title.textContent = iWin ? '胜利！' : '游戏结束';
      icon.textContent  = iWin ? '🏆' : '🏳️';
      msg.textContent   = iWin ? '对方已认输，你获得胜利！' : '你已认输。';
      sub.textContent   = '感谢游玩！';
    } else if (data.winner_role) {
      const iWin = data.winner_role === myRole;
      title.textContent = iWin ? '胜利！' : (isSpectator ? '游戏结束' : '失败');
      icon.textContent  = iWin ? '🏆' : (isSpectator ? '🎭' : '😢');
      msg.textContent   = data.message || (iWin ? '恭喜，你赢了！' : '再接再厉！');
      sub.textContent   = data.sub || '';
    } else {
      title.textContent = '游戏结束';
      icon.textContent  = '🎭';
      msg.textContent   = data.message || '游戏已结束';
      sub.textContent   = '';
    }

    modal.classList.add('show');
  }

  $('btnBackToLobby').addEventListener('click', () => {
    ws.send({ type: 'leave_room' });
    location.href = 'index.html';
  });

  // ── 操作按钮 ──────────────────────────────────────────────────────────────
  $('btnBack').addEventListener('click', () => {
    ws.send({ type: 'leave_room' });
    location.href = 'index.html';
  });

  $('btnSpectate').addEventListener('click', () => {
    ws.send({ type: 'switch_role', to_spectator: true });
  });

  $('btnParticipate').addEventListener('click', () => {
    ws.send({ type: 'switch_role', to_spectator: false });
  });

  $('btnSurrender').addEventListener('click', () => {
    $('surrenderModal').classList.add('show');
  });
  $('btnCancelSurrender').addEventListener('click', () => {
    $('surrenderModal').classList.remove('show');
  });
  $('btnConfirmSurrender').addEventListener('click', () => {
    $('surrenderModal').classList.remove('show');
    ws.send({ type: 'surrender' });
  });

  // ── 房间聊天 ──────────────────────────────────────────────────────────────
  const roomChatInput = $('roomChatInput');
  const roomSendBtn   = $('roomSendBtn');

  roomSendBtn.addEventListener('click', sendRoomChat);
  roomChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) sendRoomChat();
  });

  function sendRoomChat() {
    const text = roomChatInput.value.trim();
    if (!text) return;
    ws.send({ type: 'room_chat', content: text });
    roomChatInput.value = '';
  }

  function appendRoomChatMsg(sessionId, name, content) {
    const div = document.createElement('div');
    div.className = 'room-chat-msg';
    const isMe = sessionId === ws.sessionId;
    div.innerHTML = `<span class="msg-name ${isMe ? 'me' : ''}">${escHtml(name)}${isMe ? '(我)' : ''}</span>${escHtml(content)}`;
    appendToChat(div);
  }

  function appendRoomSystem(text) {
    const div = document.createElement('div');
    div.className = 'room-chat-msg system';
    div.textContent = text;
    appendToChat(div);
  }

  function appendToChat(el) {
    const box = $('roomChatBox');
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }

  // ── 工具函数 ──────────────────────────────────────────────────────────────
  function getRoleLabel(game, role) {
    if (game === 'chess') {
      return role === 'red' ? '红方' : role === 'black' ? '黑方' : role;
    }
    return role;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

})();
