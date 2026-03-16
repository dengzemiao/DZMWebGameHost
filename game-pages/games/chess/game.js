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

// 动态加载 AI 脚本（ai.js 与 game.js 同目录）
(function loadAI() {
  if (window.ChessAI) return;
  const s = document.createElement('script');
  s.src = 'games/chess/ai.js';
  document.head.appendChild(s);
})();

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
    this.CELL         = 54;     // 格子像素大小
    this.PADDING      = 28;     // 棋盘内边距
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────
  init() {
    this.board = this._createInitialBoard();
    this._buildDOM();
    this._render();
  }

  onGameStart(roomData) {
    this.gameStarted = true;
    this._render();
    if (this.roomType === 'pv_ai' && this.role === 'black') {
      // 黑方是 AI 且红方先走，不需要 AI 立即行动
    }
  }

  onRemoteAction(data) {
    if (data.action === 'move') {
      const { fr, fc, tr, tc } = data;
      this._applyMove(fr, fc, tr, tc);
      this._render();
    }
  }

  onOpponentLeave() {
    this._showNotice('对手已离开房间');
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
            </div>
          </div>
        </div>
      </div>`;

    this.canvas     = this.container.querySelector('#chCanvas');
    this.piecesLayer = this.container.querySelector('#chPieces');

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

    ctx.strokeStyle = 'rgba(80,50,10,0.7)';
    ctx.lineWidth = 1;

    // 外框
    ctx.strokeRect(P, P, W, H);

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
    const markPos = [
      [2,1],[2,7],[7,1],[7,7],
      [3,0],[3,2],[3,4],[3,6],[3,8],
      [6,0],[6,2],[6,4],[6,6],[6,8],
    ];
    for (const [r, c] of markPos) {
      this._drawMark(ctx, P + c*C, P + r*C);
    }

    // 河界文字
    ctx.save();
    ctx.font = '16px STKaiti, KaiTi, serif';
    ctx.fillStyle = 'rgba(80,50,10,0.5)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('楚 河', P + 2 * C, P + 4.5 * C);
    ctx.fillText('汉 界', P + 6 * C, P + 4.5 * C);
    ctx.restore();
  }

  _drawMark(ctx, x, y) {
    const s = 4;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s * 2); ctx.lineTo(x - s, y - s);
    ctx.lineTo(x - s * 2, y - s); ctx.moveTo(x - s, y - s); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + s, y - s * 2); ctx.lineTo(x + s, y - s);
    ctx.lineTo(x + s * 2, y - s); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - s, y + s * 2); ctx.lineTo(x - s, y + s);
    ctx.lineTo(x - s * 2, y + s); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + s, y + s * 2); ctx.lineTo(x + s, y + s);
    ctx.lineTo(x + s * 2, y + s); ctx.stroke();
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

        // 可走子：己方棋子且当前可控制 → 添加 movable 类（显示手型游标和 hover 效果）
        if (canControl && piece.color === this.role) {
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
    const diffMap = { easy: '简单', normal: '普通', hard: '困难' };

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

  // ── 人机切换角色（玩家从红方↔黑方，重置游戏）─────────────────────────────
  swapRole() {
    if (this.roomType !== 'pv_ai') return;
    this.role = this.role === 'red' ? 'black' : 'red';
    this.board = this._createInitialBoard();
    this.selected = null;
    this.currentTurn = 'red';
    this.moveCount = 0;
    this.gameOver = false;
    this.lastMove = null;
    this.checkColor = null;
    this._render();
    // 若玩家执黑，AI（红方）先手
    if (this.currentTurn !== this.role) {
      this._triggerAI();
    }
  }

  // ── 点击处理 ──────────────────────────────────────────────────────────────
  _canControl() {
    if (this.gameOver) return false;
    if (!this.gameStarted && this.roomType !== 'pv_ai') return false;
    if (this.isSpectator) return false;
    if (this.currentTurn !== this.role) return false;
    return true;
  }

  _onPieceClick(r, c) {
    if (!this._canControl()) return;

    const piece = this.board[r][c];

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

    // 发送给对手（PvP）
    if (this.roomType === 'pvp' && typeof this.sendAction === 'function') {
      this.sendAction({ action: 'move', fr, fc, tr, tc });
    }

    // PvAI 模式：触发 AI 走棋
    if (this.roomType === 'pv_ai' && !this.gameOver) {
      this._triggerAI();
    }
  }

  _applyMove(fr, fc, tr, tc) {
    const captured = this.board[tr][tc];
    this.board[tr][tc] = this.board[fr][fc];
    this.board[fr][fc] = null;
    this.lastMove = { fr, fc, tr, tc };
    this.moveCount++;

    // 切换回合
    this.currentTurn = this.currentTurn === 'red' ? 'black' : 'red';

    // 判断将军
    this.checkColor = null;
    if (ChessRules.isInCheck(this.board, 'red'))   this.checkColor = 'red';
    if (ChessRules.isInCheck(this.board, 'black')) this.checkColor = 'black';

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

  // ── AI 走棋 ──────────────────────────────────────────────────────────────
  _triggerAI() {
    if (this.currentTurn === this.role) return; // 还是玩家回合
    if (this.gameOver) return;

    // 显示 AI 思考
    const aiEl = document.getElementById('chAiThinking');
    if (aiEl) aiEl.classList.add('active');

    // 延迟执行，让 UI 有时间更新
    const delay = { easy: 300, normal: 500, hard: 800 }[this.difficulty] || 500;
    setTimeout(() => {
      if (!window.ChessAI) {
        if (aiEl) aiEl.classList.remove('active');
        return;
      }
      const mv = ChessAI.bestMove(
        this.board,
        this.currentTurn,
        this.difficulty,
        ChessRules
      );
      if (aiEl) aiEl.classList.remove('active');
      if (mv && !this.gameOver) {
        this._applyMove(mv.fr, mv.fc, mv.tr, mv.tc);
        this._render();
      }
    }, delay);
  }

  _showNotice(msg) {
    const div = document.createElement('div');
    div.style.cssText = `
      position:absolute; top:50%; left:50%;
      transform:translate(-50%,-50%);
      background:rgba(0,0,0,.8); color:#fff;
      padding:12px 24px; border-radius:8px;
      font-size:15px; font-weight:600; z-index:100;
      pointer-events:none;
    `;
    div.textContent = msg;
    this.container.querySelector('.chess-wrapper').appendChild(div);
    setTimeout(() => div.remove(), 3000);
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
