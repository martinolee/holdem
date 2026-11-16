import { env, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { PROTOCOL } from '../src/shared/protocol';
import { connect, reader } from './helpers';

const lobby = (name: string) => env.LOBBY.get(env.LOBBY.idFromName(name));

/** Connects, says hello, and drops the initial room list. */
async function session(name: string) {
  const ws = await connect(lobby(name), '/lobby/ws');
  const r = reader(ws);
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL }));
  await r.next();
  const create = async (room: string, password?: string) => {
    ws.send(JSON.stringify({ t: 'create', name: room, ...(password === undefined ? {} : { password }) }));
    // Every successful create also broadcasts the new list; skip any that is
    // still queued from an earlier one so we read this create's own answer.
    let m = await r.next();
    while (m.t === 'rooms') m = await r.next();
    return m;
  };
  return { ws, r, create };
}

const seed = (code: string, over: Record<string, unknown> = {}) => ({
  code, name: `방 ${code}`, pw: null, ip: 'someone-else',
  seated: 0, online: 0, createdAt: Date.now(), lastSeated: Date.now(), ...over,
});

it('이름만으로 방을 만들고 코드를 돌려준다', async () => {
  const { create } = await session('c-basic');
  const made = await create('금요일 테이블');
  expect(made.t).toBe('created');
  expect(made.code).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/);
});

it('만든 방이 목록에 뜬다', async () => {
  const { r, create } = await session('c-listed');
  const made = await create('금요일 테이블');
  const list = await r.next();
  expect(list.t).toBe('rooms');
  expect(list.rooms).toEqual([
    { code: made.code, name: '금요일 테이블', seated: 0, online: 0, hasPw: false },
  ]);
});

it('비밀번호를 걸면 목록에 hasPw만 뜬다', async () => {
  const { r, create } = await session('c-locked');
  const made = await create('비밀 방', 'hunter2');
  expect(made.t).toBe('created');
  const raw = await r.raw();
  expect(raw).not.toContain('hunter2');
  expect(JSON.parse(raw).rooms[0]).toEqual({
    code: made.code, name: '비밀 방', seated: 0, online: 0, hasPw: true,
  });
});

it('이름을 20자로 자르고 제어문자를 지운다', async () => {
  const { r, create } = await session('c-trim');
  await create('\u0000ab' + 'x'.repeat(30));
  const { rooms } = await r.next();
  expect(rooms[0].name).toBe(('ab' + 'x'.repeat(30)).slice(0, 20));
  expect(rooms[0].name).not.toContain('\u0000');
});

it('잘라낸 뒤 빈 이름이면 거절한다', async () => {
  const { create } = await session('c-blank');
  expect(await create('​ \u0000')).toMatchObject({ t: 'error', code: 'name' });
});

it('비밀번호가 3자면 거절한다', async () => {
  const { create } = await session('c-short-pw');
  expect(await create('방', 'abc')).toMatchObject({ t: 'error', code: 'pw_wrong' });
});

it('비밀번호가 33자면 거절한다', async () => {
  const { create } = await session('c-long-pw');
  expect(await create('방', 'x'.repeat(33))).toMatchObject({ t: 'error', code: 'pw_wrong' });
});

it('방이 서버 상한만큼 차면 거절한다', async () => {
  const stub = lobby('c-full');
  await runInDurableObject(stub, async (inst: any, state) => {
    inst.rooms = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`seed${i}`, seed(`seed${i}`)]),
    );
    await state.storage.put('rooms', inst.rooms);
  });
  const { create } = await session('c-full');
  expect(await create('하나 더')).toMatchObject({ t: 'error', code: 'cap' });
});

it('한 주소가 가진 방이 상한을 넘지 못한다', async () => {
  const { create } = await session('c-per-ip');
  for (let i = 0; i < 3; i++) expect(await create(`방 ${i}`)).toMatchObject({ t: 'created' });
  expect(await create('네 번째')).toMatchObject({ t: 'error', code: 'cap' });
});

it('한 주소가 분당 상한보다 빨리 만들지 못한다', async () => {
  const stub = lobby('c-rate');
  const { create } = await session('c-rate');
  for (let i = 0; i < 3; i++) expect(await create(`방 ${i}`)).toMatchObject({ t: 'created' });

  // Those rooms go away, so the per-address room cap no longer applies —
  // only the rate limit should still be holding.
  await runInDurableObject(stub, async (inst: any, state) => {
    inst.rooms = {};
    await state.storage.put('rooms', inst.rooms);
  });

  expect(await create('곧바로 또')).toMatchObject({ t: 'error', code: 'rate' });
});

it('코드가 충돌하면 다른 코드로 만든다', async () => {
  const stub = lobby('c-collide');
  const taken = 'ab12cd';
  // That table is already in use, so init on it must fail.
  expect(await env.TABLES.get(env.TABLES.idFromName(taken)).init(taken, '먼저 쓴 방', null)).toBe(true);

  await runInDurableObject(stub, async (inst: any) => {
    const real = inst.newCode.bind(inst);
    let first = true;
    inst.newCode = () => { if (first) { first = false; return taken; } return real(); };
  });

  const { create } = await session('c-collide');
  const made = await create('새 방');
  expect(made.t).toBe('created');
  expect(made.code).not.toBe(taken);
});
