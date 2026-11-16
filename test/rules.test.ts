/* Two standard hold'em rules the game was getting wrong:
   a short all-in must not hand the raise back to players who already acted,
   and someone joining mid-game must not get free hands before the blinds. */

import { env, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';

const table = (code: string) => env.TABLES.get(env.TABLES.idFromName(code));

const seat = (i: number, stack: number, over: Record<string, unknown> = {}) => ({
  token: `token-${i}-aaaaaaaaaaaaaaaa`, name: `P${i}`, stack, buyins: 1,
  away: false, idle: false, missed: 0, leaving: false, lastSeen: Date.now(),
  waiting: false, postBB: false, ...over,
});

const player = () => ({
  bet: 0, total: 0, folded: false, allIn: false, needs: true, mayRaise: true,
  label: '', shown: null, won: 0, win: false,
});

/** Three players on the flop, nobody has bet yet, seat 0 to act. */
async function onTheFlop(code: string, stacks: [number, number, number]) {
  const stub = table(code);
  expect(await stub.init(code, '룰 테스트', null)).toBe(true);
  await runInDurableObject(stub, async (inst: any) => {
    inst.s.seats = [seat(0, stacks[0]), seat(1, stacks[1]), seat(2, stacks[2]), null, null, null];
    inst.s.hand = {
      id: 'h1', no: 1, dealer: 0, sbS: 1, bbS: 2, order: [0, 1, 2],
      phase: 'bet', street: 'flop', board: [4, 8, 12], deck: [20, 24, 28, 32], holes: {}, dp: 0,
      pot: 60, cur: 0, minR: 20, raises: 0, toAct: 0, seq: 0, turnAt: Date.now() + 30_000,
      ps: [player(), player(), player(), null, null, null],
      hl: null, results: null, verdict: '', runout: false,
    };
  });
  return stub;
}

const state = (stub: any, pick: (h: any, s: any) => unknown) =>
  runInDurableObject(stub, async (inst: any) => pick(inst.s.hand, inst.s));

/* ---------------- short all-in does not reopen the raise ---------------- */

it('짧은 올인은 이미 행동한 사람의 레이즈 권한을 돌려주지 않는다', async () => {
  // Seat 1 can only cover 240 against a 200 bet: a raise of 40 against a
  // minimum of 200, so it is not a full raise.
  const stub = await onTheFlop('short-allin', [1000, 240, 1000]);
  await runInDurableObject(stub, async (inst: any) => {
    inst.apply(0, 'raise', 200, false);   // seat 0 bets 200
    inst.apply(1, 'raise', 240, false);   // seat 1 is all in for 240
  });

  const got = await state(stub, h => ({
    allIn: h.ps[1].allIn,
    actedNeeds: h.ps[0].needs,
    actedMayRaise: h.ps[0].mayRaise,
    notYetMayRaise: h.ps[2].mayRaise,
    minR: h.minR,
  }));

  // Seat 0 still owes the extra 40, so it must act — but only call or fold.
  // Seat 2 has not acted on this street and keeps the right to raise.
  expect(got).toEqual({
    allIn: true, actedNeeds: true, actedMayRaise: false, notYetMayRaise: true, minR: 200,
  });
});

it('짧은 올인 뒤 들어온 레이즈 요청은 콜로 처리된다', async () => {
  const stub = await onTheFlop('short-allin-2', [1000, 240, 1000]);
  await runInDurableObject(stub, async (inst: any) => {
    inst.apply(0, 'raise', 200, false);
    inst.apply(1, 'raise', 240, false);
    inst.apply(0, 'raise', 900, false);   // not allowed to raise any more
  });

  const got = await state(stub, h => ({ bet: h.ps[0].bet, cur: h.cur }));
  expect(got).toEqual({ bet: 240, cur: 240 });
});

it('정규 레이즈는 이미 행동한 사람의 레이즈 권한을 돌려준다', async () => {
  const stub = await onTheFlop('full-raise', [1000, 1000, 1000]);
  await runInDurableObject(stub, async (inst: any) => {
    inst.apply(0, 'raise', 200, false);
    inst.apply(1, 'raise', 400, false);   // a full raise
  });

  const got = await state(stub, h => ({
    needs: h.ps[0].needs, mayRaise: h.ps[0].mayRaise, minR: h.minR,
  }));
  expect(got).toEqual({ needs: true, mayRaise: true, minR: 200 });
});

/* ---------------- joining mid-game ---------------- */

it('기다리기를 고른 사람은 버튼이 지나갈 때까지 핸드를 받지 않는다', async () => {
  const stub = table('wait-for-button');
  expect(await stub.init('wait-for-button', '대기 테스트', null)).toBe(true);
  const dealt = await runInDurableObject(stub, async (inst: any) => {
    // Seats 0 and 1 are playing; seat 3 just sat down and chose to wait.
    inst.s.seats = [seat(0, 1000), seat(1, 1000), null, seat(3, 1000, { waiting: true }), null, null];
    inst.s.dealer = 0;
    inst.s.hand = null;
    inst.s.timer = null;
    inst.startHand();
    return { inHand: !!inst.s.hand.ps[3], dealer: inst.s.hand.dealer, stillWaiting: inst.s.seats[3].waiting };
  });

  // The button moved 0 → 1, which never swept past seat 3.
  expect(dealt).toEqual({ inHand: false, dealer: 1, stillWaiting: true });
});

it('버튼이 자리를 지나가면 기다림이 풀린다', async () => {
  const stub = table('button-passes');
  expect(await stub.init('button-passes', '대기 해제', null)).toBe(true);
  const got = await runInDurableObject(stub, async (inst: any) => {
    inst.s.seats = [seat(0, 1000), seat(1, 1000), null, seat(3, 1000, { waiting: true }), null, null];
    inst.s.dealer = 1;   // next button is seat 0, sweeping past seats 2 and 3
    inst.s.hand = null;
    inst.s.timer = null;
    inst.startHand();
    return { inHand: !!inst.s.hand.ps[3], stillWaiting: inst.s.seats[3].waiting };
  });

  expect(got).toEqual({ inHand: true, stillWaiting: false });
});

it('참여할 사람이 둘이 안 되면 기다림을 푼다', async () => {
  const stub = table('no-deadlock');
  expect(await stub.init('no-deadlock', '교착 방지', null)).toBe(true);
  const got = await runInDurableObject(stub, async (inst: any) => {
    inst.s.seats = [seat(0, 1000), seat(1, 1000, { waiting: true }), null, null, null, null];
    inst.s.dealer = 0;
    inst.s.hand = null;
    inst.s.timer = null;
    inst.startHand();
    return { started: !!inst.s.hand, inHand: !!inst.s.hand?.ps[1], stillWaiting: inst.s.seats[1].waiting };
  });

  expect(got).toEqual({ started: true, inHand: true, stillWaiting: false });
});

it('바로 참가를 고른 사람은 빅블라인드 금액을 깔고 시작한다', async () => {
  const stub = table('post-bb');
  expect(await stub.init('post-bb', '즉시 참가', null)).toBe(true);
  const got = await runInDurableObject(stub, async (inst: any) => {
    // Seats 0..2 playing, seat 4 posts to come in now. The button moves to 0,
    // so the blinds fall on 1 and 2 and seat 4 is neither of them.
    inst.s.seats = [seat(0, 1000), seat(1, 1000), seat(2, 1000), null, seat(4, 1000, { postBB: true }), null];
    inst.s.dealer = 4;
    inst.s.hand = null;
    inst.s.timer = null;
    inst.startHand();
    const h = inst.s.hand;
    return {
      bet: h.ps[4].bet,
      stack: inst.s.seats[4].stack,
      toCall: h.cur - h.ps[4].bet,
      postBB: inst.s.seats[4].postBB,
      pot: h.ps.reduce((n: number, p: any) => n + (p ? p.bet : 0), 0),
    };
  });

  // Live money: it counts as the blind, so nothing is owed to call.
  expect(got).toEqual({ bet: 20, stack: 980, toCall: 0, postBB: false, pot: 50 });
});
