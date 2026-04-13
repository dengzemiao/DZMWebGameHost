/**
 * color-lines/game.js — 超级方块（Color Lines）GameAdapter 实现
 * 通过 ColorLinesGameAdapter 与 room.js 标准接口对接
 */
(function () {
  'use strict';

  // ── 常量 ──────────────────────────────────────────────────────────────────
  const BOARD_SIZE = 9;

  // 难度配置：{ 颜色数, 每回合新增, 初始方块数 }
  const DIFFICULTY_CFG = {
    easy:   { colors: 5, spawn: 2, initial: 5 },
    normal: { colors: 7, spawn: 3, initial: 7 },
    hard:   { colors: 8, spawn: 4, initial: 9 },
    hell:   { colors: 9, spawn: 5, initial: 12 },
  };

  const DIFFICULTY_LABELS = {
    easy:   { label: '简单', css: 'cl-diff-easy' },
    normal: { label: '普通', css: 'cl-diff-normal' },
    hard:   { label: '困难', css: 'cl-diff-hard' },
    hell:   { label: '地狱', css: 'cl-diff-hell' },
  };

  const MIN_LINE = 5; // 最少消除数

  // ── 工具函数 ──────────────────────────────────────────────────────────────
  function idx(r, c) { return r * BOARD_SIZE + c; }
  function rowCol(i) { return [Math.floor(i / BOARD_SIZE), i % BOARD_SIZE]; }

  // BFS 寻路：返回路径数组 [{r,c},...] 或 null
  function bfs(board, sr, sc, tr, tc) {
    if (sr === tr && sc === tc) return [];
    if (board[idx(tr, tc)] !== -1) return null;

    const visited = new Uint8Array(81);
    const prev = new Int8Array(81).fill(-1);
    const queue = [idx(sr, sc)];
    visited[idx(sr, sc)] = 1;

    const dirs = [[0,1],[0,-1],[1,0],[-1,0]];

    while (queue.length) {
      const cur = queue.shift();
      const [cr, cc] = rowCol(cur);
      for (const [dr, dc] of dirs) {
        const nr = cr + dr, nc = cc + dc;
        if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
        const ni = idx(nr, nc);
        if (visited[ni]) continue;
        // 目标格可以走（即使有球也是目标），中间格必须空
        if (ni !== idx(tr, tc) && board[ni] !== -1) continue;
        visited[ni] = 1;
        prev[ni] = cur;
        if (nr === tr && nc === tc) {
          // 回溯路径
          const path = [];
          let p = ni;
          while (p !== idx(sr, sc)) {
            path.unshift(rowCol(p));
            p = prev[p];
          }
          return path;
        }
        queue.push(ni);
      }
    }
    return null;
  }

  // 检测消除：返回需要消除的索引集合
  function checkLines(board) {
    const toRemove = new Set();
    const directions = [[0,1],[1,0],[1,1],[1,-1]]; // 横 竖 斜↘ 斜↙

    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const color = board[idx(r, c)];
        if (color === -1) continue;
        for (const [dr, dc] of directions) {
          const line = [idx(r, c)];
          let nr = r + dr, nc = c + dc;
          while (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[idx(nr, nc)] === color) {
            line.push(idx(nr, nc));
            nr += dr;
            nc += dc;
          }
          if (line.length >= MIN_LINE) {
            line.forEach(i => toRemove.add(i));
          }
        }
      }
    }
    return toRemove;
  }

  // ── ColorLinesGameAdapter ──────────────────────────────────────────────────
  class ColorLinesGameAdapter {
    constructor(container, config) {
      this.container = container;
      this.role = config.role;
      this.roomType = config.roomType;
      this.mySessionId = config.mySessionId;
      this.isSpectator = config.isSpectator;

      // 游戏状态
      this.board = new Int8Array(81).fill(-1); // -1=空, 0..8=颜色
      this.score = 0;
      this.difficulty = 'easy';
      this.gameActive = false;
      this.gameOver = false;
      this.selectedCell = -1; // 选中的方块索引
      this.nextColors = []; // 下一回合将出现的颜色预告
      this.isAnimating = false;

      // DOM
      this._wrapper = null;
      this._statusBar = null;
      this._gameArea = null;
      this._boardEl = null;
      this._cells = []; // DOM cell 元素数组

      // 回调
      this.sendAction = null;
      this.sendMessage = null;
      this.notifyGameOver = null;

      this._viewState = 'waiting'; // 'waiting' | 'syncing' | 'game'
      this._resizeHandler = null;
    }

    // ── 公共接口 ──────────────────────────────────────────────────────────────

    init() {
      this._buildDOM();
      this._resizeHandler = () => this._onResize();
      window.addEventListener('resize', this._resizeHandler);
      this._renderWaiting();
    }

    onGameStart(room) {
      if (room && room.state === 'playing') {
        this._showSyncing();
      }
    }

    onGameStarted(data) {
      this.difficulty = data.difficulty || 'easy';
      this._startGame();
    }

    onRemoteAction(data) {
      // 观战者接收玩家操作
      if (data.action === 'cl_state_sync') {
        this._applySyncState(data);
      }
    }

    reset() {
      this.board.fill(-1);
      this.score = 0;
      this.gameActive = false;
      this.gameOver = false;
      this.selectedCell = -1;
      this.nextColors = [];
      this.isAnimating = false;
      this._viewState = 'waiting';
      this._renderWaiting();
    }

    restoreGameState(state) {
      if (state && state.cl_board) {
        this._applySyncState(state);
      }
    }

    _render() {
      if (this._viewState === 'waiting') {
        this._renderWaiting();
      } else if (this._viewState === 'game') {
        this._renderBoard();
        this._updateStatusBar();
      }
    }

    // ── DOM 构建 ──────────────────────────────────────────────────────────────

    _buildDOM() {
      this.container.innerHTML = '';
      this._wrapper = document.createElement('div');
      this._wrapper.className = 'cl-wrapper';

      this._statusBar = document.createElement('div');
      this._statusBar.className = 'cl-status-bar';
      this._statusBar.style.display = 'none';

      this._gameArea = document.createElement('div');
      this._gameArea.className = 'cl-game-area';

      this._wrapper.appendChild(this._statusBar);
      this._wrapper.appendChild(this._gameArea);
      this.container.appendChild(this._wrapper);
    }

    _onResize() {
      if (this._viewState === 'game' && this._boardEl) {
        this._calcBoardSize();
      }
    }

    // ── 视图：等待页 ──────────────────────────────────────────────────────────

    _renderWaiting() {
      this._viewState = 'waiting';
      this._statusBar.style.display = 'none';
      this._gameArea.innerHTML = '';

      const div = document.createElement('div');
      div.className = 'cl-waiting';

      const isHost = this.role === 'player1';
      const diffRows = isHost ? Object.entries(DIFFICULTY_LABELS).map(([key, info]) => `
        <button class="cl-diff-btn${this.difficulty === key ? ' active' : ''}" data-diff="${key}">
          <span class="cl-diff-label-text">${info.label}</span>
          <span class="cl-diff-size-text">${DIFFICULTY_CFG[key].colors}色${DIFFICULTY_CFG[key].spawn}增</span>
        </button>`).join('') : '';

      div.innerHTML = `
        <div class="cl-waiting-icon">🟦</div>
        <div class="cl-waiting-title">超级方块</div>
        <div class="cl-waiting-desc">${isHost ? '选择难度，然后开始游戏' : '等待房主开始游戏…'}</div>
        ${isHost ? `
          <div class="cl-diff-wrap">
            <div class="cl-diff-row" id="clDiffRow">${diffRows}</div>
          </div>
          <button class="cl-start-btn" id="clStartBtn">开始游戏</button>` : ''}`;

      this._gameArea.appendChild(div);

      if (isHost) {
        document.getElementById('clDiffRow').addEventListener('click', (e) => {
          const btn = e.target.closest('.cl-diff-btn');
          if (!btn) return;
          this.difficulty = btn.dataset.diff;
          document.querySelectorAll('#clDiffRow .cl-diff-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
        document.getElementById('clStartBtn').addEventListener('click', () => {
          if (this.sendMessage) this.sendMessage({ type: 'start_game', difficulty: this.difficulty });
        });
      }
    }

    _showSyncing() {
      this._viewState = 'syncing';
      this._statusBar.style.display = 'none';
      this._gameArea.innerHTML = `
        <div class="cl-waiting">
          <div class="cl-waiting-icon">⏳</div>
          <div class="cl-waiting-title">同步中…</div>
          <div class="cl-waiting-desc">正在获取当前局状态，请稍候</div>
        </div>`;
    }

    // ── 游戏开始 ──────────────────────────────────────────────────────────────

    _startGame() {
      const cfg = DIFFICULTY_CFG[this.difficulty] || DIFFICULTY_CFG.easy;
      this.board.fill(-1);
      this.score = 0;
      this.gameActive = true;
      this.gameOver = false;
      this.selectedCell = -1;
      this.isAnimating = false;

      this._viewState = 'game';
      this._statusBar.style.display = '';
      this._gameArea.innerHTML = '';

      // 创建棋盘
      this._boardEl = document.createElement('div');
      this._boardEl.className = 'cl-board';
      this._cells = [];

      for (let i = 0; i < 81; i++) {
        const cell = document.createElement('div');
        cell.className = 'cl-cell';
        cell.dataset.idx = i;
        cell.addEventListener('click', () => this._onCellClick(i));
        this._boardEl.appendChild(cell);
        this._cells.push(cell);
      }

      this._gameArea.appendChild(this._boardEl);
      this._calcBoardSize();
      this._updateStatusBar();

      // 如果是观战者，不生成初始方块（等待同步）
      if (this.isSpectator) {
        this._gameArea.insertAdjacentHTML('afterbegin',
          '<div class="cl-spectator-info">👁 观战中</div>');
        return;
      }

      // 生成初始方块
      this._spawnBalls(cfg.initial);
      // 预告下一回合颜色
      this._generateNextColors();
      this._renderBoard();
      this._broadcastState();
    }

    // ── 棋盘尺寸计算 ──────────────────────────────────────────────────────────

    _calcBoardSize() {
      if (!this._boardEl || !this._gameArea) return;
      const GAP = 2;
      const PADDING = 4;
      const W = this._gameArea.clientWidth || 300;
      const H = this._gameArea.clientHeight || 400;
      const avail = Math.min(W - 16, H - 16) - PADDING * 2 - GAP * (BOARD_SIZE - 1);
      let cellSize = Math.floor(avail / BOARD_SIZE);
      cellSize = Math.max(24, Math.min(60, cellSize));

      this._boardEl.style.setProperty('--cl-cell', cellSize + 'px');
      const total = cellSize * BOARD_SIZE + GAP * (BOARD_SIZE - 1) + PADDING * 2;
      this._boardEl.style.width = total + 'px';
      this._boardEl.style.height = total + 'px';
    }

    // ── 状态栏更新 ──────────────────────────────────────────────────────────

    _updateStatusBar() {
      const cfg = DIFFICULTY_CFG[this.difficulty] || DIFFICULTY_CFG.easy;
      const diffInfo = DIFFICULTY_LABELS[this.difficulty] || DIFFICULTY_LABELS.easy;

      let nextHtml = '';
      if (this.nextColors.length > 0 && !this.isSpectator) {
        const balls = this.nextColors.map(c => `<div class="cl-next-ball cl-ball c${c}" style="width:16px;height:16px;position:static;box-shadow:none"></div>`).join('');
        nextHtml = `<div class="cl-next-hint"><span>下一组:</span><div class="cl-next-balls">${balls}</div></div>`;
      }

      this._statusBar.innerHTML = `
        <div><span class="cl-score-label">得分</span> <span class="cl-score">${this.score}</span></div>
        <span class="cl-diff-label ${diffInfo.css}">${diffInfo.label}</span>
        ${nextHtml}`;
    }

    // ── 棋盘渲染 ──────────────────────────────────────────────────────────────

    _renderBoard() {
      for (let i = 0; i < 81; i++) {
        const cell = this._cells[i];
        const color = this.board[i];

        // 清除旧内容
        const oldBall = cell.querySelector('.cl-ball');

        cell.classList.toggle('selected-cell', i === this.selectedCell);

        if (color === -1) {
          if (oldBall) oldBall.remove();
        } else {
          if (oldBall) {
            // 更新颜色
            oldBall.className = `cl-ball c${color}`;
            if (i === this.selectedCell) oldBall.classList.add('selected');
          } else {
            const ball = document.createElement('div');
            ball.className = `cl-ball c${color}`;
            if (i === this.selectedCell) ball.classList.add('selected');
            cell.appendChild(ball);
          }
        }
      }
    }

    // ── 交互 ──────────────────────────────────────────────────────────────────

    _onCellClick(i) {
      if (!this.gameActive || this.gameOver || this.isSpectator || this.isAnimating) return;

      const color = this.board[i];
      const [r, c] = rowCol(i);

      if (color !== -1) {
        // 点击了一个有方块的格子 → 选中
        this.selectedCell = i;
        this._renderBoard();
        return;
      }

      // 点击了空格子
      if (this.selectedCell === -1) return;

      const [sr, sc] = rowCol(this.selectedCell);
      const path = bfs(this.board, sr, sc, r, c);
      if (!path) return; // 无法到达

      // 执行移动
      this.isAnimating = true;
      const movedColor = this.board[this.selectedCell];
      this.board[this.selectedCell] = -1;
      this.board[i] = movedColor;
      this.selectedCell = -1;

      // 渲染移动结果
      this._renderBoard();

      // 检测消除
      const removed = checkLines(this.board);
      if (removed.size > 0) {
        this._animateRemove(removed, () => {
          this._updateStatusBar();
          this._broadcastState();
          this.isAnimating = false;
        });
      } else {
        // 未消除 → 新增方块
        const spawned = this._spawnBalls((DIFFICULTY_CFG[this.difficulty] || DIFFICULTY_CFG.easy).spawn);
        this._renderBoard();

        // 新增后检测消除
        const removed2 = checkLines(this.board);
        if (removed2.size > 0) {
          this._animateRemove(removed2, () => {
            this._generateNextColors();
            this._updateStatusBar();
            this._broadcastState();
            this.isAnimating = false;
          });
        } else {
          // 动画显示新增方块
          this._animateAppear(spawned, () => {
            this._generateNextColors();
            this._updateStatusBar();
            this._broadcastState();
            this.isAnimating = false;

            // 检查游戏是否结束
            if (this._isGameOver()) {
              this._showGameOver();
            }
          });
        }
      }
    }

    // ── 游戏逻辑 ──────────────────────────────────────────────────────────────

    _spawnBalls(count) {
      const cfg = DIFFICULTY_CFG[this.difficulty] || DIFFICULTY_CFG.easy;
      const empties = [];
      for (let i = 0; i < 81; i++) {
        if (this.board[i] === -1) empties.push(i);
      }

      const spawned = [];
      const actualCount = Math.min(count, empties.length);

      // 使用预告颜色（如果有）
      for (let k = 0; k < actualCount; k++) {
        const ri = Math.floor(Math.random() * empties.length);
        const pos = empties.splice(ri, 1)[0];
        const color = this.nextColors[k] !== undefined
          ? this.nextColors[k]
          : Math.floor(Math.random() * cfg.colors);
        this.board[pos] = color;
        spawned.push(pos);
      }

      return spawned;
    }

    _generateNextColors() {
      const cfg = DIFFICULTY_CFG[this.difficulty] || DIFFICULTY_CFG.easy;
      this.nextColors = [];
      for (let i = 0; i < cfg.spawn; i++) {
        this.nextColors.push(Math.floor(Math.random() * cfg.colors));
      }
    }

    _isGameOver() {
      for (let i = 0; i < 81; i++) {
        if (this.board[i] === -1) return false;
      }
      return true;
    }

    _calcRemoveScore(count) {
      // 5个=10分，6个=15分，每多1个加5分
      if (count < MIN_LINE) return 0;
      return 10 + (count - MIN_LINE) * 5;
    }

    // ── 动画 ──────────────────────────────────────────────────────────────────

    _animateRemove(removedSet, callback) {
      const score = this._calcRemoveScore(removedSet.size);
      this.score += score;

      removedSet.forEach(i => {
        const ball = this._cells[i].querySelector('.cl-ball');
        if (ball) ball.classList.add('removing');
      });

      setTimeout(() => {
        removedSet.forEach(i => {
          this.board[i] = -1;
        });
        this._renderBoard();
        if (callback) callback();
      }, 350);
    }

    _animateAppear(indices, callback) {
      this._renderBoard();
      indices.forEach(i => {
        const ball = this._cells[i].querySelector('.cl-ball');
        if (ball) ball.classList.add('appear');
      });
      setTimeout(() => {
        if (callback) callback();
      }, 300);
    }

    // ── 游戏结束 ──────────────────────────────────────────────────────────────

    _showGameOver() {
      this.gameOver = true;
      this.gameActive = false;

      const isHost = this.role === 'player1';

      const overlay = document.createElement('div');
      overlay.className = 'cl-gameover-overlay';
      overlay.innerHTML = `
        <div class="cl-gameover-icon">🏆</div>
        <div class="cl-gameover-title">游戏结束</div>
        <div class="cl-gameover-score">最终得分：<strong>${this.score}</strong></div>
        ${isHost ? '<button class="cl-replay-btn" id="clReplayBtn">再来一局</button>' : ''}`;

      this._gameArea.appendChild(overlay);

      if (isHost) {
        document.getElementById('clReplayBtn').addEventListener('click', () => {
          if (this.sendMessage) this.sendMessage({ type: 'restart_game' });
        });
      }

      // 广播最终状态
      this._broadcastState();
    }

    // ── 状态同步 ──────────────────────────────────────────────────────────────

    _broadcastState() {
      if (this.isSpectator) return;
      if (!this.sendAction) return;

      const state = {
        action: 'cl_state_sync',
        cl_board: Array.from(this.board),
        cl_score: this.score,
        cl_difficulty: this.difficulty,
        cl_game_over: this.gameOver,
        cl_next_colors: this.nextColors,
        game_state: {
          cl_board: Array.from(this.board),
          cl_score: this.score,
          cl_difficulty: this.difficulty,
          cl_game_over: this.gameOver,
          cl_next_colors: this.nextColors,
        }
      };
      this.sendAction(state);
    }

    _applySyncState(data) {
      if (data.cl_board) {
        for (let i = 0; i < 81; i++) {
          this.board[i] = data.cl_board[i] !== undefined ? data.cl_board[i] : -1;
        }
      }
      this.score = data.cl_score || 0;
      this.difficulty = data.cl_difficulty || this.difficulty;
      this.gameOver = !!data.cl_game_over;
      this.nextColors = data.cl_next_colors || [];
      this.gameActive = !this.gameOver;

      // 确保在游戏视图
      if (this._viewState !== 'game') {
        this._viewState = 'game';
        this._statusBar.style.display = '';
        this._gameArea.innerHTML = '';

        this._boardEl = document.createElement('div');
        this._boardEl.className = 'cl-board';
        this._cells = [];

        for (let i = 0; i < 81; i++) {
          const cell = document.createElement('div');
          cell.className = 'cl-cell';
          cell.dataset.idx = i;
          cell.addEventListener('click', () => this._onCellClick(i));
          this._boardEl.appendChild(cell);
          this._cells.push(cell);
        }

        this._gameArea.appendChild(this._boardEl);

        if (this.isSpectator) {
          this._gameArea.insertAdjacentHTML('afterbegin',
            '<div class="cl-spectator-info">👁 观战中</div>');
        }

        this._calcBoardSize();
      }

      this._renderBoard();
      this._updateStatusBar();

      // 如果游戏结束，显示结束叠加
      if (this.gameOver) {
        const existing = this._gameArea.querySelector('.cl-gameover-overlay');
        if (!existing) {
          const overlay = document.createElement('div');
          overlay.className = 'cl-gameover-overlay';
          overlay.innerHTML = `
            <div class="cl-gameover-icon">🏆</div>
            <div class="cl-gameover-title">游戏结束</div>
            <div class="cl-gameover-score">最终得分：<strong>${this.score}</strong></div>`;
          this._gameArea.appendChild(overlay);
        }
      }
    }
  }

  // 挂载到全局
  window.ColorLinesGameAdapter = ColorLinesGameAdapter;
})();
