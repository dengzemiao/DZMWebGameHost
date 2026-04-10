/**
 * chess/ai-worker.js — Web Worker 版象棋 AI
 * 包含完整的 ChessRules + ChessAI，在后台线程执行，不阻塞 UI
 */
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// ChessRules — 中国象棋规则（走法生成、将军判定）
// ═══════════════════════════════════════════════════════════════════════════════

function inBoard(r, c) { return r >= 0 && r < 10 && c >= 0 && c < 9; }

function getCandidates(board, r, c) {
  const piece = board[r][c];
  if (!piece) return [];
  const { type, color } = piece;
  const isRed = color === 'red';
  const moves = [];

  switch (type) {
    case 'K': {
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
    case 'A': {
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
    case 'B': {
      const riverLimit = isRed ? 5 : 4;
      for (const [dr, dc] of [[-2,-2],[-2,2],[2,-2],[2,2]]) {
        const nr = r+dr, nc = c+dc;
        const mr = r+dr/2, mc = c+dc/2;
        if (!inBoard(nr,nc)) continue;
        if (isRed && nr < riverLimit) continue;
        if (!isRed && nr >= riverLimit) continue;
        if (board[mr][mc]) continue;
        const t = board[nr][nc];
        if (!t || t.color !== color) moves.push([nr, nc]);
      }
      break;
    }
    case 'N': {
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
        if (board[legR][legC]) continue;
        const t = board[nr][nc];
        if (!t || t.color !== color) moves.push([nr, nc]);
      }
      break;
    }
    case 'R': {
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
    case 'C': {
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
    case 'P': {
      const forward = isRed ? -1 : 1;
      const crossed = isRed ? r < 5 : r >= 5;
      const nr = r+forward;
      if (inBoard(nr,c)) {
        const t = board[nr][c];
        if (!t || t.color !== color) moves.push([nr, c]);
      }
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

function isInCheck(board, color) {
  let kr = -1, kc = -1;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (p && p.type === 'K' && p.color === color) { kr=r; kc=c; break; }
    }
    if (kr >= 0) break;
  }
  if (kr < 0) return true;

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

const Rules = { getCandidates, isInCheck, getValidMoves, getAllMoves };

// ═══════════════════════════════════════════════════════════════════════════════
// ChessAI — 搜索 + 评估
// ═══════════════════════════════════════════════════════════════════════════════

const PIECE_VALUE = { K:10000, A:120, B:120, R:600, N:270, C:285, P:30 };
const ENDGAME_VALUE = { K:10000, A:120, B:120, R:650, N:285, C:270, P:80 };

const POS_TABLE = {
  R: [
    [206,208,207,213,214,213,207,208,206],
    [206,212,209,216,233,216,209,212,206],
    [206,208,207,214,216,214,207,208,206],
    [206,213,213,216,216,216,213,213,206],
    [208,211,211,214,215,214,211,211,208],
    [208,212,212,214,215,214,212,212,208],
    [204,209,204,212,214,212,204,209,204],
    [198,208,204,212,212,212,204,208,198],
    [200,208,206,212,200,212,206,208,200],
    [194,206,204,212,200,212,204,206,194],
  ],
  N: [
    [90, 90, 90, 96, 90, 96, 90, 90, 90],
    [90, 96,103, 97, 94, 97,103, 96, 90],
    [92, 98, 99,103, 97,103, 99, 98, 92],
    [93,108,100,107,100,107,100,108, 93],
    [90,100, 99,103,104,103, 99,100, 90],
    [90, 98,101,102,103,102,101, 98, 90],
    [92, 94, 98, 95, 98, 95, 98, 94, 92],
    [93, 92, 94, 95, 92, 95, 94, 92, 93],
    [85, 90, 92, 93, 78, 93, 92, 90, 85],
    [88, 85, 90, 88, 90, 88, 90, 85, 88],
  ],
  C: [
    [100,100, 96, 91, 90, 91, 96,100,100],
    [ 98, 98, 96, 92, 89, 92, 96, 98, 98],
    [ 97, 97, 96, 91, 92, 91, 96, 97, 97],
    [ 96, 99, 99, 98,100, 98, 99, 99, 96],
    [ 96, 96, 96, 96,100, 96, 96, 96, 96],
    [ 95, 96, 99, 96,100, 96, 99, 96, 95],
    [ 96, 96, 96, 96, 96, 96, 96, 96, 96],
    [ 97, 96,100, 99,101, 99,100, 96, 97],
    [ 96, 97, 98, 98, 98, 98, 98, 97, 96],
    [ 96, 96, 97, 99, 99, 99, 97, 96, 96],
  ],
  P: [
    [  9,  9,  9, 11, 13, 11,  9,  9,  9],
    [ 19, 24, 34, 42, 44, 42, 34, 24, 19],
    [ 19, 24, 32, 37, 37, 37, 32, 24, 19],
    [ 19, 23, 27, 29, 30, 29, 27, 23, 19],
    [ 14, 18, 20, 27, 29, 27, 20, 18, 14],
    [  7,  0, 13,  0, 16,  0, 13,  0,  7],
    [  7,  0,  7,  0, 15,  0,  7,  0,  7],
    [  0,  0,  0,  0,  0,  0,  0,  0,  0],
    [  0,  0,  0,  0,  0,  0,  0,  0,  0],
    [  0,  0,  0,  0,  0,  0,  0,  0,  0],
  ],
  A: [
    [0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0],[0,0,0,20,0,20,0,0,0],[0,0,0,0,23,0,0,0,0],
    [0,0,0,20,0,20,0,0,0],
  ],
  B: [
    [0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],[0,0,20,0,0,0,20,0,0],
    [0,0,0,0,0,0,0,0,0],[18,0,0,0,23,0,0,0,18],[0,0,0,0,0,0,0,0,0],
    [0,0,20,0,0,0,20,0,0],
  ],
  K: [
    [0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0],[0,0,0,1,1,1,0,0,0],[0,0,0,2,2,2,0,0,0],
    [0,0,0,11,15,11,0,0,0],
  ],
};

function isEndgame(board) {
  let total = 0;
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (p && p.type !== 'K') total += PIECE_VALUE[p.type] || 0;
    }
  return total < 2000;
}

function evaluate(board, useTable) {
  const endgame = useTable && isEndgame(board);
  const values = endgame ? ENDGAME_VALUE : PIECE_VALUE;
  let score = 0;
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 9; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      const isRed = piece.color === 'red';
      const base  = values[piece.type] || 0;
      let pos = 0;
      if (useTable && POS_TABLE[piece.type]) {
        const tr = isRed ? (9 - r) : r;
        const tc = isRed ? c : (8 - c);
        pos = POS_TABLE[piece.type][tr]?.[tc] || 0;
      }
      score += isRed ? (base + pos) : -(base + pos);
    }
  return score;
}

function orderMoves(board, moves, useTable) {
  const scored = new Array(moves.length);
  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i];
    let priority = 0;
    const captured = board[mv.tr][mv.tc];
    if (captured) priority += 10000 + (PIECE_VALUE[captured.type] || 0);
    if (useTable) {
      const piece = board[mv.fr][mv.fc];
      if (piece && POS_TABLE[piece.type]) {
        const isRed = piece.color === 'red';
        const tr = isRed ? (9 - mv.tr) : mv.tr;
        const tc = isRed ? mv.tc : (8 - mv.tc);
        priority += (POS_TABLE[piece.type][tr]?.[tc] || 0);
      }
    }
    scored[i] = { mv, priority };
  }
  scored.sort((a, b) => b.priority - a.priority);
  return scored.map(x => x.mv);
}

function quiescence(board, alpha, beta, maximizing, depth) {
  const standPat = evaluate(board, true);
  if (depth <= 0) return standPat;

  if (maximizing) {
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;
  } else {
    if (standPat <= alpha) return alpha;
    if (standPat < beta) beta = standPat;
  }

  const color = maximizing ? 'red' : 'black';
  const allMoves = getAllMoves(board, color);
  const captures = [];
  for (let i = 0; i < allMoves.length; i++) {
    if (board[allMoves[i].tr][allMoves[i].tc]) captures.push(allMoves[i]);
  }
  if (captures.length === 0) return maximizing ? alpha : beta;

  captures.sort((a, b) => (PIECE_VALUE[board[b.tr][b.tc]?.type] || 0) - (PIECE_VALUE[board[a.tr][a.tc]?.type] || 0));

  for (const mv of captures) {
    const saved = board[mv.tr][mv.tc];
    board[mv.tr][mv.tc] = board[mv.fr][mv.fc];
    board[mv.fr][mv.fc] = null;
    const score = quiescence(board, alpha, beta, !maximizing, depth - 1);
    board[mv.fr][mv.fc] = board[mv.tr][mv.tc];
    board[mv.tr][mv.tc] = saved;

    if (maximizing) {
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    } else {
      if (score <= alpha) return alpha;
      if (score < beta) beta = score;
    }
  }
  return maximizing ? alpha : beta;
}

let _deadline = 0;
let _timedOut = false;
let _nodeCount = 0;

function minimax(board, depth, alpha, beta, maximizing, useTable, qDepth) {
  if (_deadline > 0 && (++_nodeCount & 511) === 0) {
    if (Date.now() > _deadline) { _timedOut = true; return evaluate(board, useTable); }
  }
  if (_timedOut) return evaluate(board, useTable);

  if (depth === 0) {
    if (qDepth > 0) return quiescence(board, alpha, beta, maximizing, qDepth);
    return evaluate(board, useTable);
  }

  const color = maximizing ? 'red' : 'black';
  const moves = getAllMoves(board, color);
  if (moves.length === 0) return maximizing ? -99999 : 99999;

  const sorted = useTable ? orderMoves(board, moves, true) : moves;

  if (maximizing) {
    let best = -Infinity;
    for (const mv of sorted) {
      const saved = board[mv.tr][mv.tc];
      board[mv.tr][mv.tc] = board[mv.fr][mv.fc];
      board[mv.fr][mv.fc] = null;
      const score = minimax(board, depth - 1, alpha, beta, false, useTable, qDepth);
      board[mv.fr][mv.fc] = board[mv.tr][mv.tc];
      board[mv.tr][mv.tc] = saved;
      if (_timedOut) return best === -Infinity ? score : best;
      best = Math.max(best, score);
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const mv of sorted) {
      const saved = board[mv.tr][mv.tc];
      board[mv.tr][mv.tc] = board[mv.fr][mv.fc];
      board[mv.fr][mv.fc] = null;
      const score = minimax(board, depth - 1, alpha, beta, true, useTable, qDepth);
      board[mv.fr][mv.fc] = board[mv.tr][mv.tc];
      board[mv.tr][mv.tc] = saved;
      if (_timedOut) return best === Infinity ? score : best;
      best = Math.min(best, score);
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

function bestMove(board, color, difficulty) {
  const config = {
    easy:   { depth: 2, useTable: false, qDepth: 0, randomness: 0.25, timeMs: 0 },
    normal: { depth: 3, useTable: true,  qDepth: 1, randomness: 0.03, timeMs: 3000 },
    hard:   { depth: 4, useTable: true,  qDepth: 3, randomness: 0,    timeMs: 8000 },
    hell:   { depth: 6, useTable: true,  qDepth: 4, randomness: 0,    timeMs: 12000 },
  };
  const cfg = config[difficulty] || config.normal;
  const maximizing = color === 'red';

  const moves = getAllMoves(board, color);
  if (moves.length === 0) return null;

  _deadline = cfg.timeMs > 0 ? Date.now() + cfg.timeMs : 0;
  _timedOut = false;
  _nodeCount = 0;

  const sorted = cfg.useTable ? orderMoves(board, moves, true)
                              : [...moves].sort(() => Math.random() - 0.5);

  if (cfg.randomness > 0 && Math.random() < cfg.randomness && sorted.length > 1) {
    return sorted[Math.floor(Math.random() * Math.min(sorted.length, 5))];
  }

  let bestVal = maximizing ? -Infinity : Infinity;
  let bestMv  = sorted[0];

  for (const mv of sorted) {
    const saved = board[mv.tr][mv.tc];
    board[mv.tr][mv.tc] = board[mv.fr][mv.fc];
    board[mv.fr][mv.fc] = null;
    const score = minimax(board, cfg.depth - 1, -Infinity, Infinity, !maximizing, cfg.useTable, cfg.qDepth);
    board[mv.fr][mv.fc] = board[mv.tr][mv.tc];
    board[mv.tr][mv.tc] = saved;

    if (maximizing ? score > bestVal : score < bestVal) {
      bestVal = score;
      bestMv  = mv;
    }
    if (_timedOut) break;
  }

  return bestMv;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker 消息处理
// ═══════════════════════════════════════════════════════════════════════════════

self.onmessage = function (e) {
  const { board, color, difficulty } = e.data;
  const mv = bestMove(board, color, difficulty);
  self.postMessage({ move: mv || null });
};
