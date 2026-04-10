/**
 * chess/game.js — 中国象棋 GameAdapter 实现
 *
 * 实现 GameAdapter 标准接口：
 *   constructor(container, config)
 *   init()
 *   onGameStart(roomData)
 *   onRemoteAction(data)
 *   onOpponentLeave()
 *   sendAction(data)     ← 由 room.js 注入
 *   notifyGameOver(result) ← 由 room.js 注入
 */

// AI Worker 单例（后台线程计算，不阻塞 UI）
let _chessAIWorker = null;
function getChessAIWorker() {
  if (!_chessAIWorker) {
    try {
      _chessAIWorker = new Worker('games/chess/ai-worker.js');
    } catch (e) {
      console.warn('[Chess] Worker 创建失败，回退到主线程 AI', e);
    }
  }
  return _chessAIWorker;
}

class ChessGameAdapter {
  constructor(container, config) {
    this.container    = container;
    this.config       = config;
    // config: { role, roomType, aiDifficulty, mySessionId, isSpectator }
    this.role         = config.role;        // 'red' | 'black' | 'spectator'
    this.roomType     = config.roomType;    // 'pvp' | 'pv_ai'
    this.difficulty   = config.aiDifficulty || 'normal';
    this.isSpectator  = config.isSpectator;

    this.board        = null;   // 10×9 数组
    this.selected     = null;   // { r, c }
    this.currentTurn  = 'red';  // 当前回合
    this.moveCount    = 0;
    this.gameStarted  = false;
    this.gameOver     = false;
    this.lastMove     = null;   // { fr, fc, tr, tc }
    this.checkColor   = null;   // 将军方

    // DOM 引用
    this.canvas       = null;
    this.piecesLayer  = null;
    this.effectsLayer = null;   // 特效层
    
    // 棋盘尺寸（动态计算）
    this.CELL         = 54;     // 格子像素大小（默认值，会动态计算）
    this.PADDING      = 28;     // 棋盘内边距（默认值，会动态计算）
    this.MIN_CELL     = 32;     // 最小格子尺寸
    this.MAX_CELL     = 60;     // 最大格子尺寸
    
    // 动画相关
    this.isAnimating  = false;  // 是否正在播放动画
    this._resizeHandler = null; // resize 事件处理器
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────
  init() {
    this.board = this._createInitialBoard();
    this._buildDOM();
    this._render();
    
    // 监听窗口大小变化（横竖屏切换）
    this._resizeHandler = this._debounce(() => this._handleResize(), 150);
    window.addEventListener('resize', this._resizeHandler);
    
    console.log('[Chess] init → role:', this.role, 'roomType:', this.roomType,
      'isSpectator:', this.isSpectator, 'currentTurn:', this.currentTurn);
  }
  
  // 防抖函数
  _debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }
  
  // 倒计时重新计算并重绘棋盘
  _handleResize() {
    if (!this.container) return;
    this._calcBoardSize();
    this._rebuildBoard();
  }
  
  // 动态计算棋盘尺寸（根据容器窄边自适应）
  _calcBoardSize() {
    // 棋盘格子数（线间距）：9列×10行
    const COLS = 8, ROWS = 9;
    // 实际渲染宽/高 = CELL*(COLS+2) / CELL*(ROWS+2)
    // 原因：canvas 内部 PADDING（CELL*0.5）+ CSS board-inner padding（CELL*0.5）= 每侧 CELL，共 2*CELL
    const RATIO = (COLS + 2) / (ROWS + 2); // 10/11 ≈ 0.909
    
    // 获取容器可用空间
    const containerRect = this.container.getBoundingClientRect();
    // 预留状态栏和边距的空间
    const statusBarHeight = 50;
    const margin = 20;
    let availW = containerRect.width - margin * 2;
    let availH = containerRect.height - statusBarHeight - margin * 2;
    
    // 容器尺寸无效时，使用视口窄边计算
    if (availW <= 0 || availH <= 0) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      availW = vw - margin * 2;
      availH = vh - statusBarHeight - margin * 2;
    }
    
    // 取窄边计算（横竖屏自动适配）
    let boardW, boardH;
    if (availW / availH > RATIO) {
      // 容器较宽，按高度填满
      boardH = availH;
      boardW = boardH * RATIO;
    } else {
      // 容器较窄，按宽度填满
      boardW = availW;
      boardH = boardW / RATIO;
    }
    
    // 计算格子大小：除以 (COLS+2)/(ROWS+2) 以完整容纳双重 padding
    const cellFromW = boardW / (COLS + 2); // boardW/10
    const cellFromH = boardH / (ROWS + 2); // boardH/11
    let cell = Math.min(cellFromW, cellFromH);
    
    // 动态下限：保证棋盘始终完整显示在容器内（不强制最小值超出可用空间）
    const dynamicMin = Math.max(8, Math.min(this.MIN_CELL, cell));
    cell = Math.max(dynamicMin, Math.min(this.MAX_CELL, cell));
    
    this.CELL = Math.floor(cell);
    this.PADDING = Math.floor(cell * 0.5);
    
    // 同步更新 CSS 变量（让 CSS 样式与 JS 尺寸一致）
    const pieceSize = Math.floor(cell * 0.9);      // 棋子稍小于格子
    const pieceFont = Math.floor(cell * 0.42);     // 字体约为格子的 42%
    const hintSize = Math.floor(cell * 0.35);      // 提示点约为格子的 35%
    
    document.documentElement.style.setProperty('--piece-size', `${pieceSize}px`);
    document.documentElement.style.setProperty('--piece-font', `${pieceFont}px`);
    document.documentElement.style.setProperty('--hint-size', `${hintSize}px`);
    document.documentElement.style.setProperty('--board-padding', `${this.PADDING}px`);
    
    // 同时设置到容器上（确保优先级）
    if (this.container) {
      this.container.style.setProperty('--piece-size', `${pieceSize}px`);
      this.container.style.setProperty('--piece-font', `${pieceFont}px`);
      this.container.style.setProperty('--hint-size', `${hintSize}px`);
      this.container.style.setProperty('--board-padding', `${this.PADDING}px`);
    }
    
    console.log('[Chess] _calcBoardSize → cell:', cell, 'pieceSize:', pieceSize, 'availW:', availW, 'availH:', availH);
  }
  
  // 重建棋盘 DOM 和渲染
  _rebuildBoard() {
    const COLS = 8, ROWS = 9;
    const W = this.CELL * COLS;
    const H = this.CELL * ROWS;
    const totalW = W + this.PADDING * 2;
    const totalH = H + this.PADDING * 2;
    
    // 更新尺寸
    const grid = this.container.querySelector('#chGrid');
    const canvas = this.container.querySelector('#chCanvas');
    const pieces = this.container.querySelector('#chPieces');
    const effects = this.container.querySelector('#chEffects');
    
    if (grid) {
      grid.style.width = `${totalW}px`;
      grid.style.height = `${totalH}px`;
    }
    if (canvas) {
      canvas.width = totalW;
      canvas.height = totalH;
    }
    if (pieces) {
      pieces.style.width = `${totalW}px`;
      pieces.style.height = `${totalH}px`;
    }
    if (effects) {
      effects.style.width = `${totalW}px`;
      effects.style.height = `${totalH}px`;
    }
    
    // 重绘棋盘和棋子
    this._drawBoard();
    this._render();
  }

  onGameStart(roomData) {
    this.gameStarted = true;
    this._render();
    console.log('[Chess] onGameStart → gameStarted:', this.gameStarted,
      'role:', this.role, 'roomType:', this.roomType,
      'isSpectator:', this.isSpectator, 'currentTurn:', this.currentTurn);
    
    // 观战模式不触发任何走棋
    if (this.isSpectator) {
      console.log('[Chess] onGameStart → spectator mode, skip AI trigger');
      return;
    }
    
    // PvAI 模式：若当前不是玩家回合（玩家执黑时 AI 红方先手），触发 AI
    if (this.roomType === 'pv_ai' && this.currentTurn !== this.role) {
      console.log('[Chess] onGameStart → AI turn, triggering AI');
      this._triggerAI();
    }
  }

  onRemoteAction(data) {
    if (data.action === 'move') {
      const { fr, fc, tr, tc } = data;
      this._applyMove(fr, fc, tr, tc);
      this._render();
    } else if (data.action === 'sync_state' && data.game_state && typeof this.restoreGameState === 'function') {
      // 观战者接收 sync_state 时，检测是否有新的走棋动作，如有则触发特效
      const newState = data.game_state;
      const oldLastMove = this.lastMove;
      const newLastMove = newState.lastMove;
      
      // 检测是否有新的走棋动作
      const hasMoveChange = newLastMove && (
        !oldLastMove ||
        newLastMove.fr !== oldLastMove.fr ||
        newLastMove.fc !== oldLastMove.fc ||
        newLastMove.tr !== oldLastMove.tr ||
        newLastMove.tc !== oldLastMove.tc
      );
      
      if (hasMoveChange) {
        // 检测是否有吃子（当前棋盘目标位置有棋子）
        const targetPiece = this.board[newLastMove.tr]?.[newLastMove.tc];
        if (targetPiece) {
          this._createCaptureEffect(newLastMove.tr, newLastMove.tc, targetPiece.color);
        }
        // 触发移动轨迹和落子波纹
        this._createMoveTrail(newLastMove.fr, newLastMove.fc, newLastMove.tr, newLastMove.tc);
        this._createLandingRipple(newLastMove.tr, newLastMove.tc);
      }
      
      // 检测是否新产生将军
      const oldCheckColor = this.checkColor;
      this.restoreGameState(newState);
      if (this.checkColor && this.checkColor !== oldCheckColor) {
        this._triggerCheckEffect();
      }
    }
  }

  onOpponentLeave() {
    this._showNotice('对手已离开房间');
  }

  /**
   * 供 room.js 调用：用服务端下发的当前局状态恢复棋盘（新人加入/重连/观战）
   * @param {Object} state - { board, currentTurn, moveCount, lastMove, checkColor, gameOver }
   */
  restoreGameState(state) {
    if (!state || !state.board) return;
    this.board = state.board.map(row => row.map(cell => cell ? { ...cell } : null));
    this.currentTurn = state.currentTurn || 'red';
    this.moveCount = state.moveCount || 0;
    this.lastMove = state.lastMove ? { ...state.lastMove } : null;
    this.checkColor = state.checkColor || null;
    this.gameOver = !!state.gameOver;
    this.selected = null;
    this._render();
    if (state.gameOver && state.winner_role && typeof this.notifyGameOver === 'function') {
      this.notifyGameOver({
        winner_role: state.winner_role,
        message: state.winner_role === 'red' ? '红方获胜' : '黑方获胜',
        sub: '本局已结束',
      });
    }
  }

  /** 当前局可序列化状态，用于 PvP 走棋时上报服务端 */
  getStateSnapshot() {
    const board = this.board.map(row => row.map(cell => cell ? { type: cell.type, color: cell.color } : null));
    const snap = {
      board,
      currentTurn: this.currentTurn,
      moveCount: this.moveCount,
      lastMove: this.lastMove ? { ...this.lastMove } : null,
      checkColor: this.checkColor,
      gameOver: this.gameOver,
    };
    if (this.gameOver) snap.winner_role = this.currentTurn === 'red' ? 'black' : 'red';
    return snap;
  }

  // ── 棋盘初始布局 ──────────────────────────────────────────────────────────
  _createInitialBoard() {
    const B = Array.from({ length: 10 }, () => Array(9).fill(null));
    const place = (r, c, type, color) => { B[r][c] = { type, color }; };

    // 黑方（上方，行 0）
    place(0,0,'R','black'); place(0,1,'N','black'); place(0,2,'B','black');
    place(0,3,'A','black'); place(0,4,'K','black'); place(0,5,'A','black');
    place(0,6,'B','black'); place(0,7,'N','black'); place(0,8,'R','black');
    place(2,1,'C','black'); place(2,7,'C','black');
    for (let c of [0,2,4,6,8]) place(3,c,'P','black');

    // 红方（下方，行 9）
    place(9,0,'R','red'); place(9,1,'N','red'); place(9,2,'B','red');
    place(9,3,'A','red'); place(9,4,'K','red'); place(9,5,'A','red');
    place(9,6,'B','red'); place(9,7,'N','red'); place(9,8,'R','red');
    place(7,1,'C','red'); place(7,7,'C','red');
    for (let c of [0,2,4,6,8]) place(6,c,'P','red');

    return B;
  }

  // ── DOM 构建 ──────────────────────────────────────────────────────────────
  _buildDOM() {
    // 先计算棋盘尺寸
    this._calcBoardSize();
    
    const COLS = 8; const ROWS = 9;
    const W = this.CELL * COLS;
    const H = this.CELL * ROWS;
    const totalW = W + this.PADDING * 2;
    const totalH = H + this.PADDING * 2;

    this.container.innerHTML = `
      <div class="chess-wrapper">
        <div class="chess-status-bar">
          <div class="chess-turn-indicator">
            <div class="turn-dot red" id="chTurnDot"></div>
            <span id="chTurnText">红方先手</span>
          </div>
          <span class="chess-check-notice" id="chCheckNotice" style="display:none">将军！</span>
          <div class="chess-ai-thinking" id="chAiThinking">
            <div class="ai-spinner"></div>AI 思考中...
          </div>
          <span class="chess-move-count" id="chMoveCount">第 0 回合</span>
        </div>
        <div class="chess-board-outer">
          <div class="chess-board-inner">
            <div class="chess-grid" id="chGrid" style="width:${totalW}px;height:${totalH}px;position:relative;">
              <canvas id="chCanvas" width="${totalW}" height="${totalH}" style="display:block;"></canvas>
              <div class="chess-pieces" id="chPieces" style="width:${totalW}px;height:${totalH}px;"></div>
              <div class="chess-effects-layer" id="chEffects" style="width:${totalW}px;height:${totalH}px;"></div>
            </div>
          </div>
        </div>
      </div>`;

    this.canvas      = this.container.querySelector('#chCanvas');
    this.piecesLayer = this.container.querySelector('#chPieces');
    this.effectsLayer = this.container.querySelector('#chEffects');

    // 点击事件
    this.piecesLayer.addEventListener('click', (e) => this._onBoardClick(e));
    // canvas 点击（空格点击）
    this.canvas.addEventListener('click', (e) => this._onBoardClick(e));

    this._drawBoard();
  }

  // ── 绘制棋盘格线 ──────────────────────────────────────────────────────────
  _drawBoard() {
    const ctx = this.canvas.getContext('2d');
    const P = this.PADDING;
    const C = this.CELL;
    const W = C * 8; const H = C * 9;

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    // 启用抗锯齿
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 绘制主线条（深色）
    ctx.strokeStyle = 'rgba(70, 45, 15, 0.85)';
    ctx.lineWidth = 1.5;

    // 外框（双线效果）
    ctx.strokeRect(P - 1, P - 1, W + 2, H + 2);
    ctx.strokeStyle = 'rgba(90, 60, 20, 0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(P, P, W, H);
    
    // 恢复主线条样式
    ctx.strokeStyle = 'rgba(70, 45, 15, 0.75)';
    ctx.lineWidth = 1;

    // 横线
    for (let r = 0; r <= 9; r++) {
      ctx.beginPath();
      ctx.moveTo(P, P + r * C);
      ctx.lineTo(P + W, P + r * C);
      ctx.stroke();
    }

    // 竖线（上下半区）
    for (let c = 0; c <= 8; c++) {
      if (c === 0 || c === 8) {
        ctx.beginPath();
        ctx.moveTo(P + c * C, P);
        ctx.lineTo(P + c * C, P + H);
        ctx.stroke();
      } else {
        // 上半区（行 0~4）
        ctx.beginPath();
        ctx.moveTo(P + c * C, P);
        ctx.lineTo(P + c * C, P + 4 * C);
        ctx.stroke();
        // 下半区（行 5~9）
        ctx.beginPath();
        ctx.moveTo(P + c * C, P + 5 * C);
        ctx.lineTo(P + c * C, P + H);
        ctx.stroke();
      }
    }

    // 九宫格斜线（上方黑方）
    ctx.beginPath(); ctx.moveTo(P + 3*C, P); ctx.lineTo(P + 5*C, P + 2*C); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(P + 5*C, P); ctx.lineTo(P + 3*C, P + 2*C); ctx.stroke();
    // 九宫格斜线（下方红方）
    ctx.beginPath(); ctx.moveTo(P + 3*C, P + 7*C); ctx.lineTo(P + 5*C, P + 9*C); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(P + 5*C, P + 7*C); ctx.lineTo(P + 3*C, P + 9*C); ctx.stroke();

    // 炮兵位标记（小十字）
    ctx.strokeStyle = 'rgba(70, 45, 15, 0.7)';
    const markPos = [
      [2,1],[2,7],[7,1],[7,7],
      [3,0],[3,2],[3,4],[3,6],[3,8],
      [6,0],[6,2],[6,4],[6,6],[6,8],
    ];
    for (const [r, c] of markPos) {
      this._drawMark(ctx, P + c*C, P + r*C);
    }

    // 绘制交叉点的微小灰色点（增加精细感）
    ctx.fillStyle = 'rgba(70, 45, 15, 0.3)';
    for (let r = 0; r <= 9; r++) {
      for (let c = 0; c <= 8; c++) {
        // 跳过河界区域
        if ((r === 4 || r === 5) && c > 0 && c < 8) continue;
        ctx.beginPath();
        ctx.arc(P + c * C, P + r * C, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 河界文字（更精美的字体）
    ctx.save();
    ctx.font = 'bold 18px STKaiti, KaiTi, "Noto Serif SC", serif';
    ctx.fillStyle = 'rgba(90, 60, 25, 0.55)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // 添加文字阴影效果
    ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    
    ctx.fillText('楚 河', P + 2 * C, P + 4.5 * C);
    ctx.fillText('漢 界', P + 6 * C, P + 4.5 * C);
    ctx.restore();
  }

  _drawMark(ctx, x, y) {
    const s = 5;
    const gap = 3;
    ctx.lineWidth = 1.2;
    
    // 左上
    if (x > this.PADDING + this.CELL * 0.5) {
      ctx.beginPath();
      ctx.moveTo(x - gap, y - s - gap); 
      ctx.lineTo(x - gap, y - gap);
      ctx.lineTo(x - s - gap, y - gap); 
      ctx.stroke();
    }
    
    // 右上
    if (x < this.PADDING + this.CELL * 7.5) {
      ctx.beginPath();
      ctx.moveTo(x + gap, y - s - gap); 
      ctx.lineTo(x + gap, y - gap);
      ctx.lineTo(x + s + gap, y - gap); 
      ctx.stroke();
    }
    
    // 左下
    if (x > this.PADDING + this.CELL * 0.5) {
      ctx.beginPath();
      ctx.moveTo(x - gap, y + s + gap); 
      ctx.lineTo(x - gap, y + gap);
      ctx.lineTo(x - s - gap, y + gap); 
      ctx.stroke();
    }
    
    // 右下
    if (x < this.PADDING + this.CELL * 7.5) {
      ctx.beginPath();
      ctx.moveTo(x + gap, y + s + gap); 
      ctx.lineTo(x + gap, y + gap);
      ctx.lineTo(x + s + gap, y + gap); 
      ctx.stroke();
    }
  }

  // ── 渲染棋子 ──────────────────────────────────────────────────────────────
  _render() {
    const layer = this.piecesLayer;
    layer.innerHTML = '';

    const P = this.PADDING;
    const C = this.CELL;
    const canControl = this._canControl();

    // 当前选中棋子的合法目标集合
    let hintSet = new Set();
    let hints = [];
    if (this.selected) {
      hints = ChessRules.getValidMoves(this.board, this.selected.r, this.selected.c);
      hints.forEach(([tr, tc]) => hintSet.add(`${tr},${tc}`));
    }

    // 空格提示（无棋子目标）—— 渲染在棋子层之下
    for (const [tr, tc] of hints) {
      if (this.board[tr][tc]) continue; // 有棋子的位置由 capture-overlay 处理
      const div = document.createElement('div');
      div.className = 'move-hint';
      div.style.left = (P + tc * C) + 'px';
      div.style.top  = (P + tr * C) + 'px';
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        this._onHintClick(tr, tc);
      });
      layer.appendChild(div);
    }

    // 渲染棋子
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const piece = this.board[r][c];
        if (!piece) continue;

        const div = document.createElement('div');
        div.className = `chess-piece ${piece.color}`;
        div.style.left = (P + c * C) + 'px';
        div.style.top  = (P + r * C) + 'px';
        div.textContent = this._pieceChar(piece);
        div.dataset.r = r;
        div.dataset.c = c;

        const isOwnPiece = !this.isSpectator && piece.color === this.role;
        if (isOwnPiece) {
          div.classList.add('own');
        } else if (!this.isSpectator) {
          div.classList.add('opponent');
        }
        if (canControl && isOwnPiece) {
          div.classList.add('movable');
        }

        // 选中高亮
        if (this.selected && this.selected.r === r && this.selected.c === c) {
          div.classList.add('selected');
        }
        // 上一步高亮
        if (this.lastMove && (
          (this.lastMove.tr === r && this.lastMove.tc === c) ||
          (this.lastMove.fr === r && this.lastMove.fc === c)
        )) {
          div.classList.add('last-move');
        }
        // 将军高亮
        if (this.checkColor && piece.type === 'K' && piece.color === this.checkColor) {
          div.classList.add('in-check');
        }

        // 若此棋子是合法吃子目标，在棋子上方叠加 capture 遮罩（z-index 高于棋子）
        if (hintSet.has(`${r},${c}`)) {
          div.classList.add('capture-target');
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          this._onPieceClick(r, c);
        });

        layer.appendChild(div);
      }
    }

    this._updateStatusBar();
  }

  _pieceChar(piece) {
    const chars = {
      red:   { K:'帅', A:'仕', B:'相', R:'車', N:'馬', C:'炮', P:'兵' },
      black: { K:'将', A:'士', B:'象', R:'車', N:'马', C:'炮', P:'卒' },
    };
    return (chars[piece.color] && chars[piece.color][piece.type]) || piece.type;
  }

  _updateStatusBar() {
    const dot  = document.getElementById('chTurnDot');
    const text = document.getElementById('chTurnText');
    const check = document.getElementById('chCheckNotice');
    const aiThink = document.getElementById('chAiThinking');
    const cnt  = document.getElementById('chMoveCount');

    if (!dot) return;

    dot.className  = `turn-dot ${this.currentTurn}`;
    const isMyTurn = this.currentTurn === this.role;
    const turnLabel = this.currentTurn === 'red' ? '红方' : '黑方';
    const diffMap = { easy: '简单', normal: '普通', hard: '困难', hell: '地狱' };

    if (this.isSpectator) {
      text.textContent = `${turnLabel}走棋`;
    } else if (this.roomType === 'pv_ai') {
      const aiTurn = this.currentTurn !== this.role;
      const aiLabel = `AI（${diffMap[this.difficulty] || '普通'}）`;
      text.textContent = aiTurn ? `${aiLabel} 走棋` : '你的回合';
    } else {
      text.textContent = isMyTurn ? '你的回合' : `等待${turnLabel}走棋`;
    }

    check.style.display = this.checkColor ? '' : 'none';
    aiThink.classList.toggle('active', false);
    cnt.textContent = `第 ${Math.floor(this.moveCount / 2) + 1} 回合`;
  }

  // ── 重置棋盘（玩家离开/观战时由 room.js 调用） ─────────────────────────────
  reset(reason) {
    this.board = this._createInitialBoard();
    this.selected = null;
    this.currentTurn = 'red';
    this.moveCount = 0;
    this.gameOver = false;
    this.gameStarted = false;
    this.lastMove = null;
    this.checkColor = null;
    this._render();
    if (reason) this._showNotice(reason);
  }

  // ── 人机切换角色（玩家从红方↔黑方，重置游戏）─────────────────────────────
  swapRole() {
    if (this.roomType !== 'pv_ai') return;
    this.role = this.role === 'red' ? 'black' : 'red';
    this.reset();
    // PvAI 始终视为已开始
    this.gameStarted = true;
    // 若玩家执黑，AI（红方）先手
    if (this.currentTurn !== this.role) {
      this._triggerAI();
    }
  }

  // ── 点击处理 ──────────────────────────────────────────────────────────────
  _canControl() {
    // 观战者直接返回 false，不可操作
    if (this.isSpectator) {
      console.log('[Chess] _canControl → spectator mode, cannot control');
      return false;
    }
    
    const result = !(
      this.gameOver || 
      (!this.gameStarted && this.roomType !== 'pv_ai') || 
      this.currentTurn !== this.role
    );
    console.log('[Chess] _canControl check →', 
      'gameOver:', this.gameOver,
      'gameStarted:', this.gameStarted,
      'roomType:', this.roomType,
      'isSpectator:', this.isSpectator,
      'currentTurn:', this.currentTurn,
      'role:', this.role,
      '| canControl:', result);
    return result;
  }

  _onPieceClick(r, c) {
    const piece = this.board[r][c];

    if (!this._canControl()) {
      // 点击己方棋子但无法操作时，显示原因提示
      if (piece && piece.color === this.role && !this.isSpectator) {
        if (this.gameOver) this._showNotice('游戏已结束');
        else if (!this.gameStarted && this.roomType !== 'pv_ai') this._showNotice('等待对手加入...');
        else if (this.currentTurn !== this.role) this._showNotice('等待对方走棋');
      }
      console.log('[Chess] click blocked → gameOver:', this.gameOver,
        'gameStarted:', this.gameStarted, 'roomType:', this.roomType,
        'isSpectator:', this.isSpectator, 'currentTurn:', this.currentTurn,
        'role:', this.role);
      return;
    }

    if (this.selected) {
      // 已选中：判断是否点击了合法目标
      const moves = ChessRules.getValidMoves(this.board, this.selected.r, this.selected.c);
      const isValid = moves.some(([tr, tc]) => tr === r && tc === c);
      if (isValid) {
        this._doMove(this.selected.r, this.selected.c, r, c);
        return;
      }
      // 点击了己方棋子 → 切换选中
      if (piece && piece.color === this.role) {
        this.selected = { r, c };
        this._render();
        return;
      }
      this.selected = null;
      this._render();
      return;
    }

    // 未选中：选择己方棋子
    if (piece && piece.color === this.role) {
      this.selected = { r, c };
      this._render();
    }
  }

  _onHintClick(tr, tc) {
    if (!this.selected) return;
    this._doMove(this.selected.r, this.selected.c, tr, tc);
  }

  _onBoardClick(e) {
    if (!this.selected) return;
    if (e.target !== this.canvas) return;

    // 计算点击坐标对应的棋盘交叉点
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const P = this.PADDING;
    const C = this.CELL;
    const c = Math.round((x - P) / C);
    const r = Math.round((y - P) / C);

    // 超出棋盘范围 → 取消选中
    if (r < 0 || r >= 10 || c < 0 || c >= 9) {
      this.selected = null;
      this._render();
      return;
    }

    // 判断点击位置是否是合法移动目标
    const moves = ChessRules.getValidMoves(this.board, this.selected.r, this.selected.c);
    const isValid = moves.some(([tr, tc]) => tr === r && tc === c);
    if (isValid) {
      this._doMove(this.selected.r, this.selected.c, r, c);
    } else {
      this.selected = null;
      this._render();
    }
  }

  // ── 走棋 ──────────────────────────────────────────────────────────────────
  _doMove(fr, fc, tr, tc) {
    this._applyMove(fr, fc, tr, tc);
    this.selected = null;
    this._render();

    // PvP：发送给对手并带当前局状态供服务端缓存
    if (this.roomType === 'pvp' && typeof this.sendAction === 'function') {
      this.sendAction({
        action: 'move',
        fr, fc, tr, tc,
        game_state: this.getStateSnapshot(),
      });
    }
    // PvAI：同步战局到服务端，供观战者获取最新局面
    if (this.roomType === 'pv_ai' && typeof this.sendAction === 'function') {
      this.sendAction({ action: 'sync_state', game_state: this.getStateSnapshot() });
    }

    // PvAI 模式：触发 AI 走棋
    if (this.roomType === 'pv_ai' && !this.gameOver) {
      this._triggerAI();
    }
  }

  _applyMove(fr, fc, tr, tc) {
    const captured = this.board[tr][tc];
    const movingPiece = this.board[fr][fc];
    
    // 触发移动轨迹特效
    this._createMoveTrail(fr, fc, tr, tc);
    
    // 如果有吃子，触发粒子爆炸效果
    if (captured) {
      this._createCaptureEffect(tr, tc, captured.color);
    }
    
    this.board[tr][tc] = this.board[fr][fc];
    this.board[fr][fc] = null;
    this.lastMove = { fr, fc, tr, tc };
    this.moveCount++;

    // 切换回合
    this.currentTurn = this.currentTurn === 'red' ? 'black' : 'red';

    // 判断将军
    const prevCheckColor = this.checkColor;
    this.checkColor = null;
    if (ChessRules.isInCheck(this.board, 'red'))   this.checkColor = 'red';
    if (ChessRules.isInCheck(this.board, 'black')) this.checkColor = 'black';
    
    // 如果将军，触发震屏效果
    if (this.checkColor && this.checkColor !== prevCheckColor) {
      this._triggerCheckEffect();
    }
    
    // 落子波纹效果
    this._createLandingRipple(tr, tc);

    // 判断将死（无合法走法）
    const nextMoves = ChessRules.getAllMoves(this.board, this.currentTurn);
    if (nextMoves.length === 0) {
      const winner = this.currentTurn === 'red' ? 'black' : 'red';
      this.gameOver = true;
      setTimeout(() => {
        if (typeof this.notifyGameOver === 'function') {
          this.notifyGameOver({
            winner_role: winner,
            message: `${winner === 'red' ? '红方' : '黑方'}获胜！`,
            sub: '对方无法继续走棋',
          });
        }
      }, 300);
    }
  }

  // ── AI 走棋（Web Worker 异步，不阻塞 UI）─────────────────────────────────
  _triggerAI() {
    if (this.currentTurn === this.role) return;
    if (this.gameOver) return;

    const aiEl = document.getElementById('chAiThinking');
    if (aiEl) aiEl.classList.add('active');

    const worker = getChessAIWorker();
    if (!worker) {
      if (aiEl) aiEl.classList.remove('active');
      return;
    }

    const boardCopy = this.board.map(row =>
      row.map(cell => cell ? { type: cell.type, color: cell.color } : null)
    );
    const color = this.currentTurn;
    const difficulty = this.difficulty;

    const delay = { easy: 200, normal: 300, hard: 300, hell: 300 }[difficulty] || 300;

    setTimeout(() => {
      worker.onmessage = (e) => {
        if (aiEl) aiEl.classList.remove('active');
        const mv = e.data.move;
        if (mv && !this.gameOver) {
          this._applyMove(mv.fr, mv.fc, mv.tr, mv.tc);
          this._render();
          if (this.roomType === 'pv_ai' && typeof this.sendAction === 'function') {
            this.sendAction({ action: 'sync_state', game_state: this.getStateSnapshot() });
          }
        }
      };
      worker.onerror = () => {
        if (aiEl) aiEl.classList.remove('active');
      };
      worker.postMessage({ board: boardCopy, color, difficulty });
    }, delay);
  }

  _showNotice(msg) {
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
      animation: notice-appear 0.3s ease-out;
    `;
    div.textContent = msg;
    this.container.querySelector('.chess-wrapper').appendChild(div);
    setTimeout(() => {
      div.style.animation = 'notice-appear 0.3s ease-out reverse';
      setTimeout(() => div.remove(), 300);
    }, 2700);
  }

  // ── 特效方法 ──────────────────────────────────────────────────────────────
  
  /** 创建移动轨迹效果 */
  _createMoveTrail(fr, fc, tr, tc) {
    if (!this.effectsLayer) return;
    
    const P = this.PADDING;
    const C = this.CELL;
    const x1 = P + fc * C;
    const y1 = P + fr * C;
    const x2 = P + tc * C;
    const y2 = P + tr * C;
    
    // 计算距离和角度
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    
    const trail = document.createElement('div');
    trail.className = 'move-trail';
    trail.style.left = x1 + 'px';
    trail.style.top = y1 + 'px';
    trail.style.width = distance + 'px';
    trail.style.transform = `rotate(${angle}deg)`;
    
    this.effectsLayer.appendChild(trail);
    setTimeout(() => trail.remove(), 400);
  }
  
  /** 创建落子波纹效果 */
  _createLandingRipple(r, c) {
    if (!this.effectsLayer) return;
    
    const P = this.PADDING;
    const C = this.CELL;
    const x = P + c * C;
    const y = P + r * C;
    
    // 创建多层波纹
    for (let i = 0; i < 2; i++) {
      setTimeout(() => {
        const ripple = document.createElement('div');
        ripple.className = 'landing-ripple';
        ripple.style.left = x + 'px';
        ripple.style.top = y + 'px';
        this.effectsLayer.appendChild(ripple);
        setTimeout(() => ripple.remove(), 500);
      }, i * 100);
    }
  }
  
  /** 创建吃子粒子爆炸效果 */
  _createCaptureEffect(r, c, capturedColor) {
    if (!this.effectsLayer) return;
    
    const P = this.PADDING;
    const C = this.CELL;
    const x = P + c * C;
    const y = P + r * C;
    
    // 中心闪光
    const flash = document.createElement('div');
    flash.className = 'capture-flash';
    flash.style.left = x + 'px';
    flash.style.top = y + 'px';
    this.effectsLayer.appendChild(flash);
    setTimeout(() => flash.remove(), 350);
    
    // 冲击波
    const shockwave = document.createElement('div');
    shockwave.className = 'capture-shockwave';
    shockwave.style.left = x + 'px';
    shockwave.style.top = y + 'px';
    this.effectsLayer.appendChild(shockwave);
    setTimeout(() => shockwave.remove(), 500);
    
    // 粒子爆炸
    const particleCount = 12;
    for (let i = 0; i < particleCount; i++) {
      this._createParticle(x, y, capturedColor, i, particleCount);
    }
    
    // 火花粒子
    const sparkCount = 8;
    for (let i = 0; i < sparkCount; i++) {
      this._createSparkParticle(x, y, i, sparkCount);
    }
  }
  
  /** 创建单个粒子 */
  _createParticle(x, y, color, index, total) {
    if (!this.effectsLayer) return;
    
    const particle = document.createElement('div');
    particle.className = `particle ${color}`;
    particle.style.left = x + 'px';
    particle.style.top = y + 'px';
    
    // 计算随机方向和距离
    const angle = (index / total) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    const distance = 40 + Math.random() * 50;
    const duration = 400 + Math.random() * 200;
    const targetX = x + Math.cos(angle) * distance;
    const targetY = y + Math.sin(angle) * distance;
    const scale = 0.5 + Math.random() * 0.5;
    
    particle.style.transition = `all ${duration}ms cubic-bezier(0.25, 0.46, 0.45, 0.94)`;
    
    this.effectsLayer.appendChild(particle);
    
    // 强制重绘后开始动画
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        particle.style.left = targetX + 'px';
        particle.style.top = targetY + 'px';
        particle.style.transform = `translate(-50%, -50%) scale(${scale})`;
        particle.style.opacity = '0';
      });
    });
    
    setTimeout(() => particle.remove(), duration + 50);
  }
  
  /** 创建火花粒子 */
  _createSparkParticle(x, y, index, total) {
    if (!this.effectsLayer) return;
    
    const spark = document.createElement('div');
    spark.className = 'particle spark';
    spark.style.left = x + 'px';
    spark.style.top = y + 'px';
    
    const angle = (index / total) * Math.PI * 2 + Math.random() * 0.3;
    const distance = 60 + Math.random() * 40;
    const duration = 300 + Math.random() * 150;
    const targetX = x + Math.cos(angle) * distance;
    const targetY = y + Math.sin(angle) * distance - 20; // 稍微上浮
    
    spark.style.transition = `all ${duration}ms ease-out`;
    
    this.effectsLayer.appendChild(spark);
    
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        spark.style.left = targetX + 'px';
        spark.style.top = targetY + 'px';
        spark.style.opacity = '0';
      });
    });
    
    setTimeout(() => spark.remove(), duration + 50);
  }
  
  /** 将军震屏效果 */
  _triggerCheckEffect() {
    const wrapper = this.container.querySelector('.chess-wrapper');
    if (wrapper) {
      wrapper.classList.add('shake');
      setTimeout(() => wrapper.classList.remove('shake'), 400);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ChessRules — 象棋规则引擎（纯函数，无副作用）
// ══════════════════════════════════════════════════════════════════════════════
const ChessRules = (function () {
  'use strict';

  function inBoard(r, c) { return r >= 0 && r < 10 && c >= 0 && c < 9; }

  // 获取某位置棋子的所有候选移动（不考虑自将）
  function getCandidates(board, r, c) {
    const piece = board[r][c];
    if (!piece) return [];
    const { type, color } = piece;
    const isRed = color === 'red';
    const moves = [];

    switch (type) {
      case 'K': { // 将/帅，在九宫内一格
        const palace = isRed
          ? [[7,3],[7,4],[7,5],[8,3],[8,4],[8,5],[9,3],[9,4],[9,5]]
          : [[0,3],[0,4],[0,5],[1,3],[1,4],[1,5],[2,3],[2,4],[2,5]];
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nr = r+dr, nc = c+dc;
          if (palace.some(([pr,pc]) => pr===nr && pc===nc)) {
            const t = board[nr][nc];
            if (!t || t.color !== color) moves.push([nr, nc]);
          }
        }
        // 将帅对脸
        const dir = isRed ? -1 : 1;
        for (let nr = r+dir; inBoard(nr, c); nr += dir) {
          const t = board[nr][c];
          if (t) {
            if (t.type === 'K' && t.color !== color) moves.push([nr, c]);
            break;
          }
        }
        break;
      }
      case 'A': { // 士/仕，斜走一格，在九宫内
        const palaceA = isRed
          ? [[7,3],[7,5],[8,4],[9,3],[9,5]]
          : [[0,3],[0,5],[1,4],[2,3],[2,5]];
        for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
          const nr = r+dr, nc = c+dc;
          if (palaceA.some(([pr,pc]) => pr===nr && pc===nc)) {
            const t = board[nr][nc];
            if (!t || t.color !== color) moves.push([nr, nc]);
          }
        }
        break;
      }
      case 'B': { // 象/相，田字走，不能过河，脚不被绊
        const riverLimit = isRed ? 5 : 4;
        for (const [dr, dc] of [[-2,-2],[-2,2],[2,-2],[2,2]]) {
          const nr = r+dr, nc = c+dc;
          const mr = r+dr/2, mc = c+dc/2;
          if (!inBoard(nr,nc)) continue;
          if (isRed && nr < riverLimit) continue;
          if (!isRed && nr >= riverLimit) continue;
          if (board[mr][mc]) continue; // 象眼被塞
          const t = board[nr][nc];
          if (!t || t.color !== color) moves.push([nr, nc]);
        }
        break;
      }
      case 'N': { // 马，日字走，腿不被绊
        const knightMoves = [
          [-2,-1,[-1,0]],[-2,1,[-1,0]],
          [2,-1,[1,0]],[2,1,[1,0]],
          [-1,-2,[0,-1]],[-1,2,[0,1]],
          [1,-2,[0,-1]],[1,2,[0,1]],
        ];
        for (const [dr, dc, [lr, lc]] of knightMoves) {
          const nr = r+dr, nc = c+dc;
          const legR = r+lr, legC = c+lc;
          if (!inBoard(nr,nc)) continue;
          if (board[legR][legC]) continue; // 腿被绊
          const t = board[nr][nc];
          if (!t || t.color !== color) moves.push([nr, nc]);
        }
        break;
      }
      case 'R': { // 車，直线走，不能跨越棋子
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          for (let nr=r+dr, nc=c+dc; inBoard(nr,nc); nr+=dr, nc+=dc) {
            const t = board[nr][nc];
            if (!t) { moves.push([nr, nc]); continue; }
            if (t.color !== color) moves.push([nr, nc]);
            break;
          }
        }
        break;
      }
      case 'C': { // 炮，直线走，隔子吃
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          let jumped = false;
          for (let nr=r+dr, nc=c+dc; inBoard(nr,nc); nr+=dr, nc+=dc) {
            const t = board[nr][nc];
            if (!jumped) {
              if (!t) { moves.push([nr, nc]); continue; }
              jumped = true;
            } else {
              if (t) {
                if (t.color !== color) moves.push([nr, nc]);
                break;
              }
            }
          }
        }
        break;
      }
      case 'P': { // 兵/卒
        const forward = isRed ? -1 : 1;
        const crossed = isRed ? r < 5 : r >= 5; // 是否已过河
        // 前进
        const nr = r+forward, nc = c;
        if (inBoard(nr,nc)) {
          const t = board[nr][nc];
          if (!t || t.color !== color) moves.push([nr, nc]);
        }
        // 过河后可以横走
        if (crossed) {
          for (const dc of [-1, 1]) {
            const nc2 = c+dc;
            if (inBoard(r,nc2)) {
              const t = board[r][nc2];
              if (!t || t.color !== color) moves.push([r, nc2]);
            }
          }
        }
        break;
      }
    }
    return moves;
  }

  // 判断颜色方的将是否被将军
  function isInCheck(board, color) {
    // 找到将/帅位置
    let kr = -1, kc = -1;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = board[r][c];
        if (p && p.type === 'K' && p.color === color) { kr=r; kc=c; break; }
      }
      if (kr >= 0) break;
    }
    if (kr < 0) return true; // 将已被吃，视为被将军

    const opp = color === 'red' ? 'black' : 'red';
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = board[r][c];
        if (!p || p.color !== opp) continue;
        const cands = getCandidates(board, r, c);
        if (cands.some(([mr,mc]) => mr===kr && mc===kc)) return true;
      }
    }
    return false;
  }

  // 获取合法走法（排除走后自将）
  function getValidMoves(board, r, c) {
    const piece = board[r][c];
    if (!piece) return [];
    const color = piece.color;
    const candidates = getCandidates(board, r, c);
    const valid = [];
    for (const [tr, tc] of candidates) {
      const captured = board[tr][tc];
      board[tr][tc] = piece;
      board[r][c] = null;
      if (!isInCheck(board, color)) valid.push([tr, tc]);
      board[r][c] = piece;
      board[tr][tc] = captured;
    }
    return valid;
  }

  // 获取某颜色所有合法走法（供 AI 使用）
  function getAllMoves(board, color) {
    const all = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = board[r][c];
        if (!p || p.color !== color) continue;
        for (const [tr, tc] of getValidMoves(board, r, c)) {
          all.push({ fr: r, fc: c, tr, tc });
        }
      }
    }
    return all;
  }

  return { getCandidates, isInCheck, getValidMoves, getAllMoves };
})();

window.ChessGameAdapter = ChessGameAdapter;
window.ChessRules = ChessRules;
