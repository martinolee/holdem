import type { Lobby } from './lobby';
import type { Table } from './table';
export { Lobby } from './lobby';
export { Table } from './table';

export interface Env {
  TABLES: DurableObjectNamespace<Table>;
  LOBBY: DurableObjectNamespace<Lobby>;
  ASSETS: Fetcher;
  /** Optional overrides (wrangler.jsonc "vars" or `wrangler dev --var`). */
  SB?: string;
  BB?: string;
  BUYIN?: string;
  TURN_SECS?: string;
}

const TABLE_WS = /^\/ws\/([a-z0-9]{4,16})$/;
const LOBBY_WS = '/lobby/ws';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // The request is forwarded as-is, so CF-Connecting-IP reaches the object:
    // rate and room limits key on the address, never on the browser's token.
    if (url.pathname === LOBBY_WS) {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('WebSocket 연결만 받습니다.', { status: 426 });
      }
      // One lobby for the whole server.
      return env.LOBBY.get(env.LOBBY.idFromName('lobby')).fetch(req);
    }
    const m = url.pathname.match(TABLE_WS);
    if (m) {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('WebSocket 연결만 받습니다.', { status: 426 });
      }
      // One Durable Object per table code: everyone opening /t/<code> lands in the same object.
      const stub = env.TABLES.get(env.TABLES.idFromName(m[1]));
      return stub.fetch(req);
    }
    // Everything else is the static client (public/), with /t/<code> falling back to index.html.
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
