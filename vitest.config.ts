// Tests run inside workerd — the same runtime `wrangler dev` and the deployed
// Worker use — so Durable Objects behave exactly as they do in production.
// Bindings and the compatibility date come from wrangler.jsonc.
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: { include: ['test/**/*.test.ts'] },
});
