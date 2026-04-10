/**
 * go/ai-worker.js — Web Worker 版围棋 AI
 * 包含完整的 GoRules（提子、劫、自杀禁止）+ GoAI（4 难度），
 * 在后台线程执行，不阻塞 UI。
 */
'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// GoRules — 围棋规则引擎
// ══════════════════════════════════════════════════════════════════════════════

const DIRS4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** 快速克隆二维棋盘 */
function cloneBoard(board, SIZE) {
  const b = new Array(SIZE);
  for (let r = 0; r < SIZE; r++) {
    b[r] = board[r].slice();
  }
  return b;
}

/** 棋盘序列化为字符串（用于劫的检测） */
function boardHash(board, SIZE) {
  let s = '';
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = board[r][c];
      s += v ? (v === 'black' ? 'B' : 'W') : '.';
    }
  }
  return s;
}

/**
 * 获取以 (r,c) 为起点的同色连通块及其气数
 * @returns {{ group: Array<[r,c]>, liberties: Set<string> }}
 */
function getGroupAndLiberties(board, r, c, SIZE) {
  const color = board[r][c];
  if (!color) return { group: [], liberties: new Set() };

  const group = [];
  const liberties = new Set();
  const visited = new Set();
  const stack = [[r, c]];

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
      if (!board[nr][nc]) {
        liberties.add(nr + ',' + nc);
      } else if (board[nr][nc] === color && !visited.has(nkey)) {
        stack.push([nr, nc]);
      }
    }
  }

  return { group, liberties };
}

/**
 * 在 board 上执行落子，返回 { ok, newBoard, captured, koPoint }
 * - ok=false 表示落子非法（自杀 or 劫）
 * @param {string[][]} board
 * @param {number} r
 * @param {number} c
 * @param {string} color  'black' | 'white'
 * @param {string|null} koHash  上一步形成的劫禁止哈希
 * @param {number} SIZE
 */
function applyMove(board, r, c, color, koHash, SIZE) {
  if (board[r][c]) return { ok: false };

  const opp = color === 'black' ? 'white' : 'black';
  const nb = cloneBoard(board, SIZE);
  nb[r][c] = color;

  // 提子：检查四方对方棋组是否变成无气
  let captured = 0;
  for (const [dr, dc] of DIRS4) {
    const nr = r + dr, nc = c + dc;
    if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
    if (nb[nr][nc] !== opp) continue;
    const { group, liberties } = getGroupAndLiberties(nb, nr, nc, SIZE);
    if (liberties.size === 0) {
      captured += group.length;
      for (const [gr, gc] of group) nb[gr][gc] = null;
    }
  }

  // 自杀检测：落子后己方棋组若无气（且未提子），非法
  const { liberties: myLib } = getGroupAndLiberties(nb, r, c, SIZE);
  if (myLib.size === 0 && captured === 0) return { ok: false };

  // 劫检测：落子后棋盘状态不能与上一步禁止哈希相同
  const newHash = boardHash(nb, SIZE);
  if (koHash && newHash === koHash) return { ok: false };

  // 计算本次产生的劫禁止哈希（只在恰好提了1子时产生劫）
  const newKoHash = captured === 1 ? boardHash(board, SIZE) : null;

  return { ok: true, newBoard: nb, captured, koHash: newKoHash };
}

/**
 * 获取所有合法落子点
 */
function getLegalMoves(board, color, koHash, SIZE) {
  const moves = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!board[r][c]) {
        const res = applyMove(board, r, c, color, koHash, SIZE);
        if (res.ok) moves.push({ r, c });
      }
    }
  }
  return moves;
}

// ══════════════════════════════════════════════════════════════════════════════
// 评估函数（用于 normal / hard / hell）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 简单评估：统计空点的归属（flood-fill），棋子数差异 + 领地差异
 */
function estimateScore(board, SIZE) {
  const territory = { black: 0, white: 0 };
  const visited = new Set();

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] || visited.has(r * SIZE + c)) continue;
      // BFS 找空点连通块，判断归属
      const empties = [];
      let touchBlack = false, touchWhite = false;
      const stack = [[r, c]];
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
          if (!board[nr][nc]) {
            if (!localVis.has(nr * SIZE + nc)) stack.push([nr, nc]);
          } else {
            if (board[nr][nc] === 'black') touchBlack = true;
            else touchWhite = true;
          }
        }
      }
      if (touchBlack && !touchWhite) territory.black += empties.length;
      else if (touchWhite && !touchBlack) territory.white += empties.length;
    }
  }

  let black = territory.black, white = territory.white;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === 'black') black++;
      else if (board[r][c] === 'white') white++;
    }
  }
  return black - white; // 正值黑优，负值白优
}

/**
 * 位置权重：越靠近中央越高，边角较低
 */
function posWeight(r, c, SIZE) {
  const mid = (SIZE - 1) / 2;
  const dist = Math.abs(r - mid) + Math.abs(c - mid);
  return Math.max(0, SIZE - dist);
}

/**
 * 评估一个落子位置的即时启发得分
 * 考虑：提子数、连接度（邻接己方棋子）、位置权重
 */
function heuristicScore(board, r, c, color, SIZE) {
  const opp = color === 'black' ? 'white' : 'black';
  let score = posWeight(r, c, SIZE) * 0.5;

  // 模拟落子
  const res = applyMove(board, r, c, color, null, SIZE);
  if (!res.ok) return -Infinity;

  // 提子奖励
  score += res.captured * 12;

  // 邻接己方棋子（连接度）
  for (const [dr, dc] of DIRS4) {
    const nr = r + dr, nc = c + dc;
    if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
    if (board[nr][nc] === color) score += 2;
    if (board[nr][nc] === opp) score += 1; // 攻击邻近
  }

  // 落点后己方棋组气数奖励（气越多越安全）
  const { liberties } = getGroupAndLiberties(res.newBoard, r, c, SIZE);
  score += liberties.size * 0.8;

  return score;
}

// ══════════════════════════════════════════════════════════════════════════════
// Monte Carlo 评估（用于 hard / hell）
// ══════════════════════════════════════════════════════════════════════════════

let _deadline = 0;
let _timedOut = false;

/** 随机走子直到终局，返回黑方胜（true）还是白方胜（false） */
function randomPlayout(board, colorToPlay, SIZE, maxMoves) {
  const b = cloneBoard(board, SIZE);
  let color = colorToPlay;
  let passCount = 0;
  let koHash = null;

  for (let i = 0; i < maxMoves; i++) {
    if (_deadline > 0 && (i & 0x3f) === 0 && Date.now() > _deadline) {
      _timedOut = true;
      break;
    }

    const moves = getLegalMoves(b, color, koHash, SIZE);
    if (moves.length === 0) {
      passCount++;
      if (passCount >= 2) break;
    } else {
      passCount = 0;
      // 随机选取候选落子（加权：优先提子和靠近已有棋子的点）
      const idx = Math.floor(Math.random() * Math.min(moves.length, 20 + Math.floor(Math.random() * moves.length)));
      const mv = moves[idx];
      const res = applyMove(b, mv.r, mv.c, color, koHash, SIZE);
      if (res.ok) {
        b[mv.r][mv.c] = color;
        // 同步提子
        const opp = color === 'black' ? 'white' : 'black';
        for (const [dr, dc] of DIRS4) {
          const nr = mv.r + dr, nc = mv.c + dc;
          if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
          if (b[nr][nc] !== opp) continue;
          const { group, liberties } = getGroupAndLiberties(b, nr, nc, SIZE);
          if (liberties.size === 0) {
            for (const [gr, gc] of group) b[gr][gc] = null;
          }
        }
        const { liberties: myLib } = getGroupAndLiberties(b, mv.r, mv.c, SIZE);
        if (myLib.size === 0) b[mv.r][mv.c] = null;
        koHash = res.koHash;
      }
    }
    color = color === 'black' ? 'white' : 'black';
  }

  return estimateScore(b, SIZE) > 0; // true = 黑赢
}

/**
 * Monte Carlo 选择最佳落子
 * @param {string[][]} board
 * @param {string} color
 * @param {number[]} candidates  [{r,c}]
 * @param {number} simCount  每个候选模拟次数
 * @param {number} SIZE
 */
function mcBestMove(board, color, candidates, simCount, SIZE) {
  if (candidates.length === 0) return null;

  let bestScore = -1;
  let bestMove = null;
  const isBlack = color === 'black';

  for (const mv of candidates) {
    if (_timedOut) break;
    const res = applyMove(board, mv.r, mv.c, color, null, SIZE);
    if (!res.ok) continue;

    let wins = 0;
    for (let i = 0; i < simCount; i++) {
      if (_timedOut) break;
      const won = randomPlayout(res.newBoard, color === 'black' ? 'white' : 'black', SIZE, SIZE * SIZE);
      if (isBlack ? won : !won) wins++;
    }

    const winRate = wins / simCount;
    if (winRate > bestScore) {
      bestScore = winRate;
      bestMove = mv;
    }
  }

  return bestMove;
}

// ══════════════════════════════════════════════════════════════════════════════
// AI 主函数
// ══════════════════════════════════════════════════════════════════════════════

function bestMove(board, color, difficulty, SIZE, koHash) {
  const opp = color === 'black' ? 'white' : 'black';
  const legalMoves = getLegalMoves(board, color, koHash, SIZE);

  if (legalMoves.length === 0) return null; // 无法落子，虚手

  // ── easy：随机合法落子 ─────────────────────────────────────────────────────
  if (difficulty === 'easy') {
    // 优先提子，否则随机
    for (const mv of legalMoves) {
      const res = applyMove(board, mv.r, mv.c, color, koHash, SIZE);
      if (res.ok && res.captured > 0) return mv;
    }
    return legalMoves[Math.floor(Math.random() * legalMoves.length)];
  }

  // ── normal：贪心启发 ───────────────────────────────────────────────────────
  if (difficulty === 'normal') {
    // 先检查能否立即提子
    for (const mv of legalMoves) {
      const res = applyMove(board, mv.r, mv.c, color, koHash, SIZE);
      if (res.ok && res.captured >= 2) return mv;
    }
    // 按启发分排序，取最高分
    const scored = legalMoves.map(mv => ({
      mv,
      score: heuristicScore(board, mv.r, mv.c, color, SIZE),
    }));
    scored.sort((a, b) => b.score - a.score);
    // 取 top-3 随机选一个（增加多样性）
    const topK = scored.slice(0, Math.min(3, scored.length));
    return topK[Math.floor(Math.random() * topK.length)].mv;
  }

  // ── hard / hell：Monte Carlo ───────────────────────────────────────────────
  const simCount = difficulty === 'hell' ? 80 : 40;
  const timeMs   = difficulty === 'hell' ? 8000 : 4000;

  _deadline  = Date.now() + timeMs;
  _timedOut  = false;

  // 先按启发分筛选候选点（候选点太多会导致 MC 很慢）
  const scored = legalMoves.map(mv => ({
    mv,
    score: heuristicScore(board, mv.r, mv.c, color, SIZE),
  }));
  scored.sort((a, b) => b.score - a.score);
  const topN = Math.min(scored.length, difficulty === 'hell' ? 20 : 12);
  const candidates = scored.slice(0, topN).map(s => s.mv);

  // 立即提子优先
  for (const mv of candidates) {
    const res = applyMove(board, mv.r, mv.c, color, koHash, SIZE);
    if (res.ok && res.captured >= 2) return mv;
  }

  const mv = mcBestMove(board, color, candidates, simCount, SIZE);
  return mv || candidates[0];
}

// ══════════════════════════════════════════════════════════════════════════════
// Worker 消息处理
// ══════════════════════════════════════════════════════════════════════════════

self.onmessage = function (e) {
  const { board, color, difficulty, SIZE, koHash } = e.data;

  // 将传入的棋盘格式（null | { color: 'black'|'white' }）转成内部简单格式（null | 'black' | 'white'）
  const flatBoard = board.map(row =>
    row.map(cell => (cell ? cell.color : null))
  );

  const mv = bestMove(flatBoard, color, difficulty, SIZE || 19, koHash || null);
  self.postMessage({ move: mv ? { r: mv.r, c: mv.c } : null });
};
