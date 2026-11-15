import type { Table } from './table';
export { Table } from './table';

export interface Env {
  TABLES: DurableObjectNamespace<Table>;
  ASSETS: Fetcher;
  /** Optional overrides (wrangler.jsonc "vars" or `wrangler dev --var`). */
  SB?: string;
  BB?: string;
  BUYIN?: string;
  TURN_SECS?: string;
}

const TABLE_WS = /^\/ws\/([a-z0-9]{4,16})$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
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
