(function () {
  'use strict';

  // ── DOM 引用 ─────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const statusDot     = $('statusDot');
  const statusText    = $('statusText');
  const statusPill    = $('statusPill');
  const onlineCount   = $('onlineCount');
  const playerAvatar  = $('playerAvatar');
  const playerNameDisplay = $('playerNameDisplay');
  const roomList      = $('roomList');
  const roomCountBadge = $('roomCountBadge');
  const roomSearch    = $('roomSearch');
  const chatBox       = $('chatBox');
  const chatInput     = $('chatInput');
  const sendBtn       = $('sendBtn');

  // ── 状态 ─────────────────────────────────────────────────────────────────
  let rooms = [];
  let pendingRoomId = null;   // 创建房间时生成的 ID
  let selectedGame  = 'chess';

  const ws = window.wsClient;

  // ── WebSocket 事件绑定 ────────────────────────────────────────────────────
  ws.on('connected', () => {
    statusDot.classList.add('connected');
    statusPill.classList.add('connected');
    statusText.textContent = '已连接';
  });

  ws.on('disconnected', () => {
    statusDot.classList.remove('connected');
    statusPill.classList.remove('connected');
    statusText.textContent = ws.serverStopped ? '服务已停止' : '重连中...';
  });

  ws.on('welcome', (data) => {
    onlineCount.textContent = data.online_count;
    updatePlayerDisplay(data.name);
    appendSystemMsg(`欢迎回来，${data.name}！`);
    
    // 回到大厅时，确保离开之前的房间（处理浏览器前进/后退导航的情况）
    ws.send({ type: 'leave_room' });
  });

  ws.on('player_count', (count) => {
    onlineCount.textContent = count;
  });

  ws.on('chat', (data) => {
    appendChatMsg(data.session_id, data.name, data.content);
  });

  ws.on('room_list', (list) => {
    rooms = list || [];
    renderRoomList();
  });

  ws.on('room_list_update', (list) => {
    rooms = list || [];
    renderRoomList();
  });

  ws.on('room_error', (msg) => {
    showToast(msg, 'error');
  });

  ws.on('server_stopping', () => {
    statusText.textContent = '服务已停止';
    appendSystemMsg('服务已停止，请联系主机重新开启。');
  });

  ws.connect();

  // ── 房间列表渲染 ──────────────────────────────────────────────────────────
  function renderRoomList() {
    const keyword = roomSearch.value.trim().toUpperCase();
    const filtered = keyword
      ? rooms.filter(r => r.id.toUpperCase().includes(keyword) || r.name.includes(keyword))
      : rooms;

    roomCountBadge.textContent = rooms.length;

    if (filtered.length === 0) {
      roomList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">${keyword ? '🔍' : '🏜️'}</div>
          <p>${keyword ? '未找到匹配的房间' : '暂无房间，快来创建第一个吧！'}</p>
        </div>`;
      return;
    }

    roomList.innerHTML = filtered.map(room => buildRoomCard(room)).join('');

    // 绑定按钮事件
    roomList.querySelectorAll('.room-join-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = btn.closest('.room-card');
        const rid = card.dataset.roomId;
        const asSpectator = btn.dataset.spectator === '1';
        joinRoom(rid, asSpectator);
      });
    });

    roomList.querySelectorAll('.room-card').forEach(card => {
      card.addEventListener('click', () => {
        const rid = card.dataset.roomId;
        const room = rooms.find(r => r.id === rid);
        if (!room) return;
        if (room.state === 'playing' && room.allow_spectate) {
          joinRoom(rid, true);
        } else if (room.player_count < room.max_players) {
          joinRoom(rid, false);
        }
      });
    });
  }

  function buildRoomCard(room) {
    const game = window.getGame(room.game) || { name: room.game, icon: '🎮' };
    const isPlaying = room.state === 'playing';
    const isFull = room.player_count >= room.max_players;
    const stateLabel = isPlaying ? '对战中' : '等待中';
    const stateClass = isPlaying ? 'playing' : 'waiting';
    const cardClass = isPlaying ? 'playing' : '';

    const roomTypeLabel = room.room_type === 'pv_ai' ? '人机对战' : '玩家对战';
    const roomTypeIcon  = room.room_type === 'pv_ai' ? '🤖' : '⚔️';

    let diffLabel = '';
    if (room.room_type === 'pv_ai' && room.ai_difficulty) {
      const map = { easy: '简单', normal: '普通', hard: '困难' };
      diffLabel = `<span class="room-meta-item"><span class="meta-icon">🧠</span>${map[room.ai_difficulty] || ''}</span>`;
    }

    // 席位槽
    const slots = Array.from({ length: room.max_players }, (_, i) => {
      const filled = i < room.player_count;
      return `<div class="slot ${filled ? 'filled' : 'empty'}">${filled ? '●' : '○'}</div>`;
    }).join('');

    // 操作按钮
    let joinBtn = '';
    if (!isFull && !isPlaying) {
      joinBtn = `<button class="room-join-btn join" data-spectator="0">加入</button>`;
    } else if (room.allow_spectate) {
      joinBtn = `<button class="room-join-btn spectate" data-spectator="1">观战</button>`;
    }

    return `
    <div class="room-card ${cardClass}" data-room-id="${room.id}">
      <div class="room-card-top">
        <div>
          <div class="room-card-name">${escHtml(room.name)}</div>
          <div class="room-card-id">ID: ${room.id}</div>
        </div>
        <span class="room-state-badge ${stateClass}">${stateLabel}</span>
      </div>
      <div class="room-card-meta">
        <span class="room-meta-item"><span class="meta-icon">${game.icon}</span>${game.name}</span>
        <span class="room-meta-item"><span class="meta-icon">${roomTypeIcon}</span>${roomTypeLabel}</span>
        ${diffLabel}
        ${room.allow_spectate ? `<span class="room-meta-item"><span class="meta-icon">👁️</span>可观战</span>` : ''}
        ${room.spectator_count > 0 ? `<span class="room-meta-item"><span class="meta-icon">👥</span>观战 ${room.spectator_count}</span>` : ''}
      </div>
      <div class="room-card-footer">
        <div class="player-slots">${slots}</div>
        ${joinBtn}
      </div>
    </div>`;
  }

  function joinRoom(roomId, asSpectator) {
    // 大厅不发 WS 消息，直接跳转，由 room.js 在建立新连接后发 join_room
    // 避免页面跳转断开 WS 时触发 leave_room 销毁房间
    const spectator = asSpectator ? '1' : '0';
    location.href = `room.html?id=${roomId}&spectator=${spectator}`;
  }

  // ── 搜索过滤 ──────────────────────────────────────────────────────────────
  roomSearch.addEventListener('input', () => renderRoomList());

  // ── 创建房间弹窗 ──────────────────────────────────────────────────────────
  const createModal   = $('createRoomModal');
  const editNameModal = $('editNameModal');

  function openModal(modal) { modal.classList.add('show'); }
  function closeModal(modal) { modal.classList.remove('show'); }

  $('btnCreateRoom').addEventListener('click', () => {
    initCreateModal();
    openModal(createModal);
  });
  $('btnCloseModal').addEventListener('click', () => closeModal(createModal));
  $('btnCancelCreate').addEventListener('click', () => closeModal(createModal));
  createModal.addEventListener('click', (e) => { if (e.target === createModal) closeModal(createModal); });

  function initCreateModal() {
    pendingRoomId = generateRoomId();
    $('newRoomId').textContent = pendingRoomId;
    $('roomNameInput').value = generateRoomName();
    buildGameSelectGrid();
    // 重置房间类型到 pvp
    setRadioActive('roomTypeGroup', 'pvp');
    setRadioActive('aiDifficultyGroup', 'normal');
    $('aiDifficultyRow').style.display = 'none';
    // 重置 word_spot 配置
    $('wsMaxPlayers').value = 8;  $('wsMaxPlayersVal').textContent = '8 人';
    $('wsTotalLevels').value = 10; $('wsTotalLevelsVal').textContent = '10 关';
    $('wsTimePer').value = 30;    $('wsTimePerVal').textContent = '30 秒';
    const isWordSpot = selectedGame === 'word_spot';
    ['wordSpotRow', 'wordSpotLevelRow', 'wordSpotTimeRow'].forEach(id => {
      $(id).style.display = isWordSpot ? '' : 'none';
    });
  }

  $('btnRandomName').addEventListener('click', () => {
    $('roomNameInput').value = generateRoomName();
  });
  $('btnRandomId').addEventListener('click', () => {
    pendingRoomId = generateRoomId();
    $('newRoomId').textContent = pendingRoomId;
  });

  // 游戏选择网格
  function buildGameSelectGrid() {
    const grid = $('gameSelectGrid');
    const games = window.getAllGames();
    grid.innerHTML = games.map(g => `
      <div class="game-select-item ${g.key === selectedGame ? 'selected' : ''}" data-key="${g.key}">
        <span class="game-icon">${g.icon}</span>
        <span class="game-name">${g.name}</span>
      </div>`).join('');

    grid.querySelectorAll('.game-select-item').forEach(item => {
      item.addEventListener('click', () => {
        selectedGame = item.dataset.key;
        grid.querySelectorAll('.game-select-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        // 根据游戏是否支持 AI 调整房间类型选项
        const game = window.getGame(selectedGame);
        const pvaiItem = document.querySelector('#roomTypeGroup [data-value="pv_ai"]');
        if (pvaiItem) pvaiItem.style.display = game && game.supportsAI ? '' : 'none';
        // word_spot 专属配置行显隐
        const isWordSpot = selectedGame === 'word_spot';
        ['wordSpotRow', 'wordSpotLevelRow', 'wordSpotTimeRow'].forEach(id => {
          $(id).style.display = isWordSpot ? '' : 'none';
        });
      });
    });
  }

  // 房间类型单选
  $('roomTypeGroup').addEventListener('click', (e) => {
    const item = e.target.closest('.radio-item');
    if (!item) return;
    setRadioActive('roomTypeGroup', item.dataset.value);
    const isPvAI = item.dataset.value === 'pv_ai';
    $('aiDifficultyRow').style.display = isPvAI ? '' : 'none';
  });

  // AI 难度单选
  $('aiDifficultyGroup').addEventListener('click', (e) => {
    const item = e.target.closest('.radio-item');
    if (!item) return;
    setRadioActive('aiDifficultyGroup', item.dataset.value);
  });

  function setRadioActive(groupId, value) {
    document.querySelectorAll(`#${groupId} .radio-item`).forEach(item => {
      item.classList.toggle('active', item.dataset.value === value);
    });
  }

  function getRadioValue(groupId) {
    const active = document.querySelector(`#${groupId} .radio-item.active`);
    return active ? active.dataset.value : null;
  }

  // 确认创建：将配置存入 sessionStorage，跳转到 room.html?action=create
  // room.html 连接 WS 后再发 create_room，避免跳转时 WS 断开销毁房间
  // word_spot 滑块实时更新显示
  $('wsMaxPlayers').addEventListener('input', () => {
    $('wsMaxPlayersVal').textContent = $('wsMaxPlayers').value + ' 人';
  });
  $('wsTotalLevels').addEventListener('input', () => {
    $('wsTotalLevelsVal').textContent = $('wsTotalLevels').value + ' 关';
  });
  $('wsTimePer').addEventListener('input', () => {
    $('wsTimePerVal').textContent = $('wsTimePer').value + ' 秒';
  });

  $('btnConfirmCreate').addEventListener('click', () => {
    const name = $('roomNameInput').value.trim() || generateRoomName();
    const isWordSpot = selectedGame === 'word_spot';
    const roomType = isWordSpot ? 'pvp' : (getRadioValue('roomTypeGroup') || 'pvp');
    const aiDifficulty = roomType === 'pv_ai' ? (getRadioValue('aiDifficultyGroup') || 'normal') : null;
    const allowSpectate = $('allowSpectate').checked;
    const game = window.getGame(selectedGame) || window.getAllGames()[0];

    const game_config = isWordSpot ? {
      total_levels: parseInt($('wsTotalLevels').value, 10),
      time_per_level_secs: parseInt($('wsTimePer').value, 10),
    } : null;

    const config = {
      name,
      game: selectedGame,
      max_players: isWordSpot ? parseInt($('wsMaxPlayers').value, 10) : (roomType === 'pv_ai' ? 1 : game.maxPlayers),
      room_type: roomType,
      ai_difficulty: aiDifficulty,
      allow_spectate: allowSpectate,
      game_config,
    };

    sessionStorage.setItem('pendingCreateRoom', JSON.stringify(config));
    closeModal(createModal);
    location.href = 'room.html?action=create';
  });

  // ── 修改昵称弹窗 ──────────────────────────────────────────────────────────
  $('btnEditName').addEventListener('click', () => {
    $('newNameInput').value = ws.playerName || '';
    openModal(editNameModal);
    setTimeout(() => $('newNameInput').focus(), 100);
  });
  $('btnCloseNameModal').addEventListener('click', () => closeModal(editNameModal));
  $('btnCancelName').addEventListener('click', () => closeModal(editNameModal));
  editNameModal.addEventListener('click', (e) => { if (e.target === editNameModal) closeModal(editNameModal); });

  $('btnConfirmName').addEventListener('click', confirmNameChange);
  $('newNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmNameChange(); });

  function confirmNameChange() {
    const name = $('newNameInput').value.trim();
    if (!name) return;
    ws.send({ type: 'set_name', name });
    ws.playerName = name;
    updatePlayerDisplay(name);
    closeModal(editNameModal);
  }

  // ── 聊天 ──────────────────────────────────────────────────────────────────
  sendBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) sendChat(); });

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    ws.send({ type: 'chat', content: text });
    chatInput.value = '';
  }

  function appendChatMsg(sessionId, name, content) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    const isMe = sessionId === ws.sessionId;
    div.innerHTML = `<span class="msg-name ${isMe ? 'me' : ''}">${escHtml(name)}${isMe ? '(我)' : ''}</span>${escHtml(content)}`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function appendSystemMsg(text) {
    const div = document.createElement('div');
    div.className = 'chat-msg system';
    div.textContent = text;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  // ── 工具函数 ──────────────────────────────────────────────────────────────
  function updatePlayerDisplay(name) {
    playerNameDisplay.textContent = name;
    playerAvatar.textContent = name ? name.charAt(0).toUpperCase() : '?';
  }

  function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
  }

  const ROOM_ADJ = ['威武', '霸气', '神秘', '热血', '传奇', '无敌', '荣耀', '王者', '至尊', '巅峰'];
  const ROOM_NOUN = ['擂台', '战场', '棋局', '决战', '对决', '之间', '殿堂', '竞技场', '江湖', '战场'];
  function generateRoomName() {
    const adj = ROOM_ADJ[Math.floor(Math.random() * ROOM_ADJ.length)];
    const noun = ROOM_NOUN[Math.floor(Math.random() * ROOM_NOUN.length)];
    return adj + noun;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
      background:${type === 'error' ? '#f85149' : '#3fb950'};
      color:#fff; padding:10px 20px; border-radius:8px;
      font-size:14px; font-weight:600; z-index:9999;
      box-shadow:0 4px 12px rgba(0,0,0,.4);
      animation: fadeInUp .2s ease;
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ── 页面导航处理（浏览器前进/后退） ─────────────────────────────────────
  
  // pageshow：页面显示时触发（包括从 bfcache 恢复）
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      // 从 bfcache 恢复（比如从房间页面点击后退回到大厅，或从外部网页点击前进回到大厅）
      // 确保离开之前可能存在的房间
      if (ws && ws.ws && ws.ws.readyState === WebSocket.OPEN) {
        ws.send({ type: 'leave_room' });
      } else {
        // WebSocket 已断开，触发重连（重连成功后会触发 welcome，其中已有 leave_room 调用）
        ws.connect();
      }
    }
  });

})();
