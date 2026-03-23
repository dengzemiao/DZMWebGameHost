/**
 * GAME_REGISTRY — 游戏注册表
 *
 * 新增游戏只需在此添加一条记录，其余代码（大厅、房间外壳）无需修改。
 *
 * 字段说明：
 *   key          游戏唯一标识（与后端 Room.game 字段对应）
 *   name         显示名称
 *   icon         展示图标（emoji 或 图片路径）
 *   desc         简介
 *   maxPlayers   最大参战人数
 *   minPlayers   最少参战人数（达到此数才能开始）
 *   supportsAI   是否支持人机对战
 *   scriptPath   游戏 JS 路径（相对 game-pages/）
 *   cssPath      游戏 CSS 路径（相对 game-pages/）
 */
const GAME_REGISTRY = {
  chess: {
    key: 'chess',
    name: '中国象棋',
    icon: '♟️',
    desc: '经典中国象棋，双人对决或人机对战',
    maxPlayers: 2,
    minPlayers: 2,
    supportsAI: true,
    scriptPath: 'games/chess/game.js',
    cssPath: 'games/chess/game.css',
  },

  // ── 未来游戏在此扩展，room.html / lobby.js 无需改动 ──────────────────────

  gomoku: {
    key: 'gomoku',
    name: '五子棋',
    icon: '⚫',
    desc: '经典五子棋，先连五子者胜（黑白棋，15路棋盘）',
    maxPlayers: 2,
    minPlayers: 2,
    supportsAI: true,
    scriptPath: 'games/gomoku/game.js',
    cssPath: 'games/gomoku/game.css',
  },

  word_spot: {
    key: 'word_spot',
    name: '文字找茬',
    icon: '🔍',
    desc: '海量文字中找出那个不一样的字，1-12人同场竞戒，多关卡赛制',
    maxPlayers: 12,
    minPlayers: 1,
    supportsAI: false,
    scriptPath: 'games/word-spot/game.js',
    cssPath: 'games/word-spot/game.css',
  },

  // ── 继续添加更多游戏 ────────────────────────────────────────────────────────
  // example: {
  //   key: 'example',
  //   name: '示例游戏',
  //   icon: '🎮',
  //   desc: '...',
  //   maxPlayers: 2,
  //   minPlayers: 2,
  //   supportsAI: false,
  //   scriptPath: 'games/example/game.js',
  //   cssPath: 'games/example/game.css',
  // },
};

/**
 * 获取单个游戏配置，不存在则返回 null
 * @param {string} key
 * @returns {object|null}
 */
function getGame(key) {
  return GAME_REGISTRY[key] || null;
}

/**
 * 返回所有游戏配置列表（用于创建房间选择）
 * @returns {object[]}
 */
function getAllGames() {
  return Object.values(GAME_REGISTRY);
}

window.GAME_REGISTRY = GAME_REGISTRY;
window.getGame = getGame;
window.getAllGames = getAllGames;
