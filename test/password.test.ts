import { describe, it, expect } from 'vitest';
import { makePwRecord, verifyPw, validPwShape } from '../src/server/password';

describe('password', () => {
  it('맞는 비밀번호를 통과시킨다', async () => {
    const rec = await makePwRecord('1234');
    expect(await verifyPw('1234', rec)).toBe(true);
  });

  it('틀린 비밀번호를 거절한다', async () => {
    const rec = await makePwRecord('1234');
    expect(await verifyPw('1235', rec)).toBe(false);
  });

  it('같은 비밀번호도 솔트가 달라 해시가 다르다', async () => {
    const a = await makePwRecord('1234');
    const b = await makePwRecord('1234');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('평문을 어디에도 담지 않는다', async () => {
    const rec = await makePwRecord('hunter2');
    expect(JSON.stringify(rec)).not.toContain('hunter2');
  });

  it('길이를 4..32로 본다', () => {
    expect(validPwShape('123')).toBe(false);
    expect(validPwShape('1234')).toBe(true);
    expect(validPwShape('x'.repeat(32))).toBe(true);
    expect(validPwShape('x'.repeat(33))).toBe(false);
    expect(validPwShape(1234)).toBe(false);
    expect(validPwShape(undefined)).toBe(false);
  });
});
