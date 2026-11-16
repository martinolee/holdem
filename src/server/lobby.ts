/* The lobby: one object for the whole server, holding the list of open rooms.
   Rooms exist only because the lobby issued them, so this list is also the
   answer to "does this room exist?" — see the room gate in table.ts.
   Same shape as Table: hibernating sockets, auto-answered pings, one alarm. */

import { DurableObject } from 'cloudflare:workers';
import { cleanName } from '../shared/engine';
import {
  PROTOCOL, ROOM_NAME_MAX,
  type ErrCode, type LobbyClientMsg, type LobbyServerMsg, type RoomBrief,
} from '../shared/protocol';
import { makePwRecord, validPwShape, type PwRecord } from './password';
import type { Env } from './worker';

const MAX_LOBBY_SOCKETS = 200;
const MAX_ROOMS = 30;        // rooms on the server at once
const MAX_PER_IP = 3;        // rooms one address may hold at once
const CREATE_PER_MIN = 3;    // rooms one address may create per minute
const CODE_ABC = 'abcdefghjkmnpqrstuvwxyz23456789';  // no look-alike characters
const CODE_LEN = 6;
const CODE_TRIES = 5;

/** What the lobby keeps per room. `pw` never leaves this object. */
export interface RoomRec {
  code: string;
  name: string;
  pw: PwRecord | null;
  /** Who created it, for the per-address cap. Never published. */
  ip: string;
  seated: number;
  /** Connections that passed the password; see §8.4 of the design. */
  online: number;
  createdAt: number;
  lastSeated: number;
}

type Rooms = Record<string, RoomRec>;

interface Attachment {
  /** From CF-Connecting-IP. The browser token is attacker-controlled, so limits key on this. */
  ip: string;
}

export class Lobby extends DurableObject<Env> {
  rooms: Rooms = {};
  private rate = new Map<WebSocket, { n: number; t: number }>();
  /** Recent creation times per address. In memory only: the window is a minute,
      and losing it to hibernation costs nothing the room caps do not already hold. */
  private creates = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Pings from the browser are answered by the runtime without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.rooms = (await ctx.storage.get<Rooms>('rooms')) ?? {};
    });
  }

  /* ---------------- connections ---------------- */

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket 연결만 받습니다.', { status: 426 });
    if (this.ctx.getWebSockets().length >= MAX_LOBBY_SOCKETS) {
      return new Response('대기실 접속자가 너무 많습니다.', { status: 503 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ip: req.headers.get('CF-Connecting-IP') ?? '' } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string' || data.length > 2048) return;
    const now = Date.now();
    const r = this.rate.get(ws) ?? { n: 0, t: now };
    if (now - r.t > 5000) { r.n = 0; r.t = now; }
    r.n += 1; this.rate.set(ws, r);
    if (r.n > 30) return; // more than 30 messages in 5 s: drop silently
    let m: LobbyClientMsg;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') return;
    await this.handle(ws, m);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch { /* already closed */ }
    this.rate.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.rate.delete(ws);
  }

  /* ---------------- messages ---------------- */

  private async handle(ws: WebSocket, m: LobbyClientMsg): Promise<void> {
    switch (m.t) {
      case 'hello':
        // A tab opened before the last deploy speaks the old shape: tell it to reload.
        if (m.v !== PROTOCOL) return this.send(ws, { t: 'reload' });
        return this.send(ws, { t: 'rooms', rooms: this.brief() });
      case 'create':
        return this.create(ws, m);
      default:
        return;
    }
  }

  /* ---------------- making a room ---------------- */

  private async create(ws: WebSocket, m: Extract<LobbyClientMsg, { t: 'create' }>): Promise<void> {
    const ip = this.att(ws).ip;
    const now = Date.now();

    const name = cleanName(m.name, ROOM_NAME_MAX);
    if (!name) return this.err(ws, 'name', '방 이름을 한 글자 이상 입력해 주세요.');

    // An empty string means "no password", which is not the same as a bad one.
    const wants = m.password !== undefined && m.password !== null && m.password !== '';
    if (wants && !validPwShape(m.password)) {
      return this.err(ws, 'pw_wrong', '비밀번호는 4자에서 32자 사이로 정해 주세요.');
    }

    const all = Object.values(this.rooms);
    if (all.length >= MAX_ROOMS) {
      return this.err(ws, 'cap', '지금은 방이 가득 찼습니다. 잠시 뒤에 다시 시도해 주세요.');
    }
    if (all.filter(r => r.ip === ip).length >= MAX_PER_IP) {
      return this.err(ws, 'cap', `한 번에 가질 수 있는 방은 ${MAX_PER_IP}개까지입니다.`);
    }
    const recent = (this.creates.get(ip) ?? []).filter(t => now - t < 60_000);
    if (recent.length >= CREATE_PER_MIN) {
      return this.err(ws, 'rate', '방을 너무 빨리 만들고 있습니다. 잠시 뒤에 다시 시도해 주세요.');
    }

    const pw = wants ? await makePwRecord(m.password as string) : null;

    // The table is initialised first: only a table that accepts the name is listed,
    // so a code collision never attaches this password to a table already in use.
    let code = '';
    for (let i = 0; i < CODE_TRIES && !code; i++) {
      const c = this.newCode();
      if (this.rooms[c]) continue;
      if (await this.env.TABLES.get(this.env.TABLES.idFromName(c)).init(c, name, pw)) code = c;
    }
    if (!code) return this.err(ws, 'cap', '방을 만들지 못했습니다. 잠시 뒤에 다시 시도해 주세요.');

    recent.push(now);
    this.creates.set(ip, recent);
    this.rooms[code] = { code, name, pw, ip, seated: 0, online: 0, createdAt: now, lastSeated: now };
    await this.save();
    this.send(ws, { t: 'created', code });
    this.publish();
  }

  newCode(): string {
    const b = crypto.getRandomValues(new Uint8Array(CODE_LEN));
    return Array.from(b, x => CODE_ABC[x % CODE_ABC.length]).join('');
  }

  /* ---------------- the list ---------------- */

  /** Rooms with people first, then the ones used most recently. */
  private brief(): RoomBrief[] {
    return Object.values(this.rooms)
      .sort((a, b) => b.seated - a.seated || b.lastSeated - a.lastSeated)
      .map(r => ({ code: r.code, name: r.name, seated: r.seated, online: r.online, hasPw: !!r.pw }));
  }

  private publish(): void {
    const rooms = this.brief();
    for (const ws of this.ctx.getWebSockets()) this.send(ws, { t: 'rooms', rooms });
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put('rooms', this.rooms);
  }

  private att(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? { ip: '' };
  }

  private err(ws: WebSocket, code: ErrCode, msg: string): void {
    this.send(ws, { t: 'error', code, msg });
  }

  private send(ws: WebSocket, m: LobbyServerMsg): void {
    try { ws.send(JSON.stringify(m)); } catch { /* closed */ }
  }
}
