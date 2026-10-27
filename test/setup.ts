import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, vi } from 'vitest';
import { configureWriteSessionDefault } from '../src/core/identity/session';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const realFetch = globalThis.fetch;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const leaked: string[] = [];

// Webhook tests must not feed the real local queue: its consumer would call the live Graph API.
// Send tests drive the consumer directly with createMessageBatch.
beforeEach(() => {
  // M-135: every person write asks the accounts service whether the session is revoked. The default test world has a healthy one; tests of the
  // revoked / unavailable paths install their own check.
  configureWriteSessionDefault(async () => false);
  vi.spyOn(env.SEND_QUEUE, 'sendBatch').mockResolvedValue({} as never);
  // No test reaches the real network (Meta, Kashier, any API): an outbound fetch nobody stubbed fails at once and fails the test below.
  leaked.length = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (LOCAL_HOSTS.has(new URL(url, 'http://localhost').hostname)) return realFetch(input, init);
    leaked.push(url);
    throw new Error(`unstubbed outbound fetch: ${url}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  const urls = leaked.splice(0);
  if (urls.length) throw new Error(`this test tried to reach the real network (stub it with stubGraph or a fetch mock): ${[...new Set(urls)].join(', ')}`);
});
