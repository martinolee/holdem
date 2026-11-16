import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';

it('바인딩이 테스트 런타임에 들어온다', () => {
  expect(env.TABLES).toBeDefined();
  expect(env.BB).toBe('20');
});
