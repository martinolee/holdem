import { env, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { PROTOCOL } from '../src/shared/protocol';
import { connect, reader } from './helpers';

// Each test uses its own lobby name so stored rooms never leak between them.
const lobby = (name: string) => env.LOBBY.get(env.LOBBY.idFromName(name));

it('hello 뒤에 빈 목록을 보낸다', async () => {
  const ws = await connect(lobby('empty'), '/lobby/ws');
  const r = reader(ws);
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL }));
  expect(await r.next()).toEqual({ t: 'rooms', rooms: [] });
});

it('프로토콜이 다르면 reload를 보낸다', async () => {
  const ws = await connect(lobby('oldtab'), '/lobby/ws');
  const r = reader(ws);
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL + 1 }));
  expect(await r.next()).toEqual({ t: 'reload' });
});

it('목록에 비밀번호 솔트와 해시를 담지 않는다', async () => {
  const stub = lobby('locked');
  const now = Date.now();
  await runInDurableObject(stub, async (inst: any, state) => {
    inst.rooms = {
      ab12cd: {
        code: 'ab12cd', name: '테스트', pw: { salt: 'deadbeef', hash: 'cafebabe' },
        seated: 1, online: 1, createdAt: now, lastSeated: now,
      },
    };
    await state.storage.put('rooms', inst.rooms);
  });

  const ws = await connect(stub, '/lobby/ws');
  const r = reader(ws);
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL }));
  const raw = await r.raw();

  expect(raw).not.toContain('deadbeef');
  expect(raw).not.toContain('cafebabe');
  expect(JSON.parse(raw).rooms[0]).toEqual({
    code: 'ab12cd', name: '테스트', seated: 1, online: 1, hasPw: true,
  });
});

it('사람이 앉은 방을 목록 위로 올린다', async () => {
  const stub = lobby('sorted');
  const now = Date.now();
  await runInDurableObject(stub, async (inst: any, state) => {
    inst.rooms = {
      quiet: { code: 'quiet', name: '빈 방', pw: null, seated: 0, online: 1, createdAt: now, lastSeated: now },
      busy: { code: 'busy', name: '진행 중', pw: null, seated: 3, online: 3, createdAt: now, lastSeated: now },
    };
    await state.storage.put('rooms', inst.rooms);
  });

  const ws = await connect(stub, '/lobby/ws');
  const r = reader(ws);
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL }));
  const { rooms } = await r.next();

  expect(rooms.map((x: { code: string }) => x.code)).toEqual(['busy', 'quiet']);
});
