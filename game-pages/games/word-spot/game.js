/**
 * word-spot/game.js — 文字找茬游戏前端实现
 * 通过 WordSpotGameAdapter 与 room.js 标准接口对接
 */
(function () {
  'use strict';

  // ── 汉字易混淆对数据库（每组格式：[主字, 备选1]）────────────────────────
  const CHAR_PAIRS = [
    // 一画差
    ['人', '入'], ['入', '八'], ['八', '人'],
    ['土', '士'], ['士', '土'], ['干', '千'], ['千', '干'],
    ['末', '未'], ['未', '末'], ['大', '太'], ['太', '犬'], ['犬', '大'],
    ['目', '日'], ['日', '曰'], ['曰', '日'], ['口', '囗'],
    ['厂', '广'], ['广', '厂'], ['力', '刀'], ['刀', '刃'],
    ['己', '已'], ['已', '巳'], ['己', '巳'],
    ['甲', '由'], ['由', '申'], ['申', '甲'],
    ['旦', '早'], ['早', '旦'], ['苗', '田'], ['田', '苗'],
    // 笔画形近
    ['折', '拆'], ['拆', '折'], ['徒', '徙'], ['徙', '徒'],
    ['酒', '洒'], ['洒', '酒'], ['沐', '木'], ['木', '沐'],
    ['戊', '戌'], ['戌', '戍'], ['戍', '戊'], ['戎', '戊'],
    ['冉', '再'], ['再', '冉'], ['仑', '仓'], ['仓', '仑'],
    ['旦', '旭'], ['斤', '斤'],
    ['贝', '见'], ['见', '贝'], ['又', '叉'], ['叉', '又'],
    ['向', '问'], ['问', '向'], ['爪', '瓜'], ['瓜', '爪'],
    ['生', '牛'], ['牛', '午'], ['午', '牛'],
    ['毛', '手'], ['手', '毛'], ['弓', '与'], ['与', '弓'],
    ['马', '鸟'], ['鸟', '马'], ['亡', '忘'], ['忘', '亡'],
    ['兑', '说'], ['冈', '岗'], ['岗', '冈'],
    ['乃', '及'], ['及', '乃'], ['夫', '天'], ['天', '夫'],
    ['止', '正'], ['正', '止'], ['凡', '几'], ['几', '凡'],
    ['壬', '王'], ['王', '壬'], ['卯', '卵'], ['卵', '卯'],
    ['兔', '免'], ['免', '兔'], ['象', '像'], ['像', '象'],
    ['度', '渡'], ['渡', '度'], ['崇', '祟'], ['祟', '崇'],
    ['武', '式'], ['式', '武'], ['拔', '拨'], ['拨', '拔'],
    ['侯', '候'], ['候', '侯'],
    // 结构相近
    ['凸', '凹'], ['凹', '凸'],
    ['品', '晶'], ['晶', '品'],
    ['品', '叠'], ['叠', '品'],
    ['串', '中'], ['中', '申'], ['申', '中'],
    ['乙', '己'], ['己', '乙'],
    ['小', '少'], ['少', '小'],
    ['卜', '卡'], ['卡', '卜'],
    ['木', '禾'], ['禾', '木'], ['禾', '和'],
    ['木', '本'], ['本', '末'],
    ['历', '厉'], ['厉', '历'],
    ['氏', '民'], ['民', '氏'],
    ['飞', '风'], ['风', '飞'],
    ['心', '必'], ['必', '心'],
    ['壮', '状'], ['状', '壮'],
    ['服', '伏'], ['伏', '服'],
    ['迷', '谜'], ['谜', '迷'],
    ['方', '万'], ['万', '方'],
    ['土', '工'], ['工', '土'],
    ['千', '于'], ['于', '千'],
    ['推', '堆'], ['堆', '推'], ['维', '堆'],
    ['员', '圆'], ['圆', '园'], ['园', '员'],
    ['合', '今'], ['今', '令'], ['令', '今'],
    ['戈', '弋'], ['弋', '戈'],
    ['勺', '勾'], ['勾', '勺'],
    ['欠', '久'], ['久', '欠'],
    ['丰', '主'], ['主', '丰'],
    ['月', '用'], ['用', '月'],
    ['仿', '访'], ['访', '仿'], ['防', '仿'],
    ['徒', '途'], ['途', '徒'],
    ['分', '份'], ['份', '分'],
    ['今', '令'], ['令', '含'], ['含', '今'],
    ['吕', '旧'], ['旧', '吕'],
    ['阶', '陆'], ['陆', '阶'],
    ['册', '删'], ['删', '册'],
    ['甜', '苦'], ['苦', '若'], ['若', '苦'],
    ['柱', '住'], ['住', '柱'],
    ['做', '作'], ['作', '做'],
    ['已', '己'],
    ['析', '斤'], ['斤', '析'],
    // 复杂形近
    ['猫', '描'], ['描', '猫'],
    ['钱', '浅'], ['浅', '钱'],
    ['海', '悔'], ['悔', '海'],
    ['精', '睛'], ['睛', '精'], ['晴', '情'], ['情', '晴'],
    ['清', '请'], ['请', '清'],
    ['诗', '侍'], ['侍', '诗'],
    ['辩', '辨'], ['辨', '辩'], ['辩', '辫'], ['辫', '辩'],
    ['旋', '施'], ['施', '旋'],
    ['竖', '坚'], ['坚', '竖'],
    ['拣', '检'], ['检', '拣'],
    ['崖', '涯'], ['涯', '崖'],
    ['瑞', '端'], ['端', '瑞'],
    ['副', '幅'], ['幅', '副'],
    ['粱', '梁'], ['梁', '粱'],
    ['像', '橡'], ['橡', '像'],
    ['带', '戴'], ['戴', '带'],
    ['贸', '贸'],
    ['厌', '压'], ['压', '厌'],
  ];

  // ── 确定性随机数（LCG 线性同余）──────────────────────────────────────────
  class SeededRandom {
    constructor(seed) {
      this.seed = (seed >>> 0) || 1;
    }
    next() {
      this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
      return this.seed / 4294967296;
    }
    nextInt(max) {
      return Math.floor(this.next() * max);
    }
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = this.nextInt(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
  }

  // ── 工具 ──────────────────────────────────────────────────────────────────
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    return `${m}:${ss}`;
  }

  // ── 常量 ──────────────────────────────────────────────────────────────────
  const MAX_CELL = 72;
  const MIN_CELL = 24;

  // 难度 → 网格列数（全局统一，不随关卡变化）
  // 简单 6×6=36格 / 普通 8×8=64格 / 困难 10×10=100格 / 地狱 12×12=144格
  const DIFFICULTY_COLS = { easy: 6, normal: 8, hard: 10, hell: 12 };
  function getGridCols(difficulty) {
    return DIFFICULTY_COLS[difficulty] || 6;
  }

  const DIFFICULTY_LABELS = {
    easy:   { label: '简单', size: '6×6',   color: '#3fb950' },
    normal: { label: '普通', size: '8×8',   color: '#58a6ff' },
    hard:   { label: '困难', size: '10×10', color: '#f0883e' },
    hell:   { label: '地狱', size: '12×12', color: '#f85149' },
  };

  // ── WordSpotGameAdapter ───────────────────────────────────────────────────
  class WordSpotGameAdapter {
    constructor(container, config) {
      this.container  = container;
      this.role       = config.role;
      this.roomType   = config.roomType;
      this.mySessionId = config.mySessionId;
      this.isSpectator = config.isSpectator;

      // 游戏状态
      this.seed          = null;
      this.difficulty    = 'easy'; // 当前选择的难度
      this.totalLevels   = 10;
      this.totalDurationMs = 300000;
      this.currentLevel  = 0;        // 当前关卡索引（0-based）
      this.levelStartMs  = null;     // 当前关卡开始时刻（Date.now()）
      this.cumulativeMs  = 0;        // 已通过关卡的累计用时
      this.finished      = false;    // 所有关卡已完成
      this.leaderboard   = [];
      this.levels        = [];       // 预生成的关卡数组

      this._countdownTimer  = null;
      this._remainingMs     = 0;

      // 当前视图状态：'waiting' | 'syncing' | 'game' | 'leaderboard'
      this._viewState = 'waiting';
      // 最近一局结束标记（用于 _render 重绘榜单时判断是否显示再来一局按钮）
      this._isGameOver = false;
      this._roundReason = null;

      // DOM 根节点
      this._wrapper   = null;
      this._statusBar = null;
      this._gameArea  = null;

      // 回调（由 room.js 注入）
      this.sendAction  = null;
      this.sendMessage = null;
      this.notifyGameOver = null;
    }

    // ── 公开接口（供 room.js 调用）────────────────────────────────────────

    init() {
      this._buildDOM();
      window.addEventListener('resize', () => this._onResize());
      this._renderWaiting();
    }

    /** 房间初始化后调用（room.js 的通用接口） */
    onGameStart(room) {
      // word_spot 不在此处启动游戏，等待 onGameStarted (game_started WS消息)
      // 若游戏已在进行（重连/新人），显示同步中状态
      if (room && room.state === 'playing') {
        this._showSyncing();
      }
    }

    /**
     * room.js 在角色变化时调用（如换座、取得/失去房主、切换观战）
     * - 等待页：重新渲染等待页（显示/隐藏开始按钒）
     * - 游戏中切换观战：立即显示排行榜
     * - 榜单页：重新渲染以更新「再来一局」按钮（房主切观战则隐藏，晋升 player1 则显示）
     */
    _render() {
      if (this._viewState === 'waiting') {
        this._renderWaiting();
      } else if (this._viewState === 'game' && this.isSpectator) {
        // 玩家在对战中切换为观战 → 立即显示实时排行榜
        this._renderLeaderboard(false);
      } else if (this._viewState === 'leaderboard') {
        // 角色变更后重新渲染榜单（更新「再来一局」按钮的显隐）
        this._renderLeaderboard(this._isGameOver || false, this._roundReason);
      }
    }

    /** game_started WS 消息到达时调用 */
    onGameStarted(data) {
      // data: { seed, difficulty, total_levels, total_duration_ms, remaining_ms, leaderboard, reconnect }
      this.seed          = data.seed;
      this.difficulty    = data.difficulty || this.difficulty || 'easy';
      this.totalLevels   = data.total_levels   || 10;
      this.totalDurationMs = data.total_duration_ms || 300000;
      this._remainingMs  = data.remaining_ms   || this.totalDurationMs;
      this.leaderboard   = data.leaderboard    || [];
      this.finished      = false;

      // 根据 seed 预生成所有关卡题目
      this._generateLevels();

      // 重连/新人入局：从服务端返回的排行榜恢复己方关卡进度
      if (data.reconnect) {
        const me = this.leaderboard.find(p => p.session_id === this.mySessionId);
        if (me) {
          this.currentLevel = me.current_level || 0;  // 已完成的关卡数
          this.cumulativeMs = me.elapsed_ms    || 0;
          this.finished     = !!(me.finished || me.dropped);
        } else {
          this.currentLevel = 0;
          this.cumulativeMs = 0;
        }
      } else {
        // 全新开局：从第 0 关开始
        this.currentLevel = 0;
        this.cumulativeMs = 0;
      }

      // 启动倒计时显示
      this._startCountdown(this._remainingMs);

      // 判断显示哪个视图
      if (this.isSpectator) {
        this._renderLeaderboard(false);
      } else if (this.finished) {
        // 重连时已完成所有关卡
        this._renderLeaderboard(false);
      } else {
        this._renderLevel(this.currentLevel);
      }
    }

    /** leaderboard_update WS 消息 */
    onLeaderboardUpdate(data) {
      this.leaderboard = data.leaderboard || [];
      this._updateLeaderboardDisplay();
    }

    /** round_ended WS 消息 */
    onRoundEnded(data) {
      this._stopCountdown();
      this.leaderboard = data.leaderboard || [];
      this._isGameOver = true;
      this._roundReason = data.reason;
      this._renderLeaderboard(true, data.reason);
    }

    onRemoteAction(/* data */) {
      // word_spot 不走 game_action 转发路径
    }

    /** 重置到等待状态（再来一局前由 room.js 调用） */
    reset() {
      this._stopCountdown();
      this.seed = null;
      this.currentLevel = 0;
      this.cumulativeMs = 0;
      this.finished = false;
      this.leaderboard = [];
      this.levels = [];
      this._isGameOver = false;
      this._roundReason = null;
      this._viewState = 'waiting';
      this._renderWaiting();
    }

    restoreGameState(/* state */) {
      // word_spot 通过 game_started WS 消息同步，不用 game_state 字段
    }

    // ── 私有：DOM 构建 ──────────────────────────────────────────────────────

    _buildDOM() {
      this.container.innerHTML = '';

      this._wrapper = document.createElement('div');
      this._wrapper.className = 'wsb-wrapper';

      // 状态条
      this._statusBar = document.createElement('div');
      this._statusBar.className = 'wsb-status-bar';
      this._statusBar.innerHTML = `
        <span class="wsb-countdown" id="wsbCountdown">—</span>
        <span class="wsb-level-info" id="wsbLevelInfo"></span>`;

      // 游戏区域（切换各子视图）
      this._gameArea = document.createElement('div');
      this._gameArea.className = 'wsb-game-area';

      this._wrapper.appendChild(this._statusBar);
      this._wrapper.appendChild(this._gameArea);
      this.container.appendChild(this._wrapper);
    }

    _onResize() {
      // 如果当前显示的是游戏网格，重新计算尺寸
      const puzzle = this._gameArea.querySelector('.wsb-puzzle');
      if (puzzle) this._applyGridSize(puzzle);
    }

    // ── 私有：视图切换 ──────────────────────────────────────────────────────

    /** 等待房主开始的视图 */
    _renderWaiting() {
      this._viewState = 'waiting';
      this._statusBar.style.display = 'none';
      this._gameArea.innerHTML = '';

      const div = document.createElement('div');
      div.className = 'wsb-waiting';

      const isHost = this.role === 'player1';
      const diffRows = isHost ? Object.entries(DIFFICULTY_LABELS).map(([key, info]) => `
        <button class="wsb-diff-btn${this.difficulty === key ? ' active' : ''}" data-diff="${key}">
          <span class="wsb-diff-label-text">${info.label}</span>
          <span class="wsb-diff-size-text">${info.size}</span>
        </button>`).join('') : '';

      div.innerHTML = `
        <div class="wsb-waiting-icon">🔍</div>
        <div class="wsb-waiting-title">文字找茬</div>
        <div class="wsb-waiting-desc">${isHost ? '选择难度，然后开始游戏' : '等待房主开始游戏…'}</div>
        ${isHost ? `
          <div class="wsb-diff-wrap">
            <div class="wsb-diff-row" id="wsbDiffRow">${diffRows}</div>
          </div>
          <button class="wsb-start-btn" id="wsbStartBtn">开始游戏</button>` : ''}`;

      this._gameArea.appendChild(div);

      if (isHost) {
        document.getElementById('wsbDiffRow').addEventListener('click', (e) => {
          const btn = e.target.closest('.wsb-diff-btn');
          if (!btn) return;
          this.difficulty = btn.dataset.diff;
          document.querySelectorAll('#wsbDiffRow .wsb-diff-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
        document.getElementById('wsbStartBtn').addEventListener('click', () => {
          if (this.sendMessage) this.sendMessage({ type: 'start_game', difficulty: this.difficulty });
        });
      }
    }

    /** 重连时显示同步中 */
    _showSyncing() {
      this._viewState = 'syncing';
      this._statusBar.style.display = 'none';
      this._gameArea.innerHTML = `
        <div class="wsb-waiting">
          <div class="wsb-waiting-icon">⏳</div>
          <div class="wsb-waiting-title">同步中…</div>
          <div class="wsb-waiting-desc">正在获取当前局状态，请稍候</div>
        </div>`;
    }

    /** 渲染某一关的找萓网格 */
    _renderLevel(levelIdx) {
      this._viewState = 'game';
      this._statusBar.style.display = '';
      this._updateStatusBar();
      this._gameArea.innerHTML = '';

      const level = this.levels[levelIdx];
      if (!level) return;

      const puzzle = document.createElement('div');
      puzzle.className = 'wsb-puzzle';

      const title = document.createElement('div');
      title.className = 'wsb-puzzle-title';
      title.textContent = `第 ${levelIdx + 1} / ${this.totalLevels} 关 — 找出不同的字`;
      puzzle.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'wsb-grid';
      grid.style.setProperty('--wsb-cols', level.cols);

      const cells = this._buildCells(level);
      cells.forEach((ch, idx) => {
        const cell = document.createElement('div');
        cell.className = 'wsb-grid-cell';
        cell.textContent = ch;
        cell.addEventListener('click', () => this._onCellClick(cell, idx, level));
        grid.appendChild(cell);
      });

      puzzle.appendChild(grid);
      this._gameArea.appendChild(puzzle);
      this._applyGridSize(puzzle);

      // 记录关卡开始时刻
      this.levelStartMs = Date.now();
    }

    /** 渲染排行榜视图（结束或观战） */
    _renderLeaderboard(isGameOver, reason) {
      this._viewState = 'leaderboard';
      this._statusBar.style.display = isGameOver ? 'none' : '';

      // 清空关卡信息，避免切换到观战/结束后仍残留"x / y 关"
      const levelInfoEl = document.getElementById('wsbLevelInfo');
      if (levelInfoEl) levelInfoEl.textContent = '';

      this._gameArea.innerHTML = '';

      const div = document.createElement('div');
      div.className = 'wsb-leaderboard';

      // ── 标题区 ──
      const header = document.createElement('div');
      header.className = 'wsb-lb-header';
      if (isGameOver) {
        const reasonText = reason === 'timeout' ? '⏰ 时间到！' : '🏁 全员完成！';
        const diffInfo   = DIFFICULTY_LABELS[this.difficulty] || DIFFICULTY_LABELS.normal;
        header.innerHTML = `
          <div class="wsb-lb-header-main">
            <span class="wsb-lb-title">🏆 最终排行榜</span>
            <span class="wsb-lb-reason">${reasonText}</span>
          </div>
          <div class="wsb-lb-header-sub">
            <span class="wsb-lb-diff-badge" style="color:${diffInfo.color}">${diffInfo.label}·${diffInfo.size}</span>
            <span class="wsb-lb-levels-hint">${this.totalLevels} 关</span>
          </div>`;
      } else {
        header.innerHTML = `<span class="wsb-lb-title">📊 实时排行榜（观战）</span>`;
      }
      div.appendChild(header);

      // ── 列表 ──
      const list = document.createElement('div');
      list.className = 'wsb-lb-list';
      list.id = 'wsbLbList';
      div.appendChild(list);

      // ── 再来一局（仅房主且游戏结束时显示）──
      if (isGameOver && this.role === 'player1') {
        const replayWrap = document.createElement('div');
        replayWrap.className = 'wsb-replay-wrap';
        replayWrap.innerHTML = `<button class="wsb-replay-btn" id="wsbReplayBtn">🔄 再来一局</button>`;
        replayWrap.querySelector('#wsbReplayBtn').addEventListener('click', () => {
          if (this.sendMessage) this.sendMessage({ type: 'restart_game' });
        });
        div.appendChild(replayWrap);
      }

      this._gameArea.appendChild(div);
      this._renderLeaderboardRows();
    }

    _renderLeaderboardRows() {
      const list = document.getElementById('wsbLbList');
      if (!list) return;
      const total = this.totalLevels || 10;
      const sorted = [...this.leaderboard].sort((a, b) => {
        if (b.current_level !== a.current_level) return b.current_level - a.current_level;
        return a.elapsed_ms - b.elapsed_ms;
      });

      const MEDALS = ['🥇', '🥈', '🥉'];

      list.innerHTML = sorted.map((p, i) => {
        const isMe      = p.session_id === this.mySessionId;
        const pct       = Math.round((p.current_level / total) * 100);
        const timeStr   = p.elapsed_ms ? fmtTime(p.elapsed_ms) : '—';
        const rankBadge = i < 3 ? `<span class="wsb-lb-medal">${MEDALS[i]}</span>`
                                : `<span class="wsb-lb-rank-num">${i + 1}</span>`;
        let badgeClass, badgeText;
        if (p.dropped)       { badgeClass = 'drop';     badgeText = '弃赛'; }
        else if (p.finished) { badgeClass = 'finish';   badgeText = '完成'; }
        else                 { badgeClass = 'progress'; badgeText = `第 ${p.current_level} 关`; }

        return `
          <div class="wsb-lb-item ${isMe ? 'me' : ''} ${p.finished ? 'finished' : ''} ${p.dropped ? 'dropped' : ''}">
            <div class="wsb-lb-rank-wrap">${rankBadge}</div>
            <div class="wsb-lb-body">
              <div class="wsb-lb-top-row">
                <span class="wsb-lb-name">${esc(p.name)}${isMe ? '<span class="wsb-lb-me-tag"> 我</span>' : ''}</span>
                <span class="wsb-lb-badge ${badgeClass}">${badgeText}</span>
                <span class="wsb-lb-time">⏱ ${timeStr}</span>
              </div>
              <div class="wsb-lb-bar-row">
                <div class="wsb-lb-bar-track">
                  <div class="wsb-lb-bar-fill ${p.finished ? 'full' : ''}" style="width:${pct}%"></div>
                </div>
                <span class="wsb-lb-bar-text">${p.current_level}/${total}</span>
              </div>
            </div>
          </div>`;
      }).join('');
    }

    _updateLeaderboardDisplay() {
      this._renderLeaderboardRows();
    }

    // ── 私有：格子交互 ──────────────────────────────────────────────────────

    _onCellClick(cell, idx, level) {
      if (this.finished) return;

      if (idx === level.diffPos) {
        // 答对！
        cell.classList.add('correct');
        const elapsed = (Date.now() - this.levelStartMs) + this.cumulativeMs;

        // 上报给服务端
        if (this.sendAction) {
          this.sendAction({
            action: 'level_complete',
            level: this.currentLevel + 1,  // 1-based
            elapsed_ms: elapsed,
          });
        }

        this.cumulativeMs += (Date.now() - this.levelStartMs);
        this.currentLevel++;

        setTimeout(() => {
          if (this.currentLevel < this.totalLevels) {
            this._renderLevel(this.currentLevel);
          } else {
            this.finished = true;
            this._renderLeaderboard(false);
          }
        }, 400);
      } else {
        // 答错：红色抖动
        cell.classList.add('wrong');
        setTimeout(() => cell.classList.remove('wrong'), 600);
      }
    }

    // ── 私有：关卡生成 ──────────────────────────────────────────────────────

    _generateLevels() {
      const rng = new SeededRandom(this.seed);
      this.levels = [];

      // 打乱 CHAR_PAIRS 以避免重复
      const shuffled = rng.shuffle(CHAR_PAIRS);
      const pool = shuffled.concat(shuffled); // 最多 30 关，配对扩充

      for (let i = 0; i < this.totalLevels; i++) {
        const cols   = getGridCols(this.difficulty);
        const total  = cols * cols;
        const pair   = pool[i % pool.length];
        const main   = pair[0];
        const alt    = pair[pair.length > 1 ? 1 : 0];
        // 不同字的位置
        const diffPos = rng.nextInt(total);

        this.levels.push({ cols, total, mainChar: main, altChar: alt, diffPos });
      }
    }

    _buildCells(level) {
      const cells = new Array(level.total).fill(level.mainChar);
      cells[level.diffPos] = level.altChar;
      return cells;
    }

    // ── 私有：网格缩放（参考棋盘缩放算法）──────────────────────────────────

    _applyGridSize(puzzleEl) {
      const grid = puzzleEl.querySelector('.wsb-grid');
      if (!grid) return;
      const level = this.levels[this.currentLevel];
      if (!level) return;

      const cols = level.cols;
      const GAP  = 3; // 与 CSS gap 保持一致
      const W = this._gameArea.clientWidth  || 300;
      const H = this._gameArea.clientHeight || 400;

      const titleH = puzzleEl.querySelector('.wsb-puzzle-title')
        ? puzzleEl.querySelector('.wsb-puzzle-title').offsetHeight + 20
        : 40;

      // 可用像素 = min(宽, 高-标题) - 总间距
      const avail = Math.min(W - 24, H - titleH - 24) - GAP * (cols - 1);
      let size = Math.floor(avail / cols);
      size = Math.min(size, MAX_CELL);
      size = Math.max(size, MIN_CELL);

      const totalPx = size * cols + GAP * (cols - 1);
      grid.style.setProperty('--wsb-cell-size', size + 'px');
      grid.style.setProperty('--wsb-cols', cols);
      grid.style.width  = totalPx + 'px';
      grid.style.height = totalPx + 'px';
    }

    // ── 私有：倒计时 ────────────────────────────────────────────────────────

    _startCountdown(remainingMs) {
      this._stopCountdown();
      this._remainingMs = remainingMs;
      const tick = Date.now();
      this._countdownTimer = setInterval(() => {
        const elapsed = Date.now() - tick;
        const left = remainingMs - elapsed;
        this._remainingMs = Math.max(0, left);
        const el = document.getElementById('wsbCountdown');
        if (el) {
          el.textContent = fmtTime(this._remainingMs);
          el.className = 'wsb-countdown' + (this._remainingMs < 10000 ? ' urgent' : '');
        }
        if (this._remainingMs <= 0) this._stopCountdown();
      }, 500);
    }

    _stopCountdown() {
      if (this._countdownTimer) {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;
      }
    }

    _updateStatusBar() {
      const countdownEl = document.getElementById('wsbCountdown');
      if (countdownEl) countdownEl.textContent = fmtTime(this._remainingMs);
      const levelEl = document.getElementById('wsbLevelInfo');
      if (levelEl) levelEl.textContent = `${this.currentLevel + 1} / ${this.totalLevels} 关`;
    }
  }

  // 挂载到全局（room.js 的适配器查找逻辑：word_spot → WordSpotGameAdapter）
  window.WordSpotGameAdapter = WordSpotGameAdapter;

})();
