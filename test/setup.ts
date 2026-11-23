import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, vi } from 'vitest';
import { clearOps, labelForUrl, track, watchStall } from './helpers/inflight';
import { configureWriteSessionDefault } from '../src/core/identity/session';

import { DEDUPE_SCHEMA_SQL } from '../foundation/instapay-dedupe';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
for (const db of [env.INSTAPAY_DEDUPE_DB, (env as unknown as { INSTAPAY_DEDUPE_DB_PRIVATE?: D1Database }).INSTAPAY_DEDUPE_DB_PRIVATE]) if (db) await db.exec(DEDUPE_SCHEMA_SQL.replace(/\s*\n\s*/g, ' '));

// WA-LINK-ON-1: production binds the Store (STORE_BRIDGE, STORE_EVENTS). The default test world is the link-OFF one every older test was
// written against; a test that needs the link registers its own bridge (test/helpers/fake-store.ts) or passes its own env.
delete (env as Partial<typeof env>).STORE_BRIDGE;
delete (env as Partial<typeof env>).STORE_EVENTS;

const realFetch = globalThis.fetch;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const leaked: string[] = [];

// Webhook tests must not feed the real local queue: its consumer would call the live Graph API.
// Send tests drive the consumer directly with createMessageBatch.
let stopStall: () => void = () => undefined;
beforeEach(({ task }) => {
  // WA-CI-STALL-1: a moment before this test's deadline, name the operations still pending (one line; scripts/ci-test.mjs turns it into a warning annotation).
  clearOps();
  stopStall = watchStall({ name: task.name, timeoutMs: task.timeout || Number(env.VITEST_TEST_TIMEOUT) || 20_000, emit: (line) => console.log(line) });
  // M-135: every person write asks the accounts service whether the session is revoked. The default test world has a healthy one; tests of the
  // revoked / unavailable paths install their own check.
  configureWriteSessionDefault(async () => false);
  vi.spyOn(env.SEND_QUEUE, 'sendBatch').mockImplementation(() => track('queue SEND_QUEUE.sendBatch', Promise.resolve({})) as never);
  // No test reaches the real network (Meta, Kashier, any API): an outbound fetch nobody stubbed fails at once and fails the test below.
  leaked.length = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (LOCAL_HOSTS.has(new URL(url, 'http://localhost').hostname)) return track(labelForUrl(new URL(url, 'http://localhost').href), realFetch(input, init));
    leaked.push(url);
    throw new Error(`unstubbed outbound fetch: ${url}`);
  });
});
afterEach(() => {
  stopStall();
  vi.restoreAllMocks();
  const urls = leaked.splice(0);
  if (urls.length) throw new Error(`this test tried to reach the real network (stub it with stubGraph or a fetch mock): ${[...new Set(urls)].join(', ')}`);
});
