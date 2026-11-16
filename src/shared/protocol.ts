// Messages between the browser and the Durable Objects, over one WebSocket each:
// a table (/ws/<code>) and the lobby (/lobby/ws).
// Bump PROTOCOL whenever a message shape changes: tabs opened before a deploy
// are told to reload instead of talking past the new server.

// 2: rooms are issued by the lobby and may carry a password.
// 3: sitting down mid-game picks an entry, and a view says whether a raise is open.
export const PROTOCOL = 3;
export const NSEAT = 6;
export const ROOM_NAME_MAX = 20;

export type ActType = 'fold' | 'check' | 'call' | 'raise';

/** Why a request was refused. The client picks its screen from this, not from the text. */
export type ErrCode =
  | 'token'        // the browser's player token is malformed
  | 'name'         // empty after trimming, or otherwise unusable
  | 'full'         // no free seat / no free socket
  | 'no_room'      // that code was never issued, or the room has been retired
  | 'pw_required'  // the room is locked and no password was sent
  | 'pw_wrong'     // wrong password, or one outside 4..32 characters
  | 'pw_wait'      // too many wrong guesses from this address
  | 'rate'         // creating rooms too quickly
  | 'cap';         // room limit reached, for the server or for this address

export type ClientMsg =
  | { t: 'hello'; v: number; token: string; password?: string }
  /** `entry` applies only when joining a game already under way: pay a big
      blind to come in now, or wait for the button to pass. */
  | { t: 'sit'; name: string; seat?: number; entry?: 'post' | 'wait' }
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
  /** Seated but waiting for the button to pass before being dealt in. */
  waiting: boolean;
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
  /** False once they have acted, until a full raise reopens the betting. A
      short all-in leaves it false: they may call or fold, but not raise. */
  mayRaise: boolean;
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
  | { t: 'error'; code: ErrCode; msg: string }
  | { t: 'reload' };

/* ================= lobby ================= */

/** One row of the lobby list. The password salt and hash never appear here. */
export interface RoomBrief {
  code: string;
  name: string;
  seated: number;
  /** Connections that have passed the password, so a locked room leaks nothing. */
  online: number;
  hasPw: boolean;
}

export type LobbyClientMsg =
  | { t: 'hello'; v: number }
  | { t: 'create'; name: string; password?: string };

export type LobbyServerMsg =
  | { t: 'rooms'; rooms: RoomBrief[] }
  | { t: 'created'; code: string }
  | { t: 'error'; code: ErrCode; msg: string }
  | { t: 'reload' };
