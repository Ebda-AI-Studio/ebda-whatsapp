import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { BUDGET_RATIO, baselineMs, overBudget } from './helpers/bench';
import { seedConversations } from './helpers/seed';

useApiKey();
const p = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * q) - 1)]!;
const stats = (xs: number[]) => ({ n: xs.length, p50: p(xs, 0.5), p95: p(xs, 0.95), max: Math.max(...xs), mean: Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) });

/**
 * Measured-local latency of the three hot paths against 5,000 seeded conversations, through the real Worker →
 * Hono → requireStoreAccess → DO path (no network, no Meta). `scripts/bench-local.mjs` prints these lines.
 * workerd's clock only advances on I/O, so single figures are coarse; `mean` over the run is the finer number.
 */
// Opt-in (BENCH=1, via scripts/bench-local.mjs): seeding 5,000 conversations is too heavy for every suite run.
it.runIf(env.BENCH === '1')('bench: conversation list, open chat and send-enqueue stay under the 150 ms p95 budget', { timeout: 60_000 }, async () => {
  const ws = W(600);
  const api = await apiFor(ws);
  const chatId = await seedConversations(ws);
  const timed = async (method: string, path: string, body?: unknown, expected = 200) => {
    const t = performance.now();
    const r = await api.call(method, path, body);
    await r.arrayBuffer();
    expect(r.status).toBe(expected);
    return performance.now() - t;
  };
  for (let i = 0; i < 5; i++) await timed('GET', '/conversations?limit=50'); // warm the isolate and the verifier's key cache
  const unit = Number((await baselineMs(() => timed('GET', '/me'))).toFixed(3)); // the same-run baseline every budget is a fixed multiple of (M-176)
  const list: number[] = [];
  const unread: number[] = [];
  const chat: number[] = [];
  const search: number[] = [];
  const enqueue: number[] = [];
  for (let i = 0; i < 100; i++) {
    list.push(await timed('GET', '/conversations?limit=50'));
    if (i % 4 === 0) unread.push(await timed('GET', '/conversations?limit=50&filter=unread'));
    chat.push(await timed('GET', `/conversations/${chatId}/messages?limit=50`));
    if (i % 4 === 0) search.push(await timed('GET', `/search?q=${encodeURIComponent('رسالة')}`));
    enqueue.push(await timed('POST', `/conversations/${chatId}/messages`, { type: 'text', clientId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, text: `رد ${i}` }, 202));
  }
  const out = { unitMs: unit, conversations: 5000, list50: stats(list), list50Unread: stats(unread), openChat50: stats(chat), search: stats(search), sendEnqueue: stats(enqueue) };
  console.log(`BENCH ${JSON.stringify(out)}`);
  const over = (['list50', 'list50Unread', 'openChat50', 'search', 'sendEnqueue'] as const).map((k) => overBudget(k, out[k].p95, unit, k === 'sendEnqueue' ? BUDGET_RATIO.send : BUDGET_RATIO.read, env.BENCH_ABSOLUTE_MS)).filter(Boolean);
  expect(over).toEqual([]);
});
