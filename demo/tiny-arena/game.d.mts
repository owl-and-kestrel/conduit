// Type declarations for game.mjs so TypeScript tests can use it under strict.
export interface GamePlayer {
  id: string;
  token: string;
  name: string;
  color: string;
  x: number;
  y: number;
}

export interface GameScore {
  id: string;
  name: string;
  color: string;
  cells: number;
}

export interface GameMoveResult {
  id: string;
  seq: number;
  x: number;
  y: number;
  painted: boolean;
}

export interface GameSnapshot {
  cols: number;
  rows: number;
  phase: 'lobby' | 'playing' | 'results';
  endsAt: number;
  msLeft: number;
  players: Array<{ id: string; name: string; color: string; x: number; y: number }>;
  board: Array<string | null>;
  scores: GameScore[];
}

export interface Game {
  phase: 'lobby' | 'playing' | 'results';
  endsAt: number;
  lastResults: GameScore[];
  join(name: string, now: number): { ok: true; player: GamePlayer } | { ok: false; error: 'full' };
  auth(id: string, token: string): GamePlayer | null;
  leave(id: string): boolean;
  move(id: string, dir: string, seq: number, now: number): GameMoveResult;
  startRound(now: number): boolean;
  tick(now: number): boolean;
  scores(): GameScore[];
  snapshot(now: number): GameSnapshot;
  playerCount(): number;
}

export declare const COLORS: string[];
export declare const DIRECTIONS: Readonly<Record<'up' | 'down' | 'left' | 'right', { dx: number; dy: number }>>;

export declare function createGame(options?: {
  cols?: number;
  rows?: number;
  roundMs?: number;
  maxPlayers?: number;
}): Game;
