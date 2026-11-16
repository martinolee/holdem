/* The lobby: one object for the whole server, holding the list of open rooms.
   Rooms exist only because the lobby issued them, so this list is also the
   answer to "does this room exist?" — see the room gate in table.ts.
   Same shape as Table: hibernating sockets, auto-answered pings, one alarm. */

import { DurableObject } from 'cloudflare:workers';
import {
  PROTOCOL,
  type LobbyClientMsg, type LobbyServerMsg, type RoomBrief,
} from '../shared/protocol';
import type { PwRecord } from './password';
import type { Env } from './worker';

const MAX_LOBBY_SOCKETS = 200;

/** What the lobby keeps per room. `pw` never leaves this object. */
export interface RoomRec {
  code: string;
  name: string;
  pw: PwRecord | null;
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
      default:
        return;
    }
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

  private send(ws: WebSocket, m: LobbyServerMsg): void {
    try { ws.send(JSON.stringify(m)); } catch { /* closed */ }
  }
}
