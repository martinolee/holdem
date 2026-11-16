import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, it, expect } from 'vitest';
import { PROTOCOL } from '../src/shared/protocol';
import { makePwRecord } from '../src/server/password';
import { connect, reader, settle } from './helpers';

const lobby = (name: string) => env.LOBBY.get(env.LOBBY.idFromName(name));
const table = (code: string) => env.TABLES.get(env.TABLES.idFromName(code));
const TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee';

const hello = (ws: WebSocket, password?: string, token = TOKEN) =>
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, token, ...(password === undefined ? {} : { password }) }));

/** The real lobby singleton, which tables report to by name. */
const theLobby = () => lobby('lobby');

async function makeRoom(name: string, password?: string) {
  const ws = await connect(theLobby(), '/lobby/ws');
  const r = reader(ws);
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL }));
  await r.next();
  ws.send(JSON.stringify({ t: 'create', name, ...(password === undefined ? {} : { password }) }));
  let m = await r.next();
  while (m.t === 'rooms') m = await r.next();
  expect(m.t).toBe('created');
  return { code: m.code as string, ws, r };
}

const roomOf = async (code: string) =>
  runInDurableObject(theLobby(), async (inst: any) => inst.rooms[code]);

// These tests must share the real 'lobby' singleton, because that is the one
// tables report to. Clearing its rooms and its rate window keeps the caps from
// carrying over from the test before.
beforeEach(async () => {
  await runInDurableObject(theLobby(), async (inst: any, state) => {
    inst.rooms = {};
    inst.creates.clear();
    await state.storage.put('rooms', inst.rooms);
  });
});

it('사람이 앉으면 로비 목록의 seated가 올라간다', async () => {
  const { code } = await makeRoom('앉는 방');
  const ws = await connect(table(code), `/ws/${code}`);
  const r = reader(ws);
  hello(ws);
  await r.next();
  ws.send(JSON.stringify({ t: 'sit', name: '참가자' }));
  await settle();

  const room = await roomOf(code);
  expect(room.seated).toBe(1);
  expect(room.online).toBe(1);
  expect(room.everSeated).toBe(true);
});

it('인원이 그대로면 로비를 다시 부르지 않는다', async () => {
  const { code } = await makeRoom('조용한 방');
  const stub = table(code);

  const calls = await runInDurableObject(stub, async (inst: any) => {
    const counter = { n: 0 };
    inst.env = {
      ...inst.env,
      LOBBY: { idFromName: () => 'lobby', get: () => ({ report: async () => { counter.n += 1; } }) },
    };
    inst.lastReport = '';
    return counter;
  });

  const ws = await connect(stub, `/ws/${code}`);
  const r = reader(ws);
  hello(ws);
  await r.next();
  await settle();
  const afterJoin = calls.n;

  // Renaming redraws the table but moves nobody, so the lobby learns nothing new.
  ws.send(JSON.stringify({ t: 'rename', name: '다른 이름' }));
  await settle();

  expect(afterJoin).toBeGreaterThan(0);
  expect(calls.n).toBe(afterJoin);
});

it('빈 방은 정해진 시간이 지나면 은퇴한다', async () => {
  const { code } = await makeRoom('버려진 방');

  await runInDurableObject(theLobby(), async (inst: any, state) => {
    const r = inst.rooms[code];
    r.online = 0; r.seated = 0; r.everSeated = true;
    r.lastSeated = Date.now() - 20 * 60_000;
    await state.storage.put('rooms', inst.rooms);
    await inst.alarm();
  });

  expect(await roomOf(code)).toBeUndefined();
});

it('만든 뒤 아무도 앉지 않은 방은 접속이 있어도 은퇴한다', async () => {
  const { code } = await makeRoom('아무도 안 앉은 방');

  await runInDurableObject(theLobby(), async (inst: any, state) => {
    const r = inst.rooms[code];
    r.online = 2; r.seated = 0; r.everSeated = false;
    r.createdAt = Date.now() - 40 * 60_000;
    r.lastSeated = r.createdAt;
    await state.storage.put('rooms', inst.rooms);
    await inst.alarm();
  });

  expect(await roomOf(code)).toBeUndefined();
});

it('사람이 앉아 있는 방은 은퇴하지 않는다', async () => {
  const { code } = await makeRoom('진행 중인 방');

  await runInDurableObject(theLobby(), async (inst: any, state) => {
    const r = inst.rooms[code];
    r.online = 2; r.seated = 2; r.everSeated = true;
    r.lastSeated = Date.now();
    r.createdAt = Date.now() - 40 * 60_000;
    await state.storage.put('rooms', inst.rooms);
    await inst.alarm();
  });

  expect(await roomOf(code)).toBeDefined();
});

it('은퇴한 방의 코드는 없는 방이 된다', async () => {
  const { code } = await makeRoom('곧 사라질 방');

  const ws = await connect(table(code), `/ws/${code}`);
  const r = reader(ws);
  hello(ws);
  await r.next();

  await runInDurableObject(theLobby(), async (inst: any, state) => {
    const room = inst.rooms[code];
    room.online = 0; room.seated = 0; room.everSeated = true;
    room.lastSeated = Date.now() - 20 * 60_000;
    await state.storage.put('rooms', inst.rooms);
    await inst.alarm();
  });
  await settle();

  const again = await connect(table(code), `/ws/${code}`);
  const ra = reader(again);
  hello(again);
  expect(await ra.next()).toMatchObject({ t: 'error', code: 'no_room' });
});

it('방을 만들면 정리 알람이 걸린다', async () => {
  await makeRoom('알람 거는 방');
  const at = await runInDurableObject(theLobby(), async (_inst: any, state) => state.storage.getAlarm());
  expect(at).not.toBeNull();
  expect(at!).toBeGreaterThan(Date.now());
});

it('정리 뒤에도 남은 방이 있으면 알람을 다시 건다', async () => {
  const { code } = await makeRoom('남는 방');
  const { code: doomed } = await makeRoom('사라질 방');

  await runInDurableObject(theLobby(), async (inst: any, state) => {
    const r = inst.rooms[doomed];
    r.online = 0; r.seated = 0; r.everSeated = true;
    r.lastSeated = Date.now() - 20 * 60_000;
    await state.storage.put('rooms', inst.rooms);
    await inst.alarm();
  });

  expect(await roomOf(doomed)).toBeUndefined();
  expect(await roomOf(code)).toBeDefined();
  const at = await runInDurableObject(theLobby(), async (_inst: any, state) => state.storage.getAlarm());
  expect(at).not.toBeNull();
});

it('은퇴한 코드를 다시 쓰면 옛 비밀번호가 통하지 않는다', async () => {
  const { code } = await makeRoom('비밀 방', 'hunter2');

  await runInDurableObject(theLobby(), async (inst: any, state) => {
    const room = inst.rooms[code];
    room.online = 0; room.seated = 0; room.everSeated = true;
    room.lastSeated = Date.now() - 20 * 60_000;
    await state.storage.put('rooms', inst.rooms);
    await inst.alarm();
  });
  await settle();

  // The code is free again, so a different room may take it.
  expect(await table(code).init(code, '새 방', await makePwRecord('other'))).toBe(true);

  const ws = await connect(table(code), `/ws/${code}`);
  const r = reader(ws);
  hello(ws, 'hunter2');
  expect(await r.next()).toMatchObject({ t: 'error', code: 'pw_wrong' });
});
