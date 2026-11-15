// Messages between the browser and a table's Durable Object, over one WebSocket.
// Bump PROTOCOL whenever a message shape changes: tabs opened before a deploy
// are told to reload instead of talking past the new server.

export const PROTOCOL = 1;
export const NSEAT = 6;

export type ActType = 'fold' | 'check' | 'call' | 'raise';

export type ClientMsg =
  | { t: 'hello'; v: number; token: string }
  | { t: 'sit'; name: string; seat?: number }
  | { t: 'act'; hand: string; seq: number; type: ActType; to?: number }
  | { t: 'rename'; name: string }
  | { t: 'away' }
  | { t: 'back' }
  | { t: 'rebuy' }
  | { t: 'leave' };

/** A log line: plain text, a bold name, or a card. Rendered with textContent only. */
export type LogSeg = string | ['b', string] | ['c', number];
export interface LogEntry { i: number; t: LogSeg[]; c: string }

export interface Cfg { sb: number; bb: number; buyin: number; turn: number }

export interface SeatView {
  name: string;
  stack: number;
  buyins: number;
  away: boolean;
  idle: boolean;
  leaving: boolean;
  online: boolean;
}

export interface PlayerView {
  bet: number;
  total: number;
  folded: boolean;
  allIn: boolean;
  label: string;
  shown: number[] | null;
  won: number;
  win: boolean;
}

export interface Result { pot: string; amount: number; names: string[]; hand: string }

export interface HandView {
  id: string;
  no: number;
  dealer: number;
  order: number[];
  phase: 'bet' | 'over';
  street: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  board: number[];
  pot: number;
  cur: number;
  minR: number;
  toAct: number;
  seq: number;
  turnSecs: number;
  /** Milliseconds left on the current turn when this message was sent. */
  turnLeft: number;
  ps: (PlayerView | null)[];
  hl: number[] | null;
  results: Result[] | null;
  verdict: string;
  runout: boolean;
}

export interface TableView {
  cfg: Cfg;
  seats: (SeatView | null)[];
  handNo: number;
  hand: HandView | null;
  log: LogEntry[];
  online: number;
}

export interface YouView {
  /** Your seat index, or -1 when you are watching. */
  seat: number;
  /** Your two hole cards in the current hand; nobody else's are ever sent before showdown. */
  cards: number[] | null;
}

export type ServerMsg =
  | { t: 'state'; table: TableView; you: YouView }
  | { t: 'error'; code: string; msg: string }
  | { t: 'reload' };
