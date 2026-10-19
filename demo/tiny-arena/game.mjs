// Tiny Arena — "Paint the arena" game logic.
//
// Pure computation only: no I/O, no timers. Every method that needs the
// current time takes `now` (milliseconds) as a parameter, so tests can drive
// the clock and the server passes Date.now(). To keep this file honest about
// being server-owned state, it never reads the environment or the clock.
//
// Rules: a 12x12 board, up to 8 players. During a round every step paints the
// cell you land on, stealing it from whoever owned it; walls and other players
// block. Most cells when the round ends wins. Between rounds you can walk
// without painting.

import { randomBytes } from 'node:crypto';

// 8 distinct readable colors (hex without '#'; the web client adds it).
// Chosen to stay distinguishable on a white board.
export const COLORS = ['d62728', '1f77b4', '2ca02c', '9467bd', 'ff7f0e', '17becf', '8c564b', 'e377c2'];

export const DIRECTIONS = Object.freeze({
  up: Object.freeze({ dx: 0, dy: -1 }),
  down: Object.freeze({ dx: 0, dy: 1 }),
  left: Object.freeze({ dx: -1, dy: 0 }),
  right: Object.freeze({ dx: 1, dy: 0 })
});

export function createGame({ cols = 12, rows = 12, roundMs = 45000, maxPlayers = 8 } = {}) {
  let counter = 0;
  let phase = 'lobby';
  let endsAt = 0;
  let lastResults = [];
  // board[y * cols + x] = owning player id or null
  const board = new Array(cols * rows).fill(null);
  const players = new Map(); // id -> player record

  function freeSpawnCell() {
    const corners = [
      { x: 0, y: 0 },
      { x: cols - 1, y: 0 },
      { x: 0, y: rows - 1 },
      { x: cols - 1, y: rows - 1 }
    ];
    for (const corner of corners) {
      if (cellFree(corner.x, corner.y)) return corner;
    }
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        if (cellFree(x, y)) return { x, y };
      }
    }
    return null;
  }

  // A color no current player has (there are as many colors as seats).
  function freeColor() {
    const used = new Set([...players.values()].map((player) => player.color));
    return COLORS.find((color) => !used.has(color)) ?? COLORS[0];
  }

  function cellFree(x, y) {
    for (const player of players.values()) {
      if (player.x === x && player.y === y) return false;
    }
    return true;
  }

  return {
    get phase() { return phase; },
    get endsAt() { return endsAt; },

    join(name, now) {
      if (players.size >= maxPlayers) {
        return { ok: false, error: 'full' };
      }
      const trimmed = String(name ?? '').trim().slice(0, 16);
      const id = `p${counter}`;
      counter += 1;
      const player = {
        id,
        token: randomBytes(8).toString('hex'), // 16 hex chars
        name: trimmed.length > 0 ? trimmed : `Player ${counter}`,
        color: freeColor(),
        x: 0,
        y: 0
      };
      const cell = freeSpawnCell();
      if (!cell) {
        return { ok: false, error: 'full' };
      }
      player.x = cell.x;
      player.y = cell.y;
      players.set(id, player);
      return { ok: true, player: { ...player } };
    },

    auth(id, token) {
      const player = players.get(id);
      return player && player.token === token ? { ...player } : null;
    },

    leave(id) {
      return players.delete(id);
    },

    // One step. Walls and cells held by another player block the move (the
    // position is unchanged but the result still carries the current spot, so
    // the client stays in sync with the server as the source of truth).
    // Painting happens only while a round is playing; in lobby/results the
    // dot walks without paint.
    move(id, dir, seq, now) {
      const step = DIRECTIONS[dir];
      if (!step) {
        throw new Error(`invalid direction: ${String(dir)}`);
      }
      const player = players.get(id);
      if (!player) {
        throw new Error(`unknown player: ${id}`);
      }
      const nx = player.x + step.dx;
      const ny = player.y + step.dy;
      let painted = false;
      if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && cellFree(nx, ny)) {
        player.x = nx;
        player.y = ny;
        if (phase === 'playing') {
          const index = ny * cols + nx;
          if (board[index] !== id) {
            board[index] = id; // paint, including stealing other players' cells
            painted = true;
          }
        }
      }
      return { id, seq, x: player.x, y: player.y, painted };
    },

    startRound(now) {
      if (phase === 'playing') {
        return false;
      }
      phase = 'playing';
      board.fill(null);
      // Everyone starts owning the cell they stand on.
      for (const player of players.values()) board[player.y * cols + player.x] = player.id;
      endsAt = now + roundMs;
      return true;
    },

    // True once the round just ended; the caller owns the announcement.
    tick(now) {
      if (phase === 'playing' && now >= endsAt) {
        phase = 'results';
        lastResults = this.scores();
        return true;
      }
      return false;
    },

    scores() {
      const counts = new Map();
      for (const owner of board) {
        if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
      }
      const list = [];
      for (const player of players.values()) {
        list.push({ id: player.id, name: player.name, color: player.color, cells: counts.get(player.id) ?? 0 });
      }
      list.sort((a, b) => b.cells - a.cells || a.id.localeCompare(b.id));
      return list;
    },

    get lastResults() { return lastResults; },

    snapshot(now) {
      return {
        cols,
        rows,
        phase,
        endsAt,
        msLeft: phase === 'playing' ? Math.max(0, endsAt - now) : 0,
        players: [...players.values()].map((player) => ({ id: player.id, name: player.name, color: player.color, x: player.x, y: player.y })),
        board: board.slice(),
        scores: this.scores()
      };
    },

    playerCount() {
      return players.size;
    }
  };
}
