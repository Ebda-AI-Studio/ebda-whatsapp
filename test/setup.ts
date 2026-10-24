import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, vi } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Webhook tests must not feed the real local queue: its consumer would call the live Graph API.
// Send tests drive the consumer directly with createMessageBatch.
beforeEach(() => {
  vi.spyOn(env.SEND_QUEUE, 'sendBatch').mockResolvedValue({} as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});
