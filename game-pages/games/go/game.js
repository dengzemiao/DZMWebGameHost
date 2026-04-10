/**
 * go/game.js — 围棋 GameAdapter 实现
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
 *
 * 规则：
 *   - 标准 19 路围棋（中国规则）
 *   - 落子、提子（无气则移除连通块）、劫（简单劫）、禁入（自杀）
 *   - 虚手（Pass）：双方连续 Pass → 终局自动计分
 *   - 认输：直接结束
 *   - 计分：盘面活子数 + 围住的空点数（中国规则，白贴 7.5 目）
 */

// AI Worker 单例
let _goAIWorker = null;
function getGoAIWorker() {
  if (!_goAIWorker) {
    try {
      _goAIWorker = new Worker('games/go/ai-worker.js');
    } catch (e) {
      console.warn('[Go] Worker 创建失败，AI 不可用', e);
    }
  }
  return _goAIWorker;
}

class GoGameAdapter {
  constructor(container, config) {
    this.container   = container;
    this.config      = config;
    this.role        = config.role;         // 'black' | 'white' | 'spectator'
    this.roomType    = config.roomType;     // 'pvp' | 'pv_ai'
    this.difficulty  = config.aiDifficulty || 'normal';
    this.isSpectator = config.isSpectator;

    // 棋盘规格
    this.SIZE    = 19;   // 19×19 路
    this.KOMI    = 7.5;  // 贴目（中国规则白棋补偿）

    // 棋盘状态
    this.board       = null;   // SIZE×SIZE，null | { color: 'black'|'white' }
    this.currentTurn = 'black';
    this.moveCount   = 0;
    this.gameStarted = false;
    this.gameOver    = false;
    this.lastMove    = null;   // { r, c } | null（null 表示虚手）
    this.koHash      = null;   // 禁止复现的棋盘哈希
    this.passCount   = 0;      // 连续虚手次数，达到 2 则终局
    this.captured    = { black: 0, white: 0 };  // 各方被提子数

    // DOM 引用
    this.canvas       = null;
    this.piecesLayer  = null;
    this.effectsLayer = null;

    // 棋盘尺寸（动态计算）
    this.CELL    = 28;
    this.PADDING = 18;
    this.MIN_CELL = 14;
    this.MAX_CELL = 42;

    this._resizeHandler  = null;
    this._aiPending      = false;
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────────
  init() {
    this.board = this._createInitialBoard();
    this._buildDOM();
    this._render();

    this._resizeHandler = this._debounce(() => this._handleResize(), 150);
    window.addEventListener('resize', this._resizeHandler);

    console.log('[Go] init → role:', this.role, 'roomType:', this.roomType,
      'isSpectator:', this.isSpectator);
  }

  _debounce(fn, delay) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), delay); };
  }

  _handleResize() {
    if (!this.container) return;
    this._calcBoardSize();
    this._rebuildBoard();
  }

  _calcBoardSize() {
    const N = this.SIZE - 1;   // 18 格
    const PADDING_RATIO = 0.6;
    const TOTAL_DIV = N + PADDING_RATIO * 4;  // 18 + 2.4 = 20.4

    const rect = this.container.getBoundingClientRect();
    const statusH = 90;   // 状态栏 + 按钮区
    const margin  = 12;
    let availW = rect.width  - margin * 2;
    let availH = rect.height - statusH - margin * 2;

    if (availW <= 0 || availH <= 0) {
      availW = window.innerWidth  - margin * 2;
      availH = window.innerHeight - statusH - margin * 2;
    }

    const availSize = Math.min(availW, availH);
    let cell = Math.floor(availSize / TOTAL_DIV);
    const dynamicMin = Math.max(8, Math.min(this.MIN_CELL, cell));
    cell = Math.max(dynamicMin, Math.min(this.MAX_CELL, cell));

    this.CELL    = cell;
    this.PADDING = Math.floor(cell * PADDING_RATIO);

    const pieceSize    = Math.floor(cell * 0.88);
    const boardPadding = this.PADDING;

    document.documentElement.style.setProperty('--go-piece-size',    `${pieceSize}px`);
    document.documentElement.style.setProperty('--go-board-padding', `${boardPadding}px`);
    if (this.container) {
      this.container.style.setProperty('--go-piece-size',    `${pieceSize}px`);
      this.container.style.setProperty('--go-board-padding', `${boardPadding}px`);
    }
  }

  _getBoardPx() {
    const N       = this.SIZE - 1;
    const boardPx = this.CELL * N;
    const totalPx = boardPx + this.PADDING * 2;
    return { boardPx, totalPx };
  }

  _rebuildBoard() {
    const { totalPx } = this._getBoardPx();
    const grid    = this.container.querySelector('#goGrid');
    const canvas  = this.container.querySelector('#goCanvas');
    const pieces  = this.container.querySelector('#goPieces');
    const effects = this.container.querySelector('#goEffects');

    if (grid)    { grid.style.width  = `${totalPx}px`; grid.style.height  = `${totalPx}px`; }
    if (canvas)  { canvas.width = totalPx;              canvas.height = totalPx; }
    if (pieces)  { pieces.style.width  = `${totalPx}px`; pieces.style.height  = `${totalPx}px`; }
    if (effects) { effects.style.width = `${totalPx}px`; effects.style.height = `${totalPx}px`; }

    this._drawBoard();
    this._render();
  }

  // ── 标准接口 ────────────────────────────────────────────────────────────────
  onGameStart(roomData) {
    this.gameStarted = true;
    this._render();
    console.log('[Go] onGameStart → gameStarted:', this.gameStarted,
      'role:', this.role, 'roomType:', this.roomType,
      'isSpectator:', this.isSpectator, 'currentTurn:', this.currentTurn);

    if (this.isSpectator) return;

    if (this.roomType === 'pv_ai' && this.currentTurn !== this.role) {
      this._triggerAI();
    }
  }

  onRemoteAction(data) {
    if (data.action === 'place') {
      this._applyPlace(data.r, data.c);
      this._render();
    } else if (data.action === 'pass') {
      this._applyPass(false);
      this._render();
    } else if (data.action === 'resign') {
      const resignColor = data.color || (this.currentTurn === 'black' ? 'white' : 'black');
      this._handleResign(resignColor, false);
    } else if (data.action === 'sync_state' && data.game_state) {
      const newState = data.game_state;
      const oldLast  = this.lastMove;
      const newLast  = newState.lastMove;
      if (newLast && (!oldLast || newLast.r !== oldLast.r || newLast.c !== oldLast.c)) {
        const color = newState.board?.[newLast.r]?.[newLast.c]?.color;
        if (color) this._createLandingEffect(newLast.r, newLast.c, color);
      }
      this.restoreGameState(newState);
    }
  }

  onOpponentLeave() {
    this._showNotice('对手已离开房间');
  }

  restoreGameState(state) {
    if (!state || !state.board) return;
    this.board       = state.board.map(row => row.map(c => c ? { ...c } : null));
    this.currentTurn = state.currentTurn || 'black';
    this.moveCount   = state.moveCount   || 0;
    this.lastMove    = state.lastMove    ? { ...state.lastMove } : null;
    this.koHash      = state.koHash      || null;
    this.passCount   = state.passCount   || 0;
    this.captured    = state.captured    ? { ...state.captured } : { black: 0, white: 0 };
    this.gameOver    = !!state.gameOver;
    this._render();
    if (state.gameOver && state.winner_role && typeof this.notifyGameOver === 'function') {
      this.notifyGameOver({
        winner_role: state.winner_role,
        message:     state.end_message || (state.winner_role === 'draw' ? '平局' :
          `${state.winner_role === 'black' ? '黑方' : '白方'}获胜`),
        sub: state.end_sub || '',
      });
    }
  }

  getStateSnapshot() {
    return {
      board:       this.board.map(row => row.map(c => c ? { color: c.color } : null)),
      currentTurn: this.currentTurn,
      moveCount:   this.moveCount,
      lastMove:    this.lastMove   ? { ...this.lastMove } : null,
      koHash:      this.koHash,
      passCount:   this.passCount,
      captured:    { ...this.captured },
      gameOver:    this.gameOver,
    };
  }

  // ── 棋盘初始化 ──────────────────────────────────────────────────────────────
  _createInitialBoard() {
    return Array.from({ length: this.SIZE }, () => Array(this.SIZE).fill(null));
  }

  // ── DOM 构建 ────────────────────────────────────────────────────────────────
  _buildDOM() {
    this._calcBoardSize();
    const { totalPx } = this._getBoardPx();
    const canControl = !this.isSpectator;

    this.container.innerHTML = `
      <div class="go-wrapper">
        <div class="go-status-bar">
          <div class="go-turn-indicator">
            <div class="go-turn-stone ${this.currentTurn}" id="goTurnStone"></div>
            <span id="goTurnText">黑方先手</span>
          </div>
          <div class="go-captures">
            <div class="go-capture-item" title="黑方提子数（吃掉的白子）">
              <span class="go-capture-stone black"></span>
              <span id="goCaptureBlack">0</span>
            </div>
            <div class="go-capture-item" title="白方提子数（吃掉的黑子）">
              <span class="go-capture-stone white"></span>
              <span id="goCaptureWhite">0</span>
            </div>
          </div>
          <div class="go-ai-thinking" id="goAiThinking">
            <div class="go-ai-spinner"></div>AI 思考中...
          </div>
          <span class="go-move-count" id="goMoveCount">第 0 手</span>
        </div>
        <div class="go-board-outer">
          <div class="go-board-inner">
            <div class="go-grid" id="goGrid" style="width:${totalPx}px;height:${totalPx}px;position:relative;">
              <canvas id="goCanvas" width="${totalPx}" height="${totalPx}" style="display:block;cursor:pointer;"></canvas>
              <div class="go-pieces" id="goPieces" style="width:${totalPx}px;height:${totalPx}px;"></div>
              <div class="go-effects-layer" id="goEffects" style="width:${totalPx}px;height:${totalPx}px;"></div>
            </div>
          </div>
        </div>
        ${canControl ? `
        <div class="go-action-bar">
          <button class="go-btn go-btn-pass" id="goBtnPass">虚手</button>
        </div>` : ''}
      </div>`;

    this.canvas       = this.container.querySelector('#goCanvas');
    this.piecesLayer  = this.container.querySelector('#goPieces');
    this.effectsLayer = this.container.querySelector('#goEffects');

    this.canvas.addEventListener('click', (e) => this._onBoardClick(e));

    if (canControl) {
      const btnPass = this.container.querySelector('#goBtnPass');
      if (btnPass) btnPass.addEventListener('click', () => this._onPassClick());
    }

    this._drawBoard();
  }

  // ── 绘制棋盘格线 ────────────────────────────────────────────────────────────
  _drawBoard() {
    const ctx  = this.canvas.getContext('2d');
    const P    = this.PADDING;
    const C    = this.CELL;
    const N    = this.SIZE - 1;   // 18
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
      ctx.moveTo(P,           P + i * C);
      ctx.lineTo(P + boardPx, P + i * C);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(P + i * C, P);
      ctx.lineTo(P + i * C, P + boardPx);
      ctx.stroke();
    }

    // 19 路星位：天元(9,9) + 8 个星(3,3)(3,9)(3,15)(9,3)(9,15)(15,3)(15,9)(15,15)
    // 坐标使用 0-based index
    const STARS = [
      [3, 3], [3,  9], [3, 15],
      [9, 3], [9,  9], [9, 15],
      [15,3], [15, 9], [15,15],
    ];
    const starR = Math.max(2, Math.floor(C * 0.1));
    ctx.fillStyle = 'rgba(80, 52, 18, 0.85)';
    for (const [sr, sc] of STARS) {
      ctx.beginPath();
      ctx.arc(P + sc * C, P + sr * C, starR, 0, Math.PI * 2);
      ctx.fill();
    }

    // 天元加大一点
    ctx.beginPath();
    ctx.arc(P + 9 * C, P + 9 * C, starR + 1, 0, Math.PI * 2);
    ctx.fill();

    // 坐标标注（行：1-19，列：A-T 跳过 I）
    const COLS = 'ABCDEFGHJKLMNOPQRST';
    ctx.fillStyle  = 'rgba(80, 52, 18, 0.6)';
    ctx.font       = `${Math.max(8, Math.floor(C * 0.38))}px sans-serif`;
    ctx.textAlign  = 'center';
    ctx.textBaseline = 'middle';
    const fontSize = Math.max(8, Math.floor(C * 0.38));

    for (let i = 0; i < this.SIZE; i++) {
      // 列标（上方）
      ctx.fillText(COLS[i], P + i * C, P - fontSize * 0.9);
      // 行标（左侧）：围棋习惯从下到上是 1→19
      ctx.fillText(String(this.SIZE - i), P - fontSize * 1.1, P + i * C);
    }
  }

  // ── 渲染棋子 ────────────────────────────────────────────────────────────────
  _render() {
    const layer = this.piecesLayer;
    if (!layer) return;
    layer.innerHTML = '';

    const P = this.PADDING;
    const C = this.CELL;

    for (let r = 0; r < this.SIZE; r++) {
      for (let c = 0; c < this.SIZE; c++) {
        const cell = this.board[r][c];
        if (!cell) continue;

        const div = document.createElement('div');
        div.className = `go-stone ${cell.color}`;
        div.style.left = (P + c * C) + 'px';
        div.style.top  = (P + r * C) + 'px';

        if (this.lastMove && this.lastMove.r === r && this.lastMove.c === c) {
          div.classList.add('last-move');
        }

        layer.appendChild(div);
      }
    }

    this._updateStatusBar();
    this._updateActionButtons();
  }

  _updateStatusBar() {
    const stoneEl = document.getElementById('goTurnStone');
    const textEl  = document.getElementById('goTurnText');
    const aiThink = document.getElementById('goAiThinking');
    const cntEl   = document.getElementById('goMoveCount');
    const capB    = document.getElementById('goCaptureBlack');
    const capW    = document.getElementById('goCaptureWhite');
    if (!stoneEl) return;

    stoneEl.className = `go-turn-stone ${this.currentTurn}`;
    if (capB) capB.textContent = this.captured.black;
    if (capW) capW.textContent = this.captured.white;
    if (cntEl) cntEl.textContent = `第 ${this.moveCount} 手`;

    const colorLabel = this.currentTurn === 'black' ? '黑方' : '白方';
    const diffMap    = { easy: '简单', normal: '普通', hard: '困难', hell: '地狱' };

    if (this.gameOver) {
      textEl.textContent = '游戏结束';
      stoneEl.style.animation = 'none';
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

    if (aiThink) aiThink.classList.remove('active');
  }

  _updateActionButtons() {
    const btnPass = this.container ? this.container.querySelector('#goBtnPass') : null;
    if (!btnPass) return;
    const started = this.gameStarted || this.roomType === 'pv_ai';
    btnPass.disabled = this.gameOver || !started || this.isSpectator ||
                       this.currentTurn !== this.role;
  }

  // ── 重置棋盘 ────────────────────────────────────────────────────────────────
  reset(reason) {
    this.board       = this._createInitialBoard();
    this.currentTurn = 'black';
    this.moveCount   = 0;
    this.gameOver    = false;
    this.gameStarted = false;
    this.lastMove    = null;
    this.koHash      = null;
    this.passCount   = 0;
    this.captured    = { black: 0, white: 0 };
    this._render();
    if (reason) this._showNotice(reason);
  }

  // ── 控制权判断 ──────────────────────────────────────────────────────────────
  _canControl() {
    if (this.isSpectator) return false;
    if (this.gameOver)    return false;
    if (!this.gameStarted && this.roomType !== 'pv_ai') return false;
    if (this.currentTurn !== this.role) return false;
    return true;
  }

  // ── 点击处理 ────────────────────────────────────────────────────────────────
  _onBoardClick(e) {
    if (!this._canControl()) {
      if (!this.isSpectator) {
        if (this.gameOver)                                           this._showNotice('游戏已结束');
        else if (!this.gameStarted && this.roomType !== 'pv_ai')    this._showNotice('等待对手加入...');
        else if (this.currentTurn !== this.role)                    this._showNotice('等待对方落子');
      }
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const x    = e.clientX - rect.left;
    const y    = e.clientY - rect.top;
    const P    = this.PADDING;
    const C    = this.CELL;

    const c = Math.round((x - P) / C);
    const r = Math.round((y - P) / C);
    if (r < 0 || r >= this.SIZE || c < 0 || c >= this.SIZE) return;
    if (this.board[r][c]) {
      this._showNotice('此处已有棋子');
      return;
    }

    this._doPlace(r, c);
  }

  // ── 虚手（Pass）────────────────────────────────────────────────────────────
  _onPassClick() {
    if (!this._canControl()) return;
    this._doPass();
  }

  _doPass() {
    this._applyPass(true);
    this._render();

    if (this.roomType === 'pvp' && typeof this.sendAction === 'function') {
      this.sendAction({ action: 'pass', game_state: this.getStateSnapshot() });
    }
    if (this.roomType === 'pv_ai' && !this.gameOver && typeof this.sendAction === 'function') {
      this.sendAction({ action: 'sync_state', game_state: this.getStateSnapshot() });
    }

    if (this.roomType === 'pv_ai' && !this.gameOver) {
      this._triggerAI();
    }
  }

  _applyPass(local) {
    this.passCount++;
    this.lastMove  = null;  // 虚手没有落子坐标
    this.moveCount++;
    this.koHash    = null;  // 虚手重置劫

    if (local) this._showPassNotice(this.currentTurn);

    if (this.passCount >= 2) {
      this._endGame();
      return;
    }

    this.currentTurn = this.currentTurn === 'black' ? 'white' : 'black';
  }

  _showPassNotice(color) {
    const label = color === 'black' ? '黑方' : '白方';
    const grid  = this.container ? this.container.querySelector('.go-grid') : null;
    if (!grid) { this._showNotice(`${label} 虚手`); return; }

    const div = document.createElement('div');
    div.className = 'go-pass-notice';
    div.textContent = `${label} 虚手`;
    grid.appendChild(div);
    setTimeout(() => {
      div.style.animation = 'go-notice-appear 0.3s ease-out reverse';
      setTimeout(() => div.remove(), 300);
    }, 1500);
  }

  // ── 认输 ────────────────────────────────────────────────────────────────────
  _onResignClick() {
    if (this.gameOver || !this.gameStarted || this.isSpectator) return;
    const ok = window.confirm('确认认输？');
    if (!ok) return;

    if (this.roomType === 'pvp' && typeof this.sendAction === 'function') {
      this.sendAction({ action: 'resign', color: this.role });
    }
    this._handleResign(this.role, true);
  }

  _handleResign(resignColor, local) {
    this.gameOver = true;
    const winner  = resignColor === 'black' ? 'white' : 'black';
    const winLabel = winner === 'black' ? '黑方' : '白方';
    const resLabel = resignColor === 'black' ? '黑方' : '白方';
    this._render();
    if (typeof this.notifyGameOver === 'function') {
      this.notifyGameOver({
        winner_role: winner,
        message: `${winLabel}获胜`,
        sub: `${resLabel}认输`,
      });
    }
  }

  // ── 落子 ────────────────────────────────────────────────────────────────────
  _doPlace(r, c) {
    const result = this._applyPlace(r, c);
    if (!result) return;
    this._render();

    if (this.roomType === 'pvp' && typeof this.sendAction === 'function') {
      this.sendAction({ action: 'place', r, c, game_state: this.getStateSnapshot() });
    }
    if (this.roomType === 'pv_ai' && typeof this.sendAction === 'function') {
      this.sendAction({ action: 'sync_state', game_state: this.getStateSnapshot() });
    }

    if (this.roomType === 'pv_ai' && !this.gameOver) {
      this._triggerAI();
    }
  }

  /**
   * 执行落子逻辑（规则校验 + 提子 + 劫更新）
   * @returns {boolean} 是否成功
   */
  _applyPlace(r, c) {
    const color = this.currentTurn;
    const opp   = color === 'black' ? 'white' : 'black';

    // 已有棋子
    if (this.board[r][c]) return false;

    // 落子前保存棋盘哈希（用于劫规则）
    const preMoveHash = GoRules.boardHash(this.board, this.SIZE);

    // 试落子
    const testBoard = this.board.map(row => row.slice());
    testBoard[r][c] = { color };

    // 提子：检查四方对手棋组是否无气
    let totalCaptured = 0;
    const DIRS4 = [[-1,0],[1,0],[0,-1],[0,1]];
    for (const [dr, dc] of DIRS4) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= this.SIZE || nc < 0 || nc >= this.SIZE) continue;
      if (!testBoard[nr][nc] || testBoard[nr][nc].color !== opp) continue;
      const { group, liberties } = GoRules.getGroupAndLiberties(testBoard, nr, nc, this.SIZE);
      if (liberties.size === 0) {
        totalCaptured += group.length;
        for (const [gr, gc] of group) testBoard[gr][gc] = null;
      }
    }

    // 自杀检测（落子后己方无气且未提子）
    const { liberties: myLib } = GoRules.getGroupAndLiberties(testBoard, r, c, this.SIZE);
    if (myLib.size === 0 && totalCaptured === 0) {
      this._showNotice('禁入点（自杀禁止）');
      return false;
    }

    // 劫检测
    const newHash = GoRules.boardHash(testBoard, this.SIZE);
    if (this.koHash && newHash === this.koHash) {
      this._showNotice('劫争，禁止立即还原');
      return false;
    }

    // 应用落子
    for (let i = 0; i < this.SIZE; i++) this.board[i] = testBoard[i].slice();

    // 更新劫哈希：提了恰好 1 子时，禁止对手立即还原到落子前的棋盘状态
    this.koHash = totalCaptured === 1 ? preMoveHash : null;

    // 更新被提子数
    this.captured[color] += totalCaptured;

    this.lastMove    = { r, c };
    this.moveCount++;
    this.passCount   = 0;   // 落子重置连续虚手

    this._createLandingEffect(r, c, color);

    this.currentTurn = opp;
    return true;
  }

  // ── 终局计分 ────────────────────────────────────────────────────────────────
  _endGame() {
    this.gameOver = true;
    this._render();

    const score = GoRules.calcScore(this.board, this.SIZE, this.captured, this.KOMI);
    const winnerRole = score.black > score.white ? 'black' : 'white';
    const diff = Math.abs(score.black - score.white).toFixed(1);

    const blackLabel = `黑方：${score.black.toFixed(1)}（地 ${score.blackTerritory} + 子 ${score.blackStones}）`;
    const whiteLabel = `白方：${score.white.toFixed(1)}（地 ${score.whiteTerritory} + 子 ${score.whiteStones} + 贴 ${this.KOMI}）`;

    setTimeout(() => {
      if (typeof this.notifyGameOver === 'function') {
        this.notifyGameOver({
          winner_role: winnerRole,
          message: `${winnerRole === 'black' ? '黑方' : '白方'}获胜（胜 ${diff} 目）`,
          sub: `${blackLabel}  |  ${whiteLabel}`,
        });
      }
    }, 400);
  }

  // ── AI 落子 ─────────────────────────────────────────────────────────────────
  _triggerAI() {
    if (this.currentTurn === this.role) return;
    if (this.gameOver || this._aiPending) return;
    this._aiPending = true;

    const aiEl = document.getElementById('goAiThinking');
    if (aiEl) aiEl.classList.add('active');
    this._updateStatusBar();

    const worker = getGoAIWorker();
    if (!worker) {
      if (aiEl) aiEl.classList.remove('active');
      this._aiPending = false;
      return;
    }

    const boardCopy  = this.board.map(row => row.map(cell => cell ? { color: cell.color } : null));
    const color      = this.currentTurn;
    const difficulty = this.difficulty;
    const SIZE       = this.SIZE;
    const koHash     = this.koHash;

    const delay = { easy: 300, normal: 400, hard: 400, hell: 400 }[difficulty] || 400;

    setTimeout(() => {
      worker.onmessage = (ev) => {
        if (aiEl) aiEl.classList.remove('active');
        this._aiPending = false;
        if (this.gameOver) return;

        const mv = ev.data.move;
        if (mv) {
          const ok = this._applyPlace(mv.r, mv.c);
          if (!ok) {
            console.warn('[Go] AI move rejected, falling back to pass', mv);
            this._applyPass(false);
            this._showPassNotice(color);
          }
        } else {
          this._applyPass(false);
          this._showPassNotice(color);
        }
        this._render();

        if (typeof this.sendAction === 'function') {
          this.sendAction({ action: 'sync_state', game_state: this.getStateSnapshot() });
        }
      };
      worker.onerror = (err) => {
        console.error('[Go] AI worker error:', err);
        if (aiEl) aiEl.classList.remove('active');
        this._aiPending = false;
      };
      worker.postMessage({ board: boardCopy, color, difficulty, SIZE, koHash });
    }, delay);
  }

  // ── 特效 ────────────────────────────────────────────────────────────────────
  _createLandingEffect(r, c, color) {
    if (!this.effectsLayer) return;
    const P = this.PADDING;
    const C = this.CELL;
    const x = P + c * C;
    const y = P + r * C;

    for (let i = 0; i < 2; i++) {
      setTimeout(() => {
        const ripple = document.createElement('div');
        ripple.className = `go-ripple ${color}`;
        ripple.style.left = x + 'px';
        ripple.style.top  = y + 'px';
        this.effectsLayer.appendChild(ripple);
        setTimeout(() => ripple.remove(), 560);
      }, i * 110);
    }
  }

  // ── 通知浮层 ────────────────────────────────────────────────────────────────
  _showNotice(msg) {
    const wrapper = this.container ? this.container.querySelector('.go-wrapper') : null;
    if (!wrapper) return;
    const div = document.createElement('div');
    div.style.cssText = `
      position:absolute; top:50%; left:50%;
      transform:translate(-50%,-50%);
      background:rgba(0,0,0,.85); color:#fff;
      padding:12px 24px; border-radius:10px;
      font-size:14px; font-weight:600; z-index:300;
      pointer-events:none;
      border: 1px solid rgba(255,200,100,0.3);
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      animation: go-notice-appear 0.3s ease-out;
    `;
    div.textContent = msg;
    wrapper.appendChild(div);
    setTimeout(() => {
      div.style.animation = 'go-notice-appear 0.3s ease-out reverse';
      setTimeout(() => div.remove(), 300);
    }, 2700);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GoRules — 围棋规则引擎（纯函数，无副作用）
// ══════════════════════════════════════════════════════════════════════════════
const GoRules = (function () {
  'use strict';

  const DIRS4 = [[-1,0],[1,0],[0,-1],[0,1]];

  /** 克隆棋盘 */
  function cloneBoard(board, SIZE) {
    return board.map(row => row.slice());
  }

  /** 棋盘哈希（用于劫检测） */
  function boardHash(board, SIZE) {
    let s = '';
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const v = board[r][c];
        s += v ? (v.color === 'black' ? 'B' : 'W') : '.';
      }
    }
    return s;
  }

  /** 获取连通块及其气（liberties） */
  function getGroupAndLiberties(board, r, c, SIZE) {
    const cell = board[r][c];
    if (!cell) return { group: [], liberties: new Set() };

    const color = cell.color || cell;
    const group = [];
    const liberties = new Set();
    const visited   = new Set();
    const stack     = [[r, c]];

    while (stack.length > 0) {
      const [cr, cc] = stack.pop();
      const key = cr * SIZE + cc;
      if (visited.has(key)) continue;
      visited.add(key);
      group.push([cr, cc]);

      for (const [dr, dc] of DIRS4) {
        const nr = cr + dr, nc = cc + dc;
        if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
        const nkey = nr * SIZE + nc;
        const ncell = board[nr][nc];
        if (!ncell) {
          liberties.add(nr + ',' + nc);
        } else {
          const ncolor = ncell.color || ncell;
          if (ncolor === color && !visited.has(nkey)) stack.push([nr, nc]);
        }
      }
    }

    return { group, liberties };
  }

  /**
   * 计分（中国规则）：盘面活子 + 围住的空点 + 白棋贴目
   */
  function calcScore(board, SIZE, captured, komi) {
    // 统计活子
    let blackStones = 0, whiteStones = 0;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c]?.color === 'black') blackStones++;
        else if (board[r][c]?.color === 'white') whiteStones++;
      }
    }

    // 统计领地（空点归属）
    let blackTerritory = 0, whiteTerritory = 0;
    const visited = new Set();

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c] || visited.has(r * SIZE + c)) continue;
        const empties = [];
        let touchBlack = false, touchWhite = false;
        const stack    = [[r, c]];
        const localVis = new Set();

        while (stack.length > 0) {
          const [cr, cc] = stack.pop();
          const k = cr * SIZE + cc;
          if (localVis.has(k)) continue;
          localVis.add(k);
          visited.add(k);
          empties.push([cr, cc]);
          for (const [dr, dc] of DIRS4) {
            const nr = cr + dr, nc = cc + dc;
            if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
            const ncell = board[nr][nc];
            if (!ncell) {
              if (!localVis.has(nr * SIZE + nc)) stack.push([nr, nc]);
            } else {
              if (ncell.color === 'black') touchBlack = true;
              else touchWhite = true;
            }
          }
        }

        if (touchBlack && !touchWhite) blackTerritory += empties.length;
        else if (touchWhite && !touchBlack) whiteTerritory += empties.length;
      }
    }

    const black = blackStones + blackTerritory;
    const white = whiteStones + whiteTerritory + komi;

    return { black, white, blackStones, whiteStones, blackTerritory, whiteTerritory };
  }

  return { boardHash, getGroupAndLiberties, calcScore };
})();

// ── 导出到全局 ─────────────────────────────────────────────────────────────────
window.GoGameAdapter = GoGameAdapter;
window.GoRules       = GoRules;
