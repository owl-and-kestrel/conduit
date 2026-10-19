import { describe, expect, it } from 'vitest';
import { COLORS, createGame } from '../../demo/tiny-arena/game.mjs';

describe('Tiny Arena game logic', () => {
  it('spawns players in the corners with distinct colors and tokens', () => {
    const game = createGame();
    const spots = [];
    for (let i = 0; i < 4; i += 1) {
      const joined = game.join(`p${i}`, 0);
      if (!joined.ok) throw new Error('join failed');
      spots.push([joined.player.x, joined.player.y]);
      expect(joined.player.token).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(spots).toEqual([[0, 0], [11, 0], [0, 11], [11, 11]]);
    const fifth = game.join('', 0);
    expect(fifth.ok && fifth.player).toMatchObject({ x: 1, y: 0, name: 'Player 5' });
    const colors = game.snapshot(0).players.map((player) => player.color);
    expect(new Set(colors).size).toBe(5);
  });

  it('trims names to 16 characters and refuses a ninth player', () => {
    const game = createGame();
    const first = game.join('  a-very-long-player-name  ', 0);
    expect(first.ok && first.player.name).toBe('a-very-long-play');
    for (let i = 1; i < 8; i += 1) expect(game.join(`p${i}`, 0).ok).toBe(true);
    expect(game.join('ninth', 0)).toEqual({ ok: false, error: 'full' });
    expect(game.playerCount()).toBe(8);
  });

  it('gives a free color back to the next player', () => {
    const game = createGame();
    const a = game.join('a', 0);
    game.join('b', 0);
    if (!a.ok) throw new Error('join failed');
    game.leave(a.player.id);
    const c = game.join('c', 0);
    expect(c.ok && c.player.color).toBe(COLORS[0]);
  });

  it('authenticates only the exact id and token', () => {
    const game = createGame();
    const joined = game.join('a', 0);
    if (!joined.ok) throw new Error('join failed');
    expect(game.auth(joined.player.id, joined.player.token)?.id).toBe(joined.player.id);
    expect(game.auth(joined.player.id, 'f'.repeat(16))).toBeNull();
    expect(game.auth('p99', joined.player.token)).toBeNull();
  });

  it('blocks walls and other players, and rejects bad directions', () => {
    const game = createGame({ cols: 3, rows: 1 });
    const a = game.join('a', 0);
    const b = game.join('b', 0);
    if (!a.ok || !b.ok) throw new Error('join failed');
    expect(game.move(a.player.id, 'left', 1, 0)).toEqual({ id: a.player.id, seq: 1, x: 0, y: 0, painted: false });
    expect(game.move(a.player.id, 'up', 2, 0)).toMatchObject({ x: 0, y: 0 });
    expect(game.move(a.player.id, 'right', 3, 0)).toMatchObject({ x: 1, y: 0 });
    // b sits at (2,0): a cannot step onto it.
    expect(game.move(a.player.id, 'right', 4, 0)).toMatchObject({ x: 1, y: 0 });
    expect(() => game.move(a.player.id, 'diagonal', 5, 0)).toThrow(/invalid direction/);
    expect(() => game.move('p42', 'up', 6, 0)).toThrow(/unknown player/);
  });

  it('paints only during a round, steals cells and scores them', () => {
    const game = createGame({ cols: 4, rows: 4, roundMs: 1000 });
    const a = game.join('a', 0);
    const b = game.join('b', 0);
    if (!a.ok || !b.ok) throw new Error('join failed');
    // Lobby: walking does not paint.
    expect(game.move(a.player.id, 'right', 1, 0).painted).toBe(false);
    expect(game.snapshot(0).board.every((owner) => owner === null)).toBe(true);

    expect(game.startRound(100)).toBe(true);
    expect(game.startRound(150)).toBe(false); // already playing
    let snap = game.snapshot(100);
    expect(snap.phase).toBe('playing');
    expect(snap.msLeft).toBe(1000);
    // Each player owns the cell they stand on at the start.
    expect(snap.board.filter((owner) => owner === a.player.id)).toHaveLength(1);
    expect(snap.board.filter((owner) => owner === b.player.id)).toHaveLength(1);

    expect(game.move(a.player.id, 'down', 2, 200)).toMatchObject({ x: 1, y: 1, painted: true });
    expect(game.move(a.player.id, 'down', 3, 200)).toMatchObject({ x: 1, y: 2, painted: true });
    // b walks over a's cells and steals them.
    expect(game.move(b.player.id, 'left', 1, 300)).toMatchObject({ x: 2, y: 0, painted: true });
    expect(game.move(b.player.id, 'down', 2, 300)).toMatchObject({ x: 2, y: 1, painted: true });
    expect(game.move(b.player.id, 'left', 3, 300)).toMatchObject({ x: 1, y: 1, painted: true });
    // Re-entering your own cell is not a paint.
    expect(game.move(b.player.id, 'right', 4, 300)).toMatchObject({ x: 2, y: 1, painted: false });

    expect(game.scores().map((score) => [score.id, score.cells])).toEqual([[b.player.id, 4], [a.player.id, 2]]);
    expect(game.tick(1099)).toBe(false);
    expect(game.tick(1100)).toBe(true);
    expect(game.tick(1200)).toBe(false);
    snap = game.snapshot(1200);
    expect(snap.phase).toBe('results');
    expect(snap.msLeft).toBe(0);
    expect(game.lastResults[0]).toMatchObject({ id: b.player.id, cells: 4 });
    // After the round, walking paints nothing again.
    expect(game.move(b.player.id, 'down', 5, 1300).painted).toBe(false);
  });

  it('keeps a leaver\'s cells on the board but drops them from the scores', () => {
    const game = createGame({ cols: 4, rows: 4 });
    const a = game.join('a', 0);
    if (!a.ok) throw new Error('join failed');
    game.startRound(0);
    game.move(a.player.id, 'right', 1, 1);
    expect(game.leave(a.player.id)).toBe(true);
    expect(game.leave(a.player.id)).toBe(false);
    const snap = game.snapshot(2);
    expect(snap.board.filter((owner) => owner === a.player.id)).toHaveLength(2);
    expect(snap.scores).toEqual([]);
    expect(snap.players).toEqual([]);
  });

  it('snapshots carry no tokens and a copy of the board', () => {
    const game = createGame();
    game.join('a', 0);
    const snap = game.snapshot(0);
    expect(JSON.stringify(snap)).not.toContain('token');
    snap.board[0] = 'tampered';
    expect(game.snapshot(0).board[0]).toBeNull();
  });
});
