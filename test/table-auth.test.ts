import { env, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { PROTOCOL } from '../src/shared/protocol';
import { makePwRecord } from '../src/server/password';
import { connect, reader, settle } from './helpers';

// Each test uses its own table name so stored state never leaks between them.
const table = (name: string) => env.TABLES.get(env.TABLES.idFromName(name));
const TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee';

const hello = (ws: WebSocket, password?: string, token = TOKEN) =>
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, token, ...(password === undefined ? {} : { password }) }));

async function openRoom(name: string, password?: string) {
  const stub = table(name);
  const pw = password === undefined ? null : await makePwRecord(password);
  expect(await stub.init(name, '테스트 방', pw)).toBe(true);
  return stub;
}

it('초기화되지 않은 테이블은 접속을 거절한다', async () => {
  const ws = await connect(table('never-issued'), '/ws/never-issued');
  const r = reader(ws);
  hello(ws);
  expect(await r.next()).toMatchObject({ t: 'error', code: 'no_room' });
});

it('init은 한 번만 성공한다', async () => {
  const stub = await openRoom('once');
  expect(await stub.init('once', '다른 이름', null)).toBe(false);
});

it('비밀번호 없는 방은 hello만으로 state를 받는다', async () => {
  const ws = await connect(await openRoom('open-room'), '/ws/open-room');
  const r = reader(ws);
  hello(ws);
  expect(await r.next()).toMatchObject({ t: 'state' });
});

it('비밀번호 방에 비밀번호 없이 오면 pw_required', async () => {
  const ws = await connect(await openRoom('locked-1', 'hunter2'), '/ws/locked-1');
  const r = reader(ws);
  hello(ws);
  expect(await r.next()).toMatchObject({ t: 'error', code: 'pw_required' });
});

it('비밀번호가 틀리면 pw_wrong이고 state를 받지 못한다', async () => {
  const ws = await connect(await openRoom('locked-2', 'hunter2'), '/ws/locked-2');
  const r = reader(ws);
  hello(ws, 'nope');
  expect(await r.next()).toMatchObject({ t: 'error', code: 'pw_wrong' });
  await settle();
  expect(r.pending()).toBe(0);
});

it('비밀번호가 맞으면 state를 받는다', async () => {
  const ws = await connect(await openRoom('locked-3', 'hunter2'), '/ws/locked-3');
  const r = reader(ws);
  hello(ws, 'hunter2');
  expect(await r.next()).toMatchObject({ t: 'state' });
});

it('통과 전 소켓은 다른 사람이 앉아도 state를 받지 않는다', async () => {
  const stub = await openRoom('locked-4', 'hunter2');

  const intruder = await connect(stub, '/ws/locked-4');
  const ri = reader(intruder);
  hello(intruder, 'wrong');
  expect(await ri.next()).toMatchObject({ t: 'error', code: 'pw_wrong' });

  const member = await connect(stub, '/ws/locked-4');
  const rm = reader(member);
  hello(member, 'hunter2', 'ffffffff-bbbb-cccc-dddd-eeeeeeee');
  expect(await rm.next()).toMatchObject({ t: 'state' });
  member.send(JSON.stringify({ t: 'sit', name: '참가자' }));
  await settle();

  expect(ri.pending()).toBe(0);
});

it('통과 전 소켓은 online에 세지 않는다', async () => {
  const stub = await openRoom('locked-5', 'hunter2');

  const member = await connect(stub, '/ws/locked-5');
  const rm = reader(member);
  hello(member, 'hunter2');
  await rm.next();

  for (let i = 0; i < 3; i++) {
    const ws = await connect(stub, '/ws/locked-5');
    hello(ws, 'wrong', `cccccccc-bbbb-cccc-dddd-0000000${i}`);
  }
  await settle();

  member.send(JSON.stringify({ t: 'sit', name: '참가자' }));
  let last: any;
  // Drain to the newest state: sitting down triggers a fresh broadcast.
  while (rm.pending() > 0) last = await rm.next();
  if (!last) last = await rm.next();
  expect(last.table.online).toBe(1);
});

const closesSoon = (ws: WebSocket) =>
  new Promise<boolean>(res => {
    ws.addEventListener('close', () => res(true));
    setTimeout(() => res(false), 2000);
  });

it('대기열은 상한을 넘지 않고 새 접속은 계속 받는다', async () => {
  const stub = await openRoom('locked-6', 'hunter2');
  for (let i = 0; i < 10; i++) await connect(stub, '/ws/locked-6');

  // Five more than the queue holds: every one of them is still let in.
  for (let i = 0; i < 5; i++) {
    const res = await stub.fetch('https://x/ws/locked-6', { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(101);
  }
  await settle();

  const waiting = await runInDurableObject(stub, async (inst: any) =>
    inst.ctx.getWebSockets().filter((w: WebSocket) =>
      w.readyState === WebSocket.READY_STATE_OPEN && !w.deserializeAttachment()?.authed).length);

  expect(waiting).toBeLessThanOrEqual(10);
});

it('유예가 지난 대기 연결은 새 접속이 올 때 정리된다', async () => {
  const stub = await openRoom('locked-6b', 'hunter2');
  const stale = await connect(stub, '/ws/locked-6b');
  const swept = closesSoon(stale);

  await runInDurableObject(stub, async (inst: any) => {
    for (const ws of inst.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      ws.serializeAttachment({ ...a, since: Date.now() - 60_000 });
    }
  });

  await connect(stub, '/ws/locked-6b');
  expect(await swept).toBe(true);
});

it('5회 틀리면 같은 주소는 대기 상태가 된다', async () => {
  const stub = await openRoom('locked-7', 'hunter2');
  const ws = await connect(stub, '/ws/locked-7');
  const r = reader(ws);

  for (let i = 0; i < 5; i++) {
    hello(ws, 'wrong');
    expect(await r.next()).toMatchObject({ t: 'error', code: 'pw_wrong' });
  }
  // The sixth attempt is refused before the password is even checked.
  hello(ws, 'hunter2');
  expect(await r.next()).toMatchObject({ t: 'error', code: 'pw_wait' });
});

it('retire 뒤 방이 사라지고 같은 코드는 없는 방이 된다', async () => {
  const stub = await openRoom('retire-me', 'hunter2');
  const ws = await connect(stub, '/ws/retire-me');
  const r = reader(ws);
  hello(ws, 'wrong');
  await r.next();

  await stub.retire();

  const after = await connect(stub, '/ws/retire-me');
  const ra = reader(after);
  hello(after);
  expect(await ra.next()).toMatchObject({ t: 'error', code: 'no_room' });

  // A fresh room may reuse the code, and the old password must not work.
  expect(await stub.init('retire-me', '새 방', await makePwRecord('other'))).toBe(true);
  const reused = await connect(stub, '/ws/retire-me');
  const rr = reader(reused);
  hello(reused, 'hunter2');
  expect(await rr.next()).toMatchObject({ t: 'error', code: 'pw_wrong' });
});
