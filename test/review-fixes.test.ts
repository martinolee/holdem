/* Regressions found by the whole-branch review. Each test here failed before
   its fix and describes the sequence that broke. */

import { env, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { PROTOCOL } from '../src/shared/protocol';
import { makePwRecord } from '../src/server/password';
import { connect, reader, settle } from './helpers';

const table = (code: string) => env.TABLES.get(env.TABLES.idFromName(code));
const lobby = (name: string) => env.LOBBY.get(env.LOBBY.idFromName(name));
const TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee';

const hello = (ws: WebSocket, password?: string, token = TOKEN) =>
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, token, ...(password === undefined ? {} : { password }) }));

async function openRoom(code: string, password?: string) {
  const stub = table(code);
  const pw = password === undefined ? null : await makePwRecord(password);
  expect(await stub.init(code, '테스트 방', pw)).toBe(true);
  return stub;
}

const upgrade = (stub: { fetch: (u: string, i?: RequestInit) => Promise<Response> }, path: string) =>
  stub.fetch(`https://x${path}`, { headers: { Upgrade: 'websocket' } });

/* ---------- Critical: waiting sockets must not lock a room shut ---------- */

it('대기 중인 소켓이 정원을 채워도 새 접속을 거절하지 않는다', async () => {
  const stub = await openRoom('grief-1', 'hunter2');
  for (let i = 0; i < 10; i++) await connect(stub, '/ws/grief-1');
  expect((await upgrade(stub, '/ws/grief-1')).status).toBe(101);
});

it('비밀번호를 아는 사람은 대기열이 차 있어도 들어간다', async () => {
  const stub = await openRoom('grief-2', 'hunter2');
  for (let i = 0; i < 10; i++) await connect(stub, '/ws/grief-2');
  const ws = await connect(stub, '/ws/grief-2');
  const r = reader(ws);
  hello(ws, 'hunter2');
  expect(await r.next()).toMatchObject({ t: 'state' });
});

it('비밀번호 없는 방도 침묵하는 소켓에 막히지 않는다', async () => {
  const stub = await openRoom('grief-3');
  for (let i = 0; i < 10; i++) await connect(stub, '/ws/grief-3');
  const ws = await connect(stub, '/ws/grief-3');
  const r = reader(ws);
  hello(ws);
  expect(await r.next()).toMatchObject({ t: 'state' });
});

it('없는 방이라고 답한 소켓은 끊는다', async () => {
  const ws = await connect(table('no-such-room'), '/ws/no-such-room');
  const r = reader(ws);
  const closed = new Promise<boolean>(res => {
    ws.addEventListener('close', () => res(true));
    setTimeout(() => res(false), 2000);
  });
  hello(ws);
  expect(await r.next()).toMatchObject({ t: 'error', code: 'no_room' });
  expect(await closed).toBe(true);
});

/* ---------- Important: the lobby must not be told a stale headcount ---------- */

it('나가는 소켓은 로비에 보고하는 인원수에서 빠진다', async () => {
  const stub = await openRoom('leaving');
  for (const tok of ['11111111-bbbb-cccc-dddd-eeeeeeee', '22222222-bbbb-cccc-dddd-eeeeeeee']) {
    const ws = await connect(stub, '/ws/leaving');
    const r = reader(ws);
    hello(ws, undefined, tok);
    await r.next();
  }

  const reported = await runInDurableObject(stub, async (inst: any) => {
    const socks = inst.ctx.getWebSockets();
    inst.lastReport = '';
    inst.broadcast(socks[0]);   // the socket on its way out
    return inst.lastReport;
  });

  expect(reported).toBe('0|1');
});

/* ---------- Important: wrong-password records must decay ---------- */

it('만료된 비밀번호 실패 기록을 알람이 지운다', async () => {
  const stub = await openRoom('decay-1', 'hunter2');
  await runInDurableObject(stub, async (inst: any) => {
    inst.s.pwFails = {
      old: { n: 7, until: Date.now() - 60 * 60_000, at: Date.now() - 60 * 60_000 },
      stale: { n: 1, until: 0, at: Date.now() - 60 * 60_000 },
      fresh: { n: 1, until: 0, at: Date.now() },
    };
    await inst.ctx.storage.put('s', inst.s);
    await inst.alarm();
  });

  const left = await runInDurableObject(stub, async (inst: any) => Object.keys(inst.s.pwFails ?? {}));
  expect(left).toEqual(['fresh']);
});

it('한참 전에 틀린 기록만으로 바로 잠기지 않는다', async () => {
  const stub = await openRoom('decay-2', 'hunter2');
  await runInDurableObject(stub, async (inst: any) => {
    // Four strikes from long ago: one fresh mistake must not be the fifth.
    inst.s.pwFails = { '': { n: 4, until: 0, at: Date.now() - 60 * 60_000 } };
    await inst.ctx.storage.put('s', inst.s);
  });

  const ws = await connect(stub, '/ws/decay-2');
  const r = reader(ws);
  hello(ws, 'wrong');
  expect(await r.next()).toMatchObject({ t: 'error', code: 'pw_wrong' });
  hello(ws, 'hunter2');
  expect(await r.next()).toMatchObject({ t: 'state' });
});

/* ---------- Important: a room must not vanish while its table lives ---------- */

it('테이블 정리에 실패하면 방을 목록에 남긴다', async () => {
  const stub = lobby('retire-fails');
  const now = Date.now();
  await runInDurableObject(stub, async (inst: any, state) => {
    inst.rooms = {
      stuck: {
        code: 'stuck', name: '안 지워지는 방', pw: null, ip: 'x',
        seated: 0, online: 0, createdAt: now, lastSeated: now - 60 * 60_000, everSeated: true,
      },
    };
    await state.storage.put('rooms', inst.rooms);
    inst.env = {
      ...inst.env,
      TABLES: { idFromName: () => 'x', get: () => ({ retire: async () => { throw new Error('객체 과부하'); } }) },
    };
    await inst.alarm();
  });

  const left = await runInDurableObject(stub, async (inst: any) => Object.keys(inst.rooms));
  expect(left).toEqual(['stuck']);
});

/* ---------- Important: init must not inherit a previous table ---------- */

it('init은 남아 있던 좌석과 칩을 함께 지운다', async () => {
  const stub = table('leftover');
  await runInDurableObject(stub, async (inst: any) => {
    // A table from before rooms carried a name: no name, but chips on the felt.
    inst.s.seats[0] = {
      token: 'ffffffff-bbbb-cccc-dddd-eeeeeeee', name: '옛 플레이어', stack: 9999,
      buyins: 1, away: false, idle: false, missed: 0, leaving: false, lastSeen: Date.now(),
    };
    inst.s.handNo = 7;
    await inst.ctx.storage.put('s', inst.s);
  });

  expect(await stub.init('leftover', '새 방', null)).toBe(true);

  const after = await runInDurableObject(stub, async (inst: any) => ({
    seated: inst.s.seats.filter(Boolean).length,
    handNo: inst.s.handNo,
    name: inst.s.name,
  }));
  expect(after).toEqual({ seated: 0, handNo: 0, name: '새 방' });
});
