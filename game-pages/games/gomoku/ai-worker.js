/**
 * gomoku/ai-worker.js — Web Worker 版五子棋 AI
 * 包含完整的 GomokuRules + GomokuAI，在后台线程执行，不阻塞 UI
 */
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// GomokuRules
// ═══════════════════════════════════════════════════════════════════════════════

const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

function getWinLine(board, r, c, color, SIZE) {
  for (const [dr, dc] of DIRS) {
    const line = [{ r, c }];
    let nr = r + dr, nc = c + dc;
    while (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc]?.color === color) {
      line.push({ r: nr, c: nc }); nr += dr; nc += dc;
    }
    nr = r - dr; nc = c - dc;
    while (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc]?.color === color) {
      line.unshift({ r: nr, c: nc }); nr -= dr; nc -= dc;
    }
    if (line.length >= 5) return line.slice(0, 5);
  }
  return null;
}

function checkWin(board, r, c, color, SIZE) {
  return getWinLine(board, r, c, color, SIZE) !== null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GomokuAI
// ═══════════════════════════════════════════════════════════════════════════════

const FIVE        = 1000000;
const LIVE_FOUR   = 100000;
const RUSH_FOUR   = 15000;
const LIVE_THREE  = 8000;
const SLEEP_THREE = 600;
const LIVE_TWO    = 700;
const SLEEP_TWO   = 100;
const LIVE_ONE    = 30;

function analyzeDir(board, r, c, dr, dc, color, SIZE) {
  let fwd = 0, nr = r + dr, nc = c + dc;
  while (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc]?.color === color) {
    fwd++; nr += dr; nc += dc;
  }
  const fwdOpen = (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && !board[nr][nc]);

  let bwd = 0;
  nr = r - dr; nc = c - dc;
  while (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc]?.color === color) {
    bwd++; nr -= dr; nc -= dc;
  }
  const bwdOpen = (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && !board[nr][nc]);

  return { count: fwd + bwd + 1, openEnds: (fwdOpen ? 1 : 0) + (bwdOpen ? 1 : 0) };
}

function patternScore(count, openEnds) {
  if (count >= 5) return FIVE;
  if (count === 4) return openEnds === 2 ? LIVE_FOUR : openEnds === 1 ? RUSH_FOUR : 0;
  if (count === 3) return openEnds === 2 ? LIVE_THREE : openEnds === 1 ? SLEEP_THREE : 0;
  if (count === 2) return openEnds === 2 ? LIVE_TWO : openEnds === 1 ? SLEEP_TWO : 0;
  if (count === 1) return openEnds === 2 ? LIVE_ONE : 0;
  return 0;
}

function evaluatePos(board, r, c, color, SIZE) {
  board[r][c] = { color };
  let score = 0;
  let liveThrees = 0, rushFours = 0;
  for (const [dr, dc] of DIRS) {
    const { count, openEnds } = analyzeDir(board, r, c, dr, dc, color, SIZE);
    const ps = patternScore(count, openEnds);
    score += ps;
    if (count === 3 && openEnds === 2) liveThrees++;
    if (count === 4 && openEnds >= 1)  rushFours++;
  }
  if (liveThrees >= 2) score += 60000;
  if (rushFours >= 1 && liveThrees >= 1) score += 80000;
  if (rushFours >= 2) score += 90000;
  board[r][c] = null;
  return score;
}

function evaluateBoard(board, color, SIZE) {
  const opp = color === 'black' ? 'white' : 'black';
  let atkTotal = 0, defTotal = 0;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c]) continue;
      let near = false;
      for (let dr = -1; dr <= 1 && !near; dr++) {
        for (let dc = -1; dc <= 1 && !near; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc]) near = true;
        }
      }
      if (!near) continue;
      atkTotal += evaluatePos(board, r, c, color, SIZE);
      defTotal += evaluatePos(board, r, c, opp,   SIZE);
    }
  }
  return atkTotal * 1.1 - defTotal;
}

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
            set.add(nr * SIZE + nc);
          }
        }
      }
    }
  }
  if (!hasPiece) {
    const mid = Math.floor(SIZE / 2);
    return [{ r: mid, c: mid }];
  }
  return [...set].map(k => ({ r: Math.floor(k / SIZE), c: k % SIZE }));
}

function sortCandidates(board, candidates, color, SIZE, topN) {
  const opp = color === 'black' ? 'white' : 'black';
  const scored = candidates.map(pos => {
    const atk = evaluatePos(board, pos.r, pos.c, color, SIZE);
    const def = evaluatePos(board, pos.r, pos.c, opp,   SIZE);
    return { ...pos, score: atk + def * 0.95 };
  });
  scored.sort((a, b) => b.score - a.score);
  return topN ? scored.slice(0, topN) : scored;
}

let _deadline = 0;
let _timedOut = false;
let _nodeCount = 0;

function minimax(board, depth, alpha, beta, isMaximizing, aiColor, SIZE, maxCandidates) {
  if (_deadline > 0 && (++_nodeCount & 255) === 0) {
    if (Date.now() > _deadline) { _timedOut = true; return evaluateBoard(board, aiColor, SIZE); }
  }
  if (_timedOut) return evaluateBoard(board, aiColor, SIZE);

  const opp = aiColor === 'black' ? 'white' : 'black';
  const currentColor = isMaximizing ? aiColor : opp;

  if (depth === 0) return evaluateBoard(board, aiColor, SIZE);

  const candidates = getCandidates(board, SIZE, 1);
  if (candidates.length === 0) return 0;
  const sorted = sortCandidates(board, candidates, currentColor, SIZE, maxCandidates);

  if (isMaximizing) {
    let best = -Infinity;
    for (const { r, c } of sorted) {
      board[r][c] = { color: currentColor };
      if (checkWin(board, r, c, currentColor, SIZE)) {
        board[r][c] = null;
        return FIVE * 10;
      }
      const val = minimax(board, depth - 1, alpha, beta, false, aiColor, SIZE, maxCandidates);
      board[r][c] = null;
      if (_timedOut) return best === -Infinity ? val : best;
      best = Math.max(best, val);
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const { r, c } of sorted) {
      board[r][c] = { color: currentColor };
      if (checkWin(board, r, c, currentColor, SIZE)) {
        board[r][c] = null;
        return -FIVE * 10;
      }
      const val = minimax(board, depth - 1, alpha, beta, true, aiColor, SIZE, maxCandidates);
      board[r][c] = null;
      if (_timedOut) return best === Infinity ? val : best;
      best = Math.min(best, val);
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

function bestMove(board, color, difficulty, SIZE) {
  const opp = color === 'black' ? 'white' : 'black';
  const candidates = getCandidates(board, SIZE, difficulty === 'easy' ? 1 : 2);
  if (candidates.length === 0) return null;

  if (difficulty === 'easy') {
    const shuffled = candidates.sort(() => Math.random() - 0.5);
    for (const pos of shuffled) {
      const def = evaluatePos(board, pos.r, pos.c, opp, SIZE);
      if (def >= FIVE) return pos;
    }
    return shuffled[0];
  }

  const sorted = sortCandidates(board, candidates, color, SIZE, null);
  for (const pos of sorted) {
    const atk = evaluatePos(board, pos.r, pos.c, color, SIZE);
    if (atk >= FIVE) return pos;
  }
  for (const pos of sorted) {
    const def = evaluatePos(board, pos.r, pos.c, opp, SIZE);
    if (def >= FIVE) return pos;
  }

  if (difficulty === 'normal') {
    const mid = (SIZE - 1) / 2;
    let bestScore = -Infinity, bestMoves = [];
    for (const pos of sorted) {
      const atk = evaluatePos(board, pos.r, pos.c, color, SIZE);
      const def = evaluatePos(board, pos.r, pos.c, opp,   SIZE);
      let score = atk * 1.1 + def;
      const dist = Math.abs(pos.r - mid) + Math.abs(pos.c - mid);
      score += Math.max(0, SIZE - dist) * 0.5;
      if (score > bestScore) { bestScore = score; bestMoves = [pos]; }
      else if (score === bestScore) bestMoves.push(pos);
    }
    return bestMoves[Math.floor(Math.random() * bestMoves.length)] || null;
  }

  if (difficulty === 'hard') {
    _deadline = Date.now() + 5000;
    _timedOut = false;
    _nodeCount = 0;
    const topN = Math.min(sorted.length, 15);
    const top = sorted.slice(0, topN);
    let bestScore = -Infinity, bestMv = top[0];
    for (const pos of top) {
      board[pos.r][pos.c] = { color };
      if (checkWin(board, pos.r, pos.c, color, SIZE)) {
        board[pos.r][pos.c] = null;
        return pos;
      }
      const val = minimax(board, 3, -Infinity, Infinity, false, color, SIZE, 12);
      board[pos.r][pos.c] = null;
      if (val > bestScore) { bestScore = val; bestMv = pos; }
      if (_timedOut) break;
    }
    return bestMv;
  }

  if (difficulty === 'hell') {
    _deadline = Date.now() + 15000;
    _timedOut = false;
    _nodeCount = 0;
    const topN = Math.min(sorted.length, 20);
    const top = sorted.slice(0, topN);
    let bestScore = -Infinity, bestMv = top[0];

    // 迭代加深：先用浅层搜索得到一个保底结果，再尝试深层搜索
    for (const pos of top) {
      board[pos.r][pos.c] = { color };
      if (checkWin(board, pos.r, pos.c, color, SIZE)) {
        board[pos.r][pos.c] = null;
        return pos;
      }
      const val = minimax(board, 4, -Infinity, Infinity, false, color, SIZE, 15);
      board[pos.r][pos.c] = null;
      if (val > bestScore) { bestScore = val; bestMv = pos; }
      if (_timedOut) break;
    }

    // 深层搜索（depth 6），在剩余时间内尝试更深的分析
    if (!_timedOut) {
      let deepBest = -Infinity, deepMv = bestMv;
      for (const pos of top) {
        if (_timedOut) break;
        board[pos.r][pos.c] = { color };
        if (checkWin(board, pos.r, pos.c, color, SIZE)) {
          board[pos.r][pos.c] = null;
          return pos;
        }
        const val = minimax(board, 6, -Infinity, Infinity, false, color, SIZE, 15);
        board[pos.r][pos.c] = null;
        if (val > deepBest) { deepBest = val; deepMv = pos; }
        if (_timedOut) break;
      }
      bestMv = deepMv;
    }

    return bestMv;
  }

  return sorted[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker 消息处理
// ═══════════════════════════════════════════════════════════════════════════════

self.onmessage = function (e) {
  const { board, color, difficulty, SIZE } = e.data;
  const mv = bestMove(board, color, difficulty, SIZE);
  self.postMessage({ move: mv ? { r: mv.r, c: mv.c } : null });
};
