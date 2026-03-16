/**
 * chess/ai.js — 中国象棋 AI（Minimax + Alpha-Beta 剪枝）
 *
 * 难度档位通过搜索深度控制：
 *   easy   → depth 2（无评估表，纯子力）
 *   normal → depth 3（Alpha-Beta + 子力）
 *   hard   → depth 5（Alpha-Beta + 子力 + 位置评估表）
 *
 * 对外接口：
 *   ChessAI.bestMove(board, color, difficulty) → { from, to } | null
 */

const ChessAI = (function () {
  'use strict';

  // ── 子力价值 ───────────────────────────────────────────────────────────────
  const PIECE_VALUE = {
    K: 10000, // 将/帅
    A: 120,   // 士/仕
    B: 150,   // 象/相
    R: 600,   // 車
    N: 300,   // 马
    C: 280,   // 炮
    P: 70,    // 兵/卒
  };

  // ── 位置评估表（行0=黑方底线，行9=红方底线，列0~8）─────────────────────────
  // 值越大越好（从红方视角，黑方取反）
  const POS_TABLE = {
    // 车
    R: [
      [14,14,12,18,16,14,12,18,12,14],
      [16,20,18,24,26,20,24,26,20,16],
      [12,12,12,18,18,12,12,18,12,12],
      [12,18,16,22,22,16,16,22,16,12],
      [12,12,12,18,18,12,12,18,12,12],
      [12,18,16,22,22,16,16,22,16,12],
      [12,12,12,18,18,12,12,18,12,12],
      [16,20,18,24,26,20,24,26,20,16],
      [14,14,12,18,16,14,12,18,12,14],
      [14,14,12,18,16,14,12,18,12,14],
    ],
    // 马
    N: [
      [ 4, 8,16,12,4,12,16, 8, 4,0],
      [ 4,10,28,16,8,16,28,10, 4,0],
      [ 8,16,20,24,8,24,20,16, 8,4],
      [ 4,12,16,14,12,14,16,12, 4,4],
      [ 4,12,20,20,8,20,20,12, 4,4],
      [ 4,12,20,20,8,20,20,12, 4,4],
      [ 4,12,16,14,12,14,16,12, 4,4],
      [ 8,16,20,24,8,24,20,16, 8,4],
      [ 4,10,28,16,8,16,28,10, 4,0],
      [ 4, 8,16,12,4,12,16, 8, 4,0],
    ],
    // 炮
    C: [
      [ 6, 4, 0,-10,  -12, -10,  0, 4, 6, 0],
      [ 2, 2, 0, -4,  -14,  -4,  0, 2, 2, 0],
      [ 2, 6, 4,  0,  -10,   0,  4, 6, 2, 0],
      [ 0, 0, 0,  2,   -6,   2,  0, 0, 0, 0],
      [ 0, 0, 0,  2,   -6,   2,  0, 0, 0, 0],
      [-2, 0, 4,  2,   -10,  2,  4, 0,-2, 0],
      [ 0, 0, 0,  2,   -6,   2,  0, 0, 0, 0],
      [ 2, 6, 4,  0,  -10,   0,  4, 6, 2, 0],
      [ 2, 2, 0, -4,  -14,  -4,  0, 2, 2, 0],
      [ 6, 4, 0,-10,  -12, -10,  0, 4, 6, 0],
    ],
    // 兵（红方，行0~4为对方阵营，越深越值钱）
    P: [
      [ 0, 3, 6, 9,12, 9, 6, 3, 0, 0],
      [18,36,56,80,80,80,56,36,18, 0],
      [14,26,42,60,80,60,42,26,14, 0],
      [10,20,30,34,40,34,30,20,10, 0],
      [ 6,12,18,18,20,18,18,12, 6, 0],
      [ 2, 0, 8, 0,16, 0, 8, 0, 2, 0],
      [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ],
  };

  // ── 棋盘评估 ───────────────────────────────────────────────────────────────
  function evaluate(board, useTable) {
    let score = 0;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const piece = board[r][c];
        if (!piece) continue;

        const type  = piece.type;
        const isRed = piece.color === 'red';
        const base  = PIECE_VALUE[type] || 0;
        let pos = 0;

        if (useTable && POS_TABLE[type]) {
          // 红方视角：行 r，列 c（红方在行9底线，黑方在行0底线）
          const tableRow = isRed ? (9 - r) : r;
          const tableCol = isRed ? c : (8 - c);
          const tbl = POS_TABLE[type];
          if (tbl[tableCol] !== undefined) {
            pos = tbl[tableCol][tableRow] || 0;
          }
        }

        const val = base + pos;
        score += isRed ? val : -val;
      }
    }
    return score;
  }

  // ── Minimax + Alpha-Beta ───────────────────────────────────────────────────
  function minimax(board, depth, alpha, beta, maximizing, rules, useTable) {
    if (depth === 0) return evaluate(board, useTable);

    const color = maximizing ? 'red' : 'black';
    const moves = rules.getAllMoves(board, color);

    if (moves.length === 0) {
      return maximizing ? -9999 : 9999;
    }

    if (maximizing) {
      let best = -Infinity;
      for (const mv of moves) {
        const saved = applyMove(board, mv);
        const score = minimax(board, depth - 1, alpha, beta, false, rules, useTable);
        undoMove(board, mv, saved);
        best = Math.max(best, score);
        alpha = Math.max(alpha, best);
        if (beta <= alpha) break;
      }
      return best;
    } else {
      let best = Infinity;
      for (const mv of moves) {
        const saved = applyMove(board, mv);
        const score = minimax(board, depth - 1, alpha, beta, true, rules, useTable);
        undoMove(board, mv, saved);
        best = Math.min(best, score);
        beta = Math.min(beta, best);
        if (beta <= alpha) break;
      }
      return best;
    }
  }

  function applyMove(board, mv) {
    const { fr, fc, tr, tc } = mv;
    const captured = board[tr][tc];
    board[tr][tc] = board[fr][fc];
    board[fr][fc] = null;
    return captured;
  }

  function undoMove(board, mv, captured) {
    const { fr, fc, tr, tc } = mv;
    board[fr][fc] = board[tr][tc];
    board[tr][tc] = captured;
  }

  // ── 对外接口 ───────────────────────────────────────────────────────────────
  /**
   * @param {Array[][]} board   10×9 棋盘，每格为 {type,color} 或 null
   * @param {string}    color   AI 执子颜色（'red'|'black'）
   * @param {string}    difficulty 难度 ('easy'|'normal'|'hard')
   * @param {object}    rules   ChessRules 实例（提供 getAllMoves / isInCheck）
   * @returns {{ fr, fc, tr, tc } | null}
   */
  function bestMove(board, color, difficulty, rules) {
    const depthMap  = { easy: 2, normal: 3, hard: 5 };
    const depth     = depthMap[difficulty] || 3;
    const useTable  = difficulty === 'hard';
    const maximizing = color === 'red';

    const moves = rules.getAllMoves(board, color);
    if (moves.length === 0) return null;

    // 加入随机性避免同一局面永远走同一步（简单模式更随机）
    const shuffled = [...moves].sort(() => Math.random() - 0.5);

    let bestVal = maximizing ? -Infinity : Infinity;
    let bestMv  = shuffled[0];

    for (const mv of shuffled) {
      const saved = applyMove(board, mv);
      const score = minimax(board, depth - 1, -Infinity, Infinity, !maximizing, rules, useTable);
      undoMove(board, mv, saved);

      if (maximizing ? score > bestVal : score < bestVal) {
        bestVal = score;
        bestMv  = mv;
      }
    }

    return bestMv;
  }

  return { bestMove };
})();

window.ChessAI = ChessAI;
