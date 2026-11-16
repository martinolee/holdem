import { expect } from 'vitest';

/** Opens a WebSocket against a Durable Object stub and asserts the handshake. */
export async function connect(stub: { fetch: (url: string, init?: RequestInit) => Promise<Response> }, path: string) {
  const res = await stub.fetch(`https://x${path}`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

/**
 * Buffers everything the socket sends, so a test can await messages in order
 * without racing the listener against the send.
 */
export function reader(ws: WebSocket) {
  const seen: string[] = [];
  const waiting: ((raw: string) => void)[] = [];
  ws.addEventListener('message', e => {
    const raw = e.data as string;
    const w = waiting.shift();
    if (w) w(raw);
    else seen.push(raw);
  });
  const raw = () =>
    seen.length ? Promise.resolve(seen.shift()!) : new Promise<string>(r => waiting.push(r));
  return {
    raw,
    next: async () => JSON.parse(await raw()),
    /** How many messages arrived and were never awaited. */
    pending: () => seen.length,
  };
}

/** Resolves once the runtime has drained whatever is already queued. */
export const settle = () => scheduler.wait(50);
