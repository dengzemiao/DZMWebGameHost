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
  let pendingGameStarted = null; // 游戏适配器加载前到达的 game_started 消息缓冲

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
    if (room.room_type === 'pv_ai') {
      appendRoomSystem('房间已创建，人机对战模式');
    } else {
      appendRoomSystem('房间已创建，等待玩家加入...');
    }
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
    const prevState = roomData ? roomData.state : null;
    const myPrevRole = roomData && roomData.players ? (roomData.players.find(p => p.session_id === ws.sessionId) || {}).role : null;
    const wasPlayer = isPlayer; // 保存之前的玩家状态
    
    roomData = room;
    applyRoomData(room);

    // 尝试加载游戏（如果之前没有加载成功）
    maybeLoadGame(room);

    // PvP 换位后同步 adapter 角色并重绘
    const myNewRole = room.players && room.players.find(p => p.session_id === ws.sessionId);
    if (gameAdapter && myNewRole && myNewRole.role !== myPrevRole) {
      gameAdapter.role = myNewRole.role;
      if (typeof gameAdapter._render === 'function') gameAdapter._render();
    }

    // 玩家离开或切换观战 → 仅提示对手离开，不重置棋盘（战局由服务端保留）
    // 关键：只在有对战玩家真正离开时才提示（参战人数减少），切换观战不提示
    if (gameAdapter && prevState === 'playing' && room.state === 'waiting') {
      // 判断是否是参战玩家数量减少（真正有人离开，而不是切换观战）
      const prevPlayerCount = roomData.players.length;
      const currPlayerCount = room.players.length;
      
      // 只有参战人数减少时，才提示对手离开
      if (currPlayerCount < prevPlayerCount) {
        console.log('[Room] opponent left (player count decreased):', prevPlayerCount, '->', currPlayerCount);
        if (typeof gameAdapter.onOpponentLeave === 'function') {
          gameAdapter.onOpponentLeave();
        }
      } else {
        console.log('[Room] state changed to waiting but player count unchanged (likely role switch), no notification');
      }
    }

    // 房间状态变为 playing → 启动游戏（特别是第二个玩家加入的情况）
    // 关键：只在状态变化时调用一次 onGameStart，避免重复触发
    if (gameAdapter && room.state === 'playing' && prevState !== 'playing') {
      if (room.game === 'word_spot' || room.game === 'color_lines') {
        // word_spot/color_lines: 游戏开始由 game_started WS 消息驱动，此处不自动触发
        console.log('[Room] room_updated: start_game driven game state changed to playing, waiting for game_started');
      } else {
        console.log('[Room] room_updated: state changed to playing, calling onGameStart');
        gameAdapter.gameStarted = true;
        gameAdapter.onGameStart && gameAdapter.onGameStart(room);
      }
    }
    
    // 身份切换处理：参战 ↔ 观战
    if (gameAdapter && wasPlayer !== isPlayer) {
      console.log('[Room] room_updated: player status changed, wasPlayer:', wasPlayer, 'isPlayer:', isPlayer);
      // 更新 isSpectator 属性（关键！）
      gameAdapter.isSpectator = !isPlayer;
      // 同步 gameAdapter 的 role（观战时 role 设为 spectator）
      if (!isPlayer) {
        gameAdapter.role = 'spectator';
      } else {
        // 恢复为玩家实际角色
        const myNewRole = room.players && room.players.find(p => p.session_id === ws.sessionId);
        if (myNewRole) {
          gameAdapter.role = myNewRole.role;
        }
      }
      // 重新渲染棋盘，更新棋子交互状态
      if (typeof gameAdapter._render === 'function') {
        gameAdapter._render();
      }
    }
  });

  ws.on('game_action', (data) => {
    if (gameAdapter && typeof gameAdapter.onRemoteAction === 'function') {
      gameAdapter.onRemoteAction(data);
    }
  });

  // PvP/PvAI 再来一局：服务端广播，所有客户端重置棋盘并重新开始
  ws.on('game_restart', () => {
    console.log('[Room] game_restart received, isSpectator:', isSpectator, 'hasGameAdapter:', !!gameAdapter);
    $('gameOverModal').classList.remove('show');
    if (gameAdapter && typeof gameAdapter.reset === 'function') {
      gameAdapter.reset();
      if (roomData && (roomData.game === 'word_spot' || roomData.game === 'color_lines')) {
        // word_spot/color_lines: reset 带回等待页，由 player1 手动点击开始游戏
        console.log('[Room] game_restart: start_game driven game reset to waiting');
      } else {
        // 其他游戏：重置并自动开始
        gameAdapter.gameStarted = true;
        if (roomData) roomData.state = 'playing';
        console.log('[Room] game_restart: resetting and calling onGameStart, isSpectator:', isSpectator);
        gameAdapter.onGameStart && gameAdapter.onGameStart(roomData);
      }
    } else {
      console.warn('[Room] game_restart but no gameAdapter or reset method');
    }
  });

  // word_spot 专属消息监听
  ws.on('game_started', (data) => {
    console.log('[Room] game_started received, hasAdapter:', !!gameAdapter);
    if (gameAdapter && typeof gameAdapter.onGameStarted === 'function') {
      gameAdapter.onGameStarted(data);
    } else {
      pendingGameStarted = data;
    }
  });

  ws.on('leaderboard_update', (data) => {
    if (gameAdapter && typeof gameAdapter.onLeaderboardUpdate === 'function') {
      gameAdapter.onLeaderboardUpdate(data);
    }
  });

  ws.on('round_ended', (data) => {
    console.log('[Room] round_ended received');
    if (gameAdapter && typeof gameAdapter.onRoundEnded === 'function') {
      gameAdapter.onRoundEnded(data);
    }
  });

  // 游戏结束处理（统一入口，包含 PvAI 本地触发和 PvP 服务端触发）
  function handleGameOver(data) {
    const myPlayer = roomData && roomData.players.find(p => p.session_id === ws.sessionId);
    const myRole   = myPlayer ? myPlayer.role : null;
    // 使用 gameAdapter 中的 role（PvAI 换边后与服务端 role 可能不同）
    const effectiveRole = (gameAdapter && gameAdapter.role) || myRole;

    // 观战者只接收通知，不弹窗
    if (isSpectator) {
      let resultText = '';
      const gameName = roomData ? roomData.game : '';
      const winnerLabel = getRoleLabel(gameName, data.winner_role) || data.winner_role;
      if (data.reason === 'surrender') {
        resultText = `${winnerLabel}获胜（对方认输）`;
      } else if (data.winner_role) {
        resultText = data.message || `${winnerLabel}获胜`;
      } else {
        resultText = '游戏结束';
      }
      appendRoomSystem(resultText);
      return;
    }

    const modal   = $('gameOverModal');
    const banner  = $('gameOverBanner');
    const title   = $('gameOverTitle');
    const icon    = $('gameOverIcon');
    const msg     = $('gameOverMsg');
    const sub     = $('gameOverSub');

    let result = 'draw'; // 'win' | 'lose' | 'spectate' | 'draw'

    if (data.reason === 'surrender') {
      const iWin = data.winner_role === effectiveRole;
      icon.textContent  = iWin ? '🏆' : '🏳️';
      title.textContent = iWin ? '胜利！' : '认输';
      msg.textContent   = iWin ? '对方已认输，你获得胜利！' : '你选择了认输';
      sub.textContent   = '';
    } else if (data.winner_role) {
      const iWin = data.winner_role === effectiveRole;
      icon.textContent  = iWin ? '🏆' : '😢';
      title.textContent = iWin ? '胜利！' : '失败';
      msg.textContent   = data.message || (iWin ? '恭喜，你赢了！' : '再接再厉！');
      sub.textContent   = data.sub || '';
    } else {
      result = 'draw';
      icon.textContent  = '🤝';
      title.textContent = '游戏结束';
      msg.textContent   = data.message || '游戏已结束';
      sub.textContent   = '';
    }

    banner.className = `game-over-banner ${result}`;

    // 参战者显示"再来一局"按钮
    $('btnRestart').style.display = isPlayer ? '' : 'none';

    modal.classList.add('show');
  }

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
    const maxPlayers = isPvAI ? 2 : (room.max_players || 2);
    const slots = [];
    const diffMap = { easy: '简单', normal: '普通', hard: '困难', hell: '地狱' };

    for (let i = 0; i < maxPlayers; i++) {
      const roleForSlot = getRoleForSeatIndex(room.game, i);
      const p = roleForSlot ? room.players.find(pp => pp.role === roleForSlot) : room.players[i];
      if (p) {
        const isMe = p.session_id === ws.sessionId;
        const roleLabel = getRoleLabel(room.game, p.role);
        const roleClass = getRoleCssClass(room.game, p.role);
        slots.push(`
          <div class="seat filled ${isMe ? 'me' : ''}">
            <div class="seat-avatar">${p.name.charAt(0).toUpperCase()}</div>
            <div class="seat-info">
              <div class="seat-name">${escHtml(p.name)}${isMe ? ' (我)' : ''}</div>
              <div class="seat-role ${roleClass}">${roleLabel}</div>
            </div>
          </div>`);
      } else if (isPvAI && i === 1) {
        // PvAI 模式下第二个席位固定显示 AI，不可点击换边
        const playerRole = room.players[0] && room.players[0].role || getRoleForSeatIndex(room.game, 0);
        const aiRole = getOpponentRole(room.game, playerRole);
        const aiRoleLabel = getRoleLabel(room.game, aiRole);
        const aiRoleClass = getRoleCssClass(room.game, aiRole);
        const diffLabel = diffMap[room.ai_difficulty] || '普通';
        slots.push(`
          <div class="seat filled ai-seat">
            <div class="seat-avatar ai-avatar">🤖</div>
            <div class="seat-info">
              <div class="seat-name">AI（${diffLabel}）</div>
              <div class="seat-role ${aiRoleClass}">${aiRoleLabel}</div>
            </div>
          </div>`);
      } else {
        // PvP 空位：仅在有参战玩家且存在空位时，允许点击换到此位
        // word_spot/color_lines: 席位号即权限顺序，禁止手动换座，由服务端自动分配保证连续性
        const amPlayer = room.players.some(p => p.session_id === ws.sessionId);
        const canSwitchSeat = !isPvAI && amPlayer
          && room.game !== 'word_spot'
          && room.game !== 'color_lines'
          && room.players.length < (room.max_players || 2);
        // roleForSlot 已在外层声明，此处直接使用
        const emptyClickable = canSwitchSeat && roleForSlot ? `
          <div class="seat empty seat-switch" data-role="${roleForSlot}" title="点击换到此位">
            <div class="seat-avatar empty-avatar">?</div>
            <div class="seat-info">
              <div class="seat-name" style="color:var(--text-sec)">空位</div>
              <div class="seat-role">点击换到此位</div>
            </div>
          </div>` : `
          <div class="seat empty">
            <div class="seat-avatar empty-avatar">?</div>
            <div class="seat-info">
              <div class="seat-name" style="color:var(--text-sec)">空位</div>
              <div class="seat-role">等待加入</div>
            </div>
          </div>`;
        slots.push(emptyClickable);
      }
    }
    container.innerHTML = slots.join('');

    // PvP 空位点击 → 换位
    container.querySelectorAll('.seat-switch').forEach(el => {
      el.addEventListener('click', () => {
        const role = el.getAttribute('data-role');
        if (role) ws.send({ type: 'switch_seat', target_role: role });
      });
    });
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

    console.log('[Room] updateActionButtons →', 
      'mySessionId:', mySessionId,
      'amPlayer:', amPlayer,
      'amSpectator:', amSpectator,
      'allow_spectate:', room.allow_spectate,
      'isPvAI:', room.room_type === 'pv_ai',
      'players.length:', room.players.length,
      'state:', room.state,
      'players:', room.players.map(p => ({ session_id: p.session_id, name: p.name, role: p.role })));

    const btnSpectate    = $('btnSpectate');
    const btnParticipate = $('btnParticipate');
    const btnSurrender   = $('btnSurrender');

    const isPvAI = room.room_type === 'pv_ai';
    const isWordSpot = room.game === 'word_spot';
    const isColorLines = room.game === 'color_lines';
    const isStartGameDriven = isWordSpot || isColorLines;

    // word_spot/color_lines: 游戏中不显示认输按钮；申请参战按钮保持可见但在游戏中禁用
    if (isStartGameDriven) {
      btnSpectate.style.display = amPlayer ? '' : 'none';
      if (amSpectator) {
        // 观战者始终显示申请参战按钮，游戏进行中或席位已满时禁用
        btnParticipate.style.display = '';
        btnParticipate.disabled = (room.is_full || room.state === 'playing');
      } else {
        btnParticipate.style.display = 'none';
        btnParticipate.disabled = false;
      }
      btnSurrender.style.display = 'none';
      return;
    }

    // PvAI 模式：只要有玩家加入，就允许切换到观战（用于调试或让位）
    // PvP 模式：正常显示观战/参战切换按钮
    // 关键：PvAI 模式下，即使只有 1 个玩家，也允许切换到观战
    if (amPlayer) {
      btnSpectate.style.display = '';
      console.log('[Room] btnSpectate: showing (amPlayer=true)');
    } else {
      btnSpectate.style.display = 'none';
      console.log('[Room] btnSpectate: hidden (amPlayer=false)');
    }
    
    if (amSpectator && !room.is_full) {
      btnParticipate.style.display = '';
      console.log('[Room] btnParticipate: showing (amSpectator=true, !is_full)');
    } else {
      btnParticipate.style.display = 'none';
      console.log('[Room] btnParticipate: hidden');
    }
    
    // 认输按钮：参战中且游戏进行中时显示（包含 PvAI 模式）
    // PvAI 模式：只要游戏开始了就可以认输（即使只有 1 个玩家）
    // PvP 模式：需要双方都在场且游戏进行中
    if (isPvAI) {
      // PvAI 模式：只要有玩家在且游戏开始了就显示认输按钮
      if (amPlayer && room.state === 'playing') {
        btnSurrender.style.display = '';
        console.log('[Room] btnSurrender: showing (PvAI, amPlayer=true, state=playing)');
      } else {
        btnSurrender.style.display = 'none';
        console.log('[Room] btnSurrender: hidden (PvAI, amPlayer=' + amPlayer + ', state=' + room.state + ')');
      }
    } else {
      // PvP 模式：参战中且游戏进行中
      if (amPlayer && room.state === 'playing') {
        btnSurrender.style.display = '';
        console.log('[Room] btnSurrender: showing (PvP, amPlayer=true, state=playing)');
      } else {
        btnSurrender.style.display = 'none';
        console.log('[Room] btnSurrender: hidden (PvP)');
      }
    }
    
    console.log('[Room] buttons display →',
      'btnSpectate:', btnSpectate.style.display,
      'btnParticipate:', btnParticipate.style.display,
      'btnSurrender:', btnSurrender.style.display);
  }

  function updateWaitingHint(room) {
    const waiting = $('gameWaiting');
    if (!waiting) {
      // 元素不存在（可能已被移除），直接返回
      return;
    }
    // word_spot/color_lines: 等待提示由适配器自行处理
    if (room.game === 'word_spot' || room.game === 'color_lines') {
      waiting.style.display = 'none';
      return;
    }
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
    const map = { easy: '简单难度', normal: '普通难度', hard: '困难难度', hell: '地狱难度' };
    $('aiLevelLabel').textContent = map[room.ai_difficulty] || '普通难度';
  }

  // ── 游戏加载 ──────────────────────────────────────────────────────────────
  function maybeLoadGame(room) {
    console.log('[Room] maybeLoadGame called, room.game:', room.game, 'getGame:', typeof window.getGame);
    const game = window.getGame(room.game);
    if (!game) { 
      console.error('[Room] Game not found in registry:', room.game, 'Available games:', Object.keys(window.GAME_REGISTRY || {}));
      appendRoomSystem(`未找到游戏: ${room.game}`); 
      return; 
    }

    if (gameAdapter) return; // 已加载

    // 检查脚本是否已存在或正在加载，防止重复注入
    if (document.querySelector(`script[data-game="${room.game}"]`)) return;

    console.log('[Room] Loading game:', game.key, 'script:', game.scriptPath);

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
    // 用当前 roomData 初始化，避免对手先加入后 script 才加载导致房主收不到开局
    script.onload = () => initGameAdapter(roomData || room, game);
    script.onerror = () => appendRoomSystem(`游戏脚本加载失败: ${game.scriptPath}`);
    document.body.appendChild(script);
  }

  function initGameAdapter(room, gameMeta) {
    // 支持 snake_case 键名（如 word_spot → WordSpotGameAdapter）
    const adapterName = gameMeta.key
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join('') + 'GameAdapter';
    const AdapterClass = window[adapterName] || window.GameAdapter;

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
    console.log('[Room] initGameAdapter → ws.sessionId:', ws.sessionId,
      'myPlayer:', myPlayer, 'room.state:', room.state,
      'room.room_type:', room.room_type, 'config:', config);

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
    // word_spot: 直接发送任意 WS 消息（如 start_game, restart_game）
    gameAdapter.sendMessage = (data) => {
      ws.send(data);
    };

    gameAdapter.init();

    // 若有服务端下发的当前局战局，先恢复再启动
    if (room.game_state && typeof gameAdapter.restoreGameState === 'function') {
      gameAdapter.restoreGameState(room.game_state);
    }

    if (room.game === 'word_spot' || room.game === 'color_lines') {
      // word_spot/color_lines: onGameStart 仅用于初始化UI，实际开始由 game_started 消息驱动
      gameAdapter.onGameStart && gameAdapter.onGameStart(room);
      // 如果已有缓冲的 game_started 消息，立即应用
      if (pendingGameStarted && typeof gameAdapter.onGameStarted === 'function') {
        const data = pendingGameStarted;
        pendingGameStarted = null;
        setTimeout(() => gameAdapter.onGameStarted(data), 0);
      }
    } else {
      if (room.state === 'playing' || room.room_type === 'pv_ai') {
        gameAdapter.onGameStart && gameAdapter.onGameStart(room);
      }
    }

    appendRoomSystem(`${gameMeta.name} 已加载，${config.isSpectator ? '观战模式' : '你执' + getRoleLabel(room.game, config.role)}`);
  }

  // ── 游戏结束处理 ──────────────────────────────────────────────────────────
  function handleGameOver(data) {
    const myPlayer = roomData && roomData.players.find(p => p.session_id === ws.sessionId);
    const myRole   = myPlayer ? myPlayer.role : null;
    // 使用 gameAdapter 中的 role（PvAI 换边后与服务端 role 可能不同）
    const effectiveRole = (gameAdapter && gameAdapter.role) || myRole;

    // 观战者只接收通知，不弹窗
    if (isSpectator) {
      let resultText = '';
      if (data.reason === 'surrender') {
        resultText = `${data.winner_role === 'red' ? '红方' : '黑方'}获胜（对方认输）`;
      } else if (data.winner_role) {
        resultText = `${data.winner_role === 'red' ? '红方' : '黑方'}获胜`;
      } else {
        resultText = '游戏结束';
      }
      appendRoomSystem(resultText);
      return; // 观战者直接返回，不弹窗
    }

    const modal   = $('gameOverModal');
    const banner  = $('gameOverBanner');
    const title   = $('gameOverTitle');
    const icon    = $('gameOverIcon');
    const msg     = $('gameOverMsg');
    const sub     = $('gameOverSub');

    let result = 'draw'; // 'win' | 'lose' | 'spectate' | 'draw'

    if (data.reason === 'surrender') {
      const iWin = data.winner_role === effectiveRole;
      icon.textContent  = iWin ? '🏆' : '🏳️';
      title.textContent = iWin ? '胜利！' : '认输';
      msg.textContent   = iWin ? '对方已认输，你获得胜利！' : '你选择了认输';
      sub.textContent   = '';
    } else if (data.winner_role) {
      const iWin = data.winner_role === effectiveRole;
      icon.textContent  = iWin ? '🏆' : '😢';
      title.textContent = iWin ? '胜利！' : '失败';
      msg.textContent   = data.message || (iWin ? '恭喜，你赢了！' : '再接再厉！');
      sub.textContent   = data.sub || '';
    } else {
      result = 'draw';
      icon.textContent  = '🤝';
      title.textContent = '游戏结束';
      msg.textContent   = data.message || '游戏已结束';
      sub.textContent   = '';
    }

    banner.className = `game-over-banner ${result}`;

    // 参战者显示"再来一局"按钮
    $('btnRestart').style.display = isPlayer ? '' : 'none';

    modal.classList.add('show');
  }

  // 再来一局：重置棋盘，留在当前房间
  $('btnRestart').addEventListener('click', () => {
    $('gameOverModal').classList.remove('show');

    if (!gameAdapter) return;

    // 统一通过服务端处理重新开局，确保观战者也能收到 game_restart 消息
    // 服务端会广播 game_restart 给房间所有人（包括观战者）
    ws.send({ type: 'restart_game' });
  });

  $('btnBackToLobby').addEventListener('click', () => {
    $('gameOverModal').classList.remove('show');
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
    if (game === 'gomoku' || game === 'go') {
      return role === 'black' ? '黑方' : role === 'white' ? '白方' : role;
    }
    if (game === 'word_spot' || game === 'color_lines') {
      if (role === 'player1') return '1号位(房主)';
      const n = role && role.match(/^player(\d+)$/);
      return n ? `${n[1]}号位` : (role || '观战');
    }
    return role;
  }

  /** 指定席位索引对应的角色（用于 PvP 空位换位），无则返回 null */
  function getRoleForSeatIndex(game, index) {
    if (game === 'chess') return index === 0 ? 'red' : index === 1 ? 'black' : null;
    if (game === 'gomoku' || game === 'go') return index === 0 ? 'black' : index === 1 ? 'white' : null;
    if (game === 'word_spot' || game === 'color_lines') return `player${index + 1}`;
    return null;
  }

  /** 获取对手角色（PvAI 模式下 AI 的角色） */
  function getOpponentRole(game, playerRole) {
    if (game === 'chess') return playerRole === 'red' ? 'black' : 'red';
    if (game === 'gomoku' || game === 'go') return playerRole === 'black' ? 'white' : 'black';
    return null;
  }

  /** 获取角色的 CSS 类名 */
  function getRoleCssClass(game, role) {
    if (game === 'chess') return role === 'red' ? 'red' : 'black';
    if (game === 'gomoku' || game === 'go') return role === 'black' ? 'black' : 'white';
    if (game === 'word_spot' || game === 'color_lines') return role === 'player1' ? 'host' : 'player';
    return role;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── 页面离开处理（浏览器前进/后退/关闭） ───────────────────────────────────
  let isLeavingPage = false;

  function handlePageLeave() {
    if (isLeavingPage) return;
    isLeavingPage = true;
    
    // 尝试通过 WebSocket 发送离开房间消息
    if (currentRoomId && ws && ws.ws && ws.ws.readyState === WebSocket.OPEN) {
      ws.send({ type: 'leave_room' });
    }
  }

  // pagehide：页面被隐藏时触发（包括导航离开、浏览器前进/后退）
  window.addEventListener('pagehide', (event) => {
    // persisted 为 true 表示页面可能被 bfcache 缓存，仍需发送离开消息
    handlePageLeave();
  });

  // beforeunload：页面即将卸载时触发
  window.addEventListener('beforeunload', () => {
    handlePageLeave();
  });

  // pageshow：页面显示时触发（包括从 bfcache 恢复）
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      // 从 bfcache 恢复，重置状态并重新加入房间
      isLeavingPage = false;
      hasJoined = false;
      
      if (ws && ws.ws && ws.ws.readyState === WebSocket.OPEN) {
        // WebSocket 连接还在，直接重新加入房间
        enterRoom();
      } else {
        // WebSocket 已断开，触发重连（重连成功后会触发 welcome，然后自动加入房间）
        ws.connect();
      }
    }
  });

})();
