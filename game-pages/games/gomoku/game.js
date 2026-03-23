/**
 * gomoku/game.js — 五子棋 GameAdapter 实现
 *
 * 实现 GameAdapter 标准接口：
 *   constructor(container, config)
 *   init()
 *   onGameStart(roomData)
 *   onRemoteAction(data)
 *   onOpponentLeave()
 *   sendAction(data)       ← 由 room.js 注入
 *   notifyGameOver(result) ← 由 room.js 注入
 *
 * 角色：
 *   'black'     — 黑方（先手）
 *   'white'     — 白方（后手）
 *   'spectator' — 观战
 */

class GomokuGameAdapter {
  constructor(container, config) {
    this.container   = container;
    this.config      = config;
    // config: { role, roomType, aiDifficulty, mySessionId, isSpectator }
    this.role        = config.role;         // 'black' | 'white' | 'spectator'
    this.roomType    = config.roomType;     // 'pvp' | 'pv_ai'
    this.difficulty  = config.aiDifficulty || 'normal';
    this.isSpectator = config.isSpectator;

    // 棋盘规格
    this.SIZE = 15;                         // 15×15 路

    // 棋盘状态
    this.board       = null;                // SIZE×SIZE, null | { color }
    this.currentTurn = 'black';             // 黑方先手
    this.moveCount   = 0;
    this.gameStarted = false;
    this.gameOver    = false;
    this.lastMove    = null;                // { r, c }
    this.winLine     = null;                // 获胜五子坐标 [{ r, c }, ...]

    // DOM 引用
    this.canvas      = null;
    this.piecesLayer = null;
    this.effectsLayer = null;

    // 棋盘尺寸（动态计算）
    this.CELL    = 36;   // 格子像素（默认，会动态更新）
    this.PADDING = 22;   // 棋盘内边距（默认，会动态更新）
    this.MIN_CELL = 20;
    this.MAX_CELL = 52;

    this._resizeHandler = null;
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────
  init() {
    this.board = this._createInitialBoard();
    this._buildDOM();
    this._render();

    this._resizeHandler = this._debounce(() => this._handleResize(), 150);
    window.addEventListener('resize', this._resizeHandler);

    console.log('[Gomoku] init → role:', this.role, 'roomType:', this.roomType,
      'isSpectator:', this.isSpectator);
  }

  _debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  _handleResize() {
    if (!this.container) return;
    this._calcBoardSize();
    this._rebuildBoard();
  }

  // 动态计算棋盘尺寸（正方形，根据容器窄边自适应）
  _calcBoardSize() {
    const N = this.SIZE - 1;  // 14 格（15 交叉点）
    // 实际渲染宽 = CELL*(N + 2*0.65 + 2*0.65) = CELL*(N+2.6)
    // 原因：canvas 内部 PADDING (CELL*0.65) + CSS board-inner padding (CELL*0.65) = 每侧 CELL*1.3
    const PADDING_RATIO = 0.65;  // PADDING = CELL * PADDING_RATIO
    const TOTAL_DIV = N + PADDING_RATIO * 4;  // N + 2.6 = 16.6

    const rect = this.container.getBoundingClientRect();
    const statusH = 50;
    const margin  = 16;
    let availW = rect.width  - margin * 2;
    let availH = rect.height - statusH - margin * 2;

    if (availW <= 0 || availH <= 0) {
      availW = window.innerWidth  - margin * 2;
      availH = window.innerHeight - statusH - margin * 2;
    }

    // 正方形：取窄边，细分除以实际渲染总宽对应的系数
    const availSize = Math.min(availW, availH);
    let cell = Math.floor(availSize / TOTAL_DIV);
    // 动态下限：保证棋盘始终完整显示在容器内（不强制最小值超出可用空间）
    const dynamicMin = Math.max(8, Math.min(this.MIN_CELL, cell));
    cell = Math.max(dynamicMin, Math.min(this.MAX_CELL, cell));

    this.CELL    = cell;
    this.PADDING = Math.floor(cell * PADDING_RATIO);

    const pieceSize  = Math.floor(cell * 0.9);
    const hintSize   = Math.floor(cell * 0.32);
    const boardPadding = this.PADDING;  // CSS board-inner padding = canvas internal PADDING

    document.documentElement.style.setProperty('--gm-piece-size',   `${pieceSize}px`);
    document.documentElement.style.setProperty('--gm-hint-size',    `${hintSize}px`);
    document.documentElement.style.setProperty('--gm-board-padding', `${boardPadding}px`);
    if (this.container) {
      this.container.style.setProperty('--gm-piece-size',   `${pieceSize}px`);
      this.container.style.setProperty('--gm-hint-size',    `${hintSize}px`);
      this.container.style.setProperty('--gm-board-padding', `${boardPadding}px`);
    }

    console.log('[Gomoku] _calcBoardSize → cell:', cell, 'PADDING:', this.PADDING,
      'availSize:', availSize, 'TOTAL_DIV:', TOTAL_DIV);
  }

  _getBoardPx() {
    const N = this.SIZE - 1;
    const boardPx = this.CELL * N;
    const totalPx = boardPx + this.PADDING * 2;
    return { boardPx, totalPx };
  }

  _rebuildBoard() {
    const { totalPx } = this._getBoardPx();
    const grid    = this.container.querySelector('#gmGrid');
    const canvas  = this.container.querySelector('#gmCanvas');
    const pieces  = this.container.querySelector('#gmPieces');
    const effects = this.container.querySelector('#gmEffects');

    if (grid)    { grid.style.width = `${totalPx}px`;    grid.style.height = `${totalPx}px`; }
    if (canvas)  { canvas.width = totalPx;               canvas.height = totalPx; }
    if (pieces)  { pieces.style.width = `${totalPx}px`;  pieces.style.height = `${totalPx}px`; }
    if (effects) { effects.style.width = `${totalPx}px`; effects.style.height = `${totalPx}px`; }

    this._drawBoard();
    this._render();
  }

  // ── 标准接口 ──────────────────────────────────────────────────────────────
  onGameStart(roomData) {
    this.gameStarted = true;
    this._render();
    console.log('[Gomoku] onGameStart → gameStarted:', this.gameStarted,
      'role:', this.role, 'roomType:', this.roomType,
      'isSpectator:', this.isSpectator, 'currentTurn:', this.currentTurn);

    if (this.isSpectator) return;

    // PvAI 模式：若玩家执白，AI（黑方）先手
    if (this.roomType === 'pv_ai' && this.currentTurn !== this.role) {
      console.log('[Gomoku] onGameStart → AI turn first, triggering AI');
      this._triggerAI();
    }
  }

  onRemoteAction(data) {
    if (data.action === 'place') {
      const { r, c } = data;
      this._applyPlace(r, c);
      this._render();
    } else if (data.action === 'sync_state' && data.game_state) {
      const newState  = data.game_state;
      const oldLast   = this.lastMove;
      const newLast   = newState.lastMove;
      const hasMoved  = newLast && (!oldLast || newLast.r !== oldLast.r || newLast.c !== oldLast.c);
      if (hasMoved) {
        const color = newState.board?.[newLast.r]?.[newLast.c]?.color;
        this._createLandingEffect(newLast.r, newLast.c, color || 'black');
      }
      this.restoreGameState(newState);
    }
  }

  onOpponentLeave() {
    this._showNotice('对手已离开房间');
  }

  /**
   * 供 room.js 调用：从服务端下发的状态快照恢复棋盘
   * @param {Object} state - { board, currentTurn, moveCount, lastMove, winLine, gameOver, winner_role? }
   */
  restoreGameState(state) {
    if (!state || !state.board) return;
    this.board       = state.board.map(row => row.map(cell => cell ? { ...cell } : null));
    this.currentTurn = state.currentTurn || 'black';
    this.moveCount   = state.moveCount   || 0;
    this.lastMove    = state.lastMove  ? { ...state.lastMove }                    : null;
    this.winLine     = state.winLine   ? state.winLine.map(p => ({ ...p }))       : null;
    this.gameOver    = !!state.gameOver;
    this._render();
    if (state.gameOver && state.winner_role && typeof this.notifyGameOver === 'function') {
      const winner = state.winner_role;
      this.notifyGameOver({
        winner_role: winner,
        message: winner === 'black' ? '黑方获胜' : '白方获胜',
        sub: '五子连珠！',
      });
    }
  }

  /** 获取当前局可序列化状态快照 */
  getStateSnapshot() {
    const board = this.board.map(row => row.map(cell => cell ? { color: cell.color } : null));
    const snap = {
      board,
      currentTurn: this.currentTurn,
      moveCount:   this.moveCount,
      lastMove:    this.lastMove  ? { ...this.lastMove }             : null,
      winLine:     this.winLine   ? this.winLine.map(p => ({ ...p })) : null,
      gameOver:    this.gameOver,
    };
    if (this.gameOver && this.winLine) {
      snap.winner_role = this.currentTurn === 'black' ? 'white' : 'black';
    }
    return snap;
  }

  // ── 棋盘初始化 ────────────────────────────────────────────────────────────
  _createInitialBoard() {
    return Array.from({ length: this.SIZE }, () => Array(this.SIZE).fill(null));
  }

  // ── DOM 构建 ──────────────────────────────────────────────────────────────
  _buildDOM() {
    this._calcBoardSize();
    const { totalPx } = this._getBoardPx();

    this.container.innerHTML = `
      <div class="gm-wrapper">
        <div class="gm-status-bar">
          <div class="gm-turn-indicator">
            <div class="gm-turn-stone ${this.currentTurn}" id="gmTurnStone"></div>
            <span id="gmTurnText">黑方先手</span>
          </div>
          <div class="gm-ai-thinking" id="gmAiThinking">
            <div class="gm-ai-spinner"></div>AI 思考中...
          </div>
          <span class="gm-move-count" id="gmMoveCount">第 0 手</span>
        </div>
        <div class="gm-board-outer">
          <div class="gm-board-inner">
            <div class="gm-grid" id="gmGrid" style="width:${totalPx}px;height:${totalPx}px;position:relative;">
              <canvas id="gmCanvas" width="${totalPx}" height="${totalPx}" style="display:block;cursor:pointer;"></canvas>
              <div class="gm-pieces" id="gmPieces" style="width:${totalPx}px;height:${totalPx}px;"></div>
              <div class="gm-effects-layer" id="gmEffects" style="width:${totalPx}px;height:${totalPx}px;"></div>
            </div>
          </div>
        </div>
      </div>`;

    this.canvas       = this.container.querySelector('#gmCanvas');
    this.piecesLayer  = this.container.querySelector('#gmPieces');
    this.effectsLayer = this.container.querySelector('#gmEffects');

    // 所有落子点击都由 canvas 处理
    this.canvas.addEventListener('click', (e) => this._onBoardClick(e));

    this._drawBoard();
  }

  // ── 绘制棋盘格线 ──────────────────────────────────────────────────────────
  _drawBoard() {
    const ctx = this.canvas.getContext('2d');
    const P   = this.PADDING;
    const C   = this.CELL;
    const N   = this.SIZE - 1;  // 14
    const boardPx = C * N;
    const totalPx = boardPx + P * 2;

    ctx.clearRect(0, 0, totalPx, totalPx);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 外框（加粗）
    ctx.strokeStyle = 'rgba(80, 52, 18, 0.9)';
    ctx.lineWidth   = 2;
    ctx.strokeRect(P, P, boardPx, boardPx);

    // 内部网格线
    ctx.strokeStyle = 'rgba(80, 52, 18, 0.65)';
    ctx.lineWidth   = 1;
    for (let i = 0; i <= N; i++) {
      ctx.beginPath();
      ctx.moveTo(P,          P + i * C);
      ctx.lineTo(P + boardPx, P + i * C);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(P + i * C, P);
      ctx.lineTo(P + i * C, P + boardPx);
      ctx.stroke();
    }

    // 星位（15路标准：天元+8个星位）
    const STARS = [
      [3,3],[3,7],[3,11],
      [7,3],[7,7],[7,11],
      [11,3],[11,7],[11,11],
    ];
    const starR = Math.max(3, Math.floor(C * 0.1));
    ctx.fillStyle = 'rgba(80, 52, 18, 0.85)';
    for (const [r, c] of STARS) {
      ctx.beginPath();
      ctx.arc(P + c * C, P + r * C, starR, 0, Math.PI * 2);
      ctx.fill();
    }

    // 天元中心加大
    ctx.beginPath();
    ctx.arc(P + 7 * C, P + 7 * C, starR + 1, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── 渲染棋子 ──────────────────────────────────────────────────────────────
  _render() {
    const layer = this.piecesLayer;
    layer.innerHTML = '';

    const P = this.PADDING;
    const C = this.CELL;

    for (let r = 0; r < this.SIZE; r++) {
      for (let c = 0; c < this.SIZE; c++) {
        const cell = this.board[r][c];
        if (!cell) continue;

        const div = document.createElement('div');
        div.className = `gm-stone ${cell.color}`;
        div.style.left = (P + c * C) + 'px';
        div.style.top  = (P + r * C) + 'px';

        // 最后一手标记
        if (this.lastMove && this.lastMove.r === r && this.lastMove.c === c) {
          div.classList.add('last-move');
        }
        // 获胜连珠高亮
        if (this.winLine && this.winLine.some(p => p.r === r && p.c === c)) {
          div.classList.add('win-stone');
        }

        layer.appendChild(div);
      }
    }

    this._updateStatusBar();
  }

  _updateStatusBar() {
    const stoneEl  = document.getElementById('gmTurnStone');
    const textEl   = document.getElementById('gmTurnText');
    const aiThink  = document.getElementById('gmAiThinking');
    const cntEl    = document.getElementById('gmMoveCount');
    if (!stoneEl) return;

    stoneEl.className = `gm-turn-stone ${this.currentTurn}`;
    const colorLabel = this.currentTurn === 'black' ? '黑方' : '白方';
    const diffMap    = { easy: '简单', normal: '普通', hard: '困难' };

    if (this.gameOver) {
      textEl.textContent = this.winLine
        ? `${this.currentTurn === 'black' ? '白方' : '黑方'}获胜！`
        : '平局！';
    } else if (this.isSpectator) {
      textEl.textContent = `${colorLabel}落子`;
    } else if (this.roomType === 'pv_ai') {
      const aiTurn  = this.currentTurn !== this.role;
      const aiLabel = `AI（${diffMap[this.difficulty] || '普通'}）`;
      textEl.textContent = aiTurn ? `${aiLabel} 思考中` : '你的回合';
    } else {
      const isMyTurn = this.currentTurn === this.role;
      textEl.textContent = isMyTurn ? '你的回合' : `等待${colorLabel}落子`;
    }

    if (aiThink) aiThink.classList.toggle('active', false);
    if (cntEl)   cntEl.textContent = `第 ${this.moveCount} 手`;
  }

  // ── 重置棋盘 ──────────────────────────────────────────────────────────────
  reset(reason) {
    this.board       = this._createInitialBoard();
    this.currentTurn = 'black';
    this.moveCount   = 0;
    this.gameOver    = false;
    this.gameStarted = false;
    this.lastMove    = null;
    this.winLine     = null;
    this._render();
    if (reason) this._showNotice(reason);
  }

  // ── 点击处理 ──────────────────────────────────────────────────────────────
  _canControl() {
    if (this.isSpectator) return false;
    return !(
      this.gameOver ||
      (!this.gameStarted && this.roomType !== 'pv_ai') ||
      this.currentTurn !== this.role
    );
  }

  _onBoardClick(e) {
    if (!this._canControl()) {
      if (!this.isSpectator) {
        if (this.gameOver)                                      this._showNotice('游戏已结束');
        else if (!this.gameStarted && this.roomType !== 'pv_ai') this._showNotice('等待对手加入...');
        else if (this.currentTurn !== this.role)               this._showNotice('等待对方落子');
      }
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const P = this.PADDING;
    const C = this.CELL;

    const c = Math.round((x - P) / C);
    const r = Math.round((y - P) / C);

    if (r < 0 || r >= this.SIZE || c < 0 || c >= this.SIZE) return;
    if (this.board[r][c]) return;  // 已有棋子

    this._doPlace(r, c);
  }

  // ── 落子 ──────────────────────────────────────────────────────────────────
  _doPlace(r, c) {
    this._applyPlace(r, c);
    this._render();

    // PvP：发送落子动作给对手，并带当前局状态供服务端缓存
    if (this.roomType === 'pvp' && typeof this.sendAction === 'function') {
      this.sendAction({
        action: 'place',
        r, c,
        game_state: this.getStateSnapshot(),
      });
    }
    // PvAI：同步局面到服务端，供观战者获取最新局面
    if (this.roomType === 'pv_ai' && typeof this.sendAction === 'function') {
      this.sendAction({ action: 'sync_state', game_state: this.getStateSnapshot() });
    }

    // PvAI：触发 AI 落子
    if (this.roomType === 'pv_ai' && !this.gameOver) {
      this._triggerAI();
    }
  }

  _applyPlace(r, c) {
    const color = this.currentTurn;
    this.board[r][c] = { color };
    this.lastMove    = { r, c };
    this.moveCount++;

    // 落子特效
    this._createLandingEffect(r, c, color);

    // 胜负检测
    const winLine = GomokuRules.getWinLine(this.board, r, c, color, this.SIZE);
    if (winLine) {
      this.winLine  = winLine;
      this.gameOver = true;
      // 等待高亮动画显示后再弹窗
      setTimeout(() => {
        if (typeof this.notifyGameOver === 'function') {
          this.notifyGameOver({
            winner_role: color,
            message: `${color === 'black' ? '黑方' : '白方'}获胜！`,
            sub: '五子连珠！',
          });
        }
      }, 600);
      return;
    }

    // 平局检测（棋盘落满）
    if (GomokuRules.isBoardFull(this.board, this.SIZE)) {
      this.gameOver = true;
      setTimeout(() => {
        if (typeof this.notifyGameOver === 'function') {
          this.notifyGameOver({
            winner_role: 'draw',
            message: '平局！',
            sub: '棋盘已落满，势均力敌',
          });
        }
      }, 300);
      return;
    }

    // 切换回合
    this.currentTurn = color === 'black' ? 'white' : 'black';
  }

  // ── AI 落子 ───────────────────────────────────────────────────────────────
  _triggerAI() {
    if (this.currentTurn === this.role) return;  // 玩家回合
    if (this.gameOver) return;

    const aiEl = document.getElementById('gmAiThinking');
    if (aiEl) aiEl.classList.add('active');
    this._updateStatusBar();

    const delay = { easy: 300, normal: 500, hard: 700 }[this.difficulty] || 500;
    setTimeout(() => {
      if (aiEl) aiEl.classList.remove('active');
      if (this.gameOver) return;

      const mv = GomokuAI.bestMove(this.board, this.currentTurn, this.difficulty, this.SIZE);
      if (mv && !this.gameOver) {
        this._applyPlace(mv.r, mv.c);
        this._render();
        if (this.roomType === 'pv_ai' && typeof this.sendAction === 'function') {
          this.sendAction({ action: 'sync_state', game_state: this.getStateSnapshot() });
        }
      }
    }, delay);
  }

  // ── 特效 ──────────────────────────────────────────────────────────────────
  /** 落子波纹特效 */
  _createLandingEffect(r, c, color) {
    if (!this.effectsLayer) return;
    const P = this.PADDING;
    const C = this.CELL;
    const x = P + c * C;
    const y = P + r * C;

    for (let i = 0; i < 2; i++) {
      setTimeout(() => {
        const ripple = document.createElement('div');
        ripple.className = `gm-ripple ${color}`;
        ripple.style.left = x + 'px';
        ripple.style.top  = y + 'px';
        this.effectsLayer.appendChild(ripple);
        setTimeout(() => ripple.remove(), 600);
      }, i * 120);
    }
  }

  // ── 通知浮层 ──────────────────────────────────────────────────────────────
  _showNotice(msg) {
    const wrapper = this.container.querySelector('.gm-wrapper');
    if (!wrapper) return;
    const div = document.createElement('div');
    div.style.cssText = `
      position:absolute; top:50%; left:50%;
      transform:translate(-50%,-50%);
      background:rgba(0,0,0,.85); color:#fff;
      padding:14px 28px; border-radius:10px;
      font-size:15px; font-weight:600; z-index:100;
      pointer-events:none;
      border: 1px solid rgba(255,200,100,0.3);
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      animation: gm-notice-appear 0.3s ease-out;
    `;
    div.textContent = msg;
    wrapper.appendChild(div);
    setTimeout(() => {
      div.style.animation = 'gm-notice-appear 0.3s ease-out reverse';
      setTimeout(() => div.remove(), 300);
    }, 2700);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GomokuRules — 五子棋规则引擎（纯函数，无副作用）
// ══════════════════════════════════════════════════════════════════════════════
const GomokuRules = (function () {
  'use strict';

  // 4 个方向：横、竖、斜（右下）、斜（右上）
  const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  /**
   * 检测 (r,c) 落子 color 后是否形成五连
   * @returns {Array|null} 获胜的五个坐标数组，或 null
   */
  function getWinLine(board, r, c, color, SIZE) {
    for (const [dr, dc] of DIRS) {
      const line = [{ r, c }];

      // 正方向
      let nr = r + dr, nc = c + dc;
      while (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc]?.color === color) {
        line.push({ r: nr, c: nc });
        nr += dr; nc += dc;
      }
      // 反方向
      nr = r - dr; nc = c - dc;
      while (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc]?.color === color) {
        line.unshift({ r: nr, c: nc });
        nr -= dr; nc -= dc;
      }

      if (line.length >= 5) return line.slice(0, 5);
    }
    return null;
  }

  function checkWin(board, r, c, color, SIZE) {
    return getWinLine(board, r, c, color, SIZE) !== null;
  }

  function isBoardFull(board, SIZE) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!board[r][c]) return false;
      }
    }
    return true;
  }

  return { checkWin, getWinLine, isBoardFull };
})();

// ══════════════════════════════════════════════════════════════════════════════
// GomokuAI — 五子棋 AI（威胁评分算法）
// ══════════════════════════════════════════════════════════════════════════════
const GomokuAI = (function () {
  'use strict';

  const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  /**
   * 评分表：[count][openEnds] → score
   *   openEnds: 0=两端封堵, 1=一端开放, 2=两端开放
   */
  const SCORE_TABLE = {
    5: { 0: 200000, 1: 200000, 2: 200000 },  // 五连 → 必赢
    4: { 0: 0,      1: 5000,   2: 80000  },  // 四连活四/冲四
    3: { 0: 0,      1: 300,    2: 8000   },  // 三连活三/眠三
    2: { 0: 0,      1: 30,     2: 300    },  // 二连活二/眠二
    1: { 0: 0,      1: 3,      2: 15     },  // 单子
  };

  /** 评估在一个方向上，以 (r,c) 为中心的 color 颜色的威胁分 */
  function scoreDirForColor(board, r, c, dr, dc, color, SIZE) {
    const opp = color === 'black' ? 'white' : 'black';

    // 正方向连子数 + 是否末端开放
    let fwd = 0, fwdOpen = false;
    let nr = r + dr, nc = c + dc;
    while (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc]?.color === color) {
      fwd++; nr += dr; nc += dc;
    }
    if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && !board[nr][nc]) fwdOpen = true;

    // 反方向连子数 + 是否末端开放
    let bwd = 0, bwdOpen = false;
    nr = r - dr; nc = c - dc;
    while (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc]?.color === color) {
      bwd++; nr -= dr; nc -= dc;
    }
    if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && !board[nr][nc]) bwdOpen = true;

    const count    = fwd + bwd + 1;
    const openEnds = (fwdOpen ? 1 : 0) + (bwdOpen ? 1 : 0);
    const key      = Math.min(count, 5);
    return (SCORE_TABLE[key]?.[openEnds]) || 0;
  }

  /** 评估在 (r,c) 落下 color 颜色棋子的总威胁分 */
  function evaluatePos(board, r, c, color, SIZE) {
    board[r][c] = { color };  // 临时落子
    let score = 0;
    for (const [dr, dc] of DIRS) {
      score += scoreDirForColor(board, r, c, dr, dc, color, SIZE);
    }
    board[r][c] = null;       // 还原
    return score;
  }

  /**
   * 获取候选落子位置（已有棋子周围 range 格内的空格）
   * 棋盘为空时返回天元附近
   */
  function getCandidates(board, SIZE, range) {
    const set = new Set();
    let hasPiece = false;

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!board[r][c]) continue;
        hasPiece = true;
        for (let dr = -range; dr <= range; dr++) {
          for (let dc = -range; dc <= range; dc++) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && !board[nr][nc]) {
              set.add(`${nr},${nc}`);
            }
          }
        }
      }
    }

    // 空棋盘：从天元开始
    if (!hasPiece) {
      const mid = Math.floor(SIZE / 2);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          set.add(`${mid + dr},${mid + dc}`);
        }
      }
    }

    return [...set].map(k => {
      const [r, c] = k.split(',').map(Number);
      return { r, c };
    });
  }

  /**
   * 返回最佳落子位置
   * @param {Array}  board      - 当前棋盘
   * @param {string} color      - AI 颜色
   * @param {string} difficulty - 'easy' | 'normal' | 'hard'
   * @param {number} SIZE       - 棋盘路数（15）
   * @returns {{ r, c } | null}
   */
  function bestMove(board, color, difficulty, SIZE) {
    const opp  = color === 'black' ? 'white' : 'black';
    const range = difficulty === 'easy' ? 1 : 2;
    const candidates = getCandidates(board, SIZE, range);
    if (candidates.length === 0) return null;

    // easy 难度：从候选位置中随机选一个
    if (difficulty === 'easy') {
      const shuffled = candidates.sort(() => Math.random() - 0.5);
      // 简单 AI 也会优先落在己方有棋子的附近，但不计算威胁
      return shuffled[0];
    }

    let bestScore = -Infinity;
    let bestMoves = [];
    const mid = (SIZE - 1) / 2;

    for (const { r, c } of candidates) {
      const atkScore = evaluatePos(board, r, c, color, SIZE);
      const defScore = evaluatePos(board, r, c, opp,   SIZE);

      let score;
      if (atkScore >= 200000 || defScore >= 200000) {
        // 必赢或必须阻止对手赢：优先处理
        score = Math.max(atkScore, defScore) + (atkScore >= 200000 ? 50000 : 0);
      } else if (atkScore >= 80000 || defScore >= 80000) {
        // 活四/对方活四：次优先
        score = Math.max(atkScore * 1.2, defScore);
      } else {
        // 正常：进攻权重略高于防守
        score = atkScore * 1.15 + defScore;
      }

      // hard 难度：靠近中心的位置给予轻微加成
      if (difficulty === 'hard') {
        const dist = Math.abs(r - mid) + Math.abs(c - mid);
        score += Math.max(0, SIZE - dist) * 0.8;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMoves = [{ r, c }];
      } else if (score === bestScore) {
        bestMoves.push({ r, c });
      }
    }

    // 多个最优解时随机选一个，避免 AI 总走同一步
    return bestMoves[Math.floor(Math.random() * bestMoves.length)] || null;
  }

  return { bestMove };
})();

// ── 导出到全局 ────────────────────────────────────────────────────────────────
window.GomokuGameAdapter = GomokuGameAdapter;
window.GomokuRules       = GomokuRules;
window.GomokuAI          = GomokuAI;
