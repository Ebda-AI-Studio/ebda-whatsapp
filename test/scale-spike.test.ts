import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BUDGET_RATIO, baselineMs, mean, overBudget, p95Of } from './helpers/bench';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { workspace } from './helpers/workspace';

useApiKey();

/**
 * T17 scale spike (opt-in, BENCH=1, nightly): ONE workspace holding 500,000 messages (50,000 conversations, 10 each). Proves four things at that size:
 *  1. the hot reads (conversation list, open a chat) stay inside the fixed-ratio budget of the small bench (test/helpers/bench.ts);
 *  2. the chunked backup export finishes with row counts equal to the table counts (a positive match, not the absence of an error);
 *  3. while the export runs the workspace keeps answering: a request made DURING the export is not stuck behind one giant read (this is what the old
 *     single-transaction export could not do);
 *  4. the numbers are printed (`SPIKE {...}`) so a drift is visible before it is a failure.
 * Seeding uses set-based SQL (one statement per 50,000 rows), not a row loop.
 */
const CONVERSATIONS = 50_000;
const PER_CHAT = 10;

it.runIf(env.BENCH === '1')('spike: 500,000 messages in one workspace: reads inside the ratio budget, the chunked export completes and does not block the workspace', { timeout: 900_000 }, async () => {
  const ws = W(9500);
  const api = await apiFor(ws);
  const t0 = Date.now();
  await runInDurableObject(workspace(ws), (_i, state) => {
    const sql = state.storage.sql;
    const base = Math.floor(Date.now() / 1000) - 100_000;
    for (let from = 1; from <= CONVERSATIONS; from += 10_000) {
      const to = Math.min(CONVERSATIONS, from + 9_999);
      state.storage.transactionSync(() => {
        sql.exec(`WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO contacts (id, wa_id, profile_name, last_inbound_at) SELECT i, '2011' || printf('%08d', i), 'عميل ' || i, ? + i FROM n`, from, to, base);
        sql.exec(`INSERT INTO conversations (id, contact_id, last_message_at, unread) SELECT id, id, last_inbound_at, id % 3 = 0 FROM contacts WHERE id BETWEEN ? AND ?`, from, to);
        sql.exec(
          `WITH RECURSIVE m(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM m WHERE k < ?)
           INSERT INTO messages (wamid, conversation_id, direction, type, preview, created_at, updated_at)
           SELECT 'sp.' || c.id || '.' || m.k, c.id, 'in', 'text', 'رسالة ' || m.k, (? + c.id) * 1000 + m.k, 0 FROM conversations c, m WHERE c.id BETWEEN ? AND ?`,
          PER_CHAT, base, from, to,
        );
      });
    }
  });
  const seededMs = Date.now() - t0;
  const count = (t: string) => runInDurableObject(workspace(ws), (_i, state) => state.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${t}`).one().n);
  expect(await count('messages')).toBe(CONVERSATIONS * PER_CHAT);

  const timed = async (path: string) => {
    const t = performance.now();
    const r = await api.call('GET', path);
    await r.arrayBuffer();
    expect(r.status).toBe(200);
    return performance.now() - t;
  };
  for (let i = 0; i < 5; i++) await timed('/conversations?limit=50');
  const unit = await baselineMs(() => timed('/me'));
  const list: number[] = [];
  const chat: number[] = [];
  for (let i = 0; i < 60; i++) { list.push(await timed('/conversations?limit=50')); chat.push(await timed(`/conversations/${1 + (i * 811) % CONVERSATIONS}/messages?limit=50`)); }

  // the export, started and NOT awaited; requests are made while it runs
  const e0 = Date.now();
  const exporting = workspace(ws).exportSnapshot('2026-10-27');
  const during: number[] = [];
  let finished = false;
  void exporting.finally(() => { finished = true; });
  while (!finished && during.length < 400) during.push(await timed('/conversations?limit=50'));
  const manifest = await exporting;
  const exportMs = Date.now() - e0;

  const out = { messages: CONVERSATIONS * PER_CHAT, seededMs, exportMs, unitMs: Number(unit.toFixed(3)), list50P95: p95Of(list), openChatP95: p95Of(chat), duringExportP95: p95Of(during), duringExportMean: Number(mean(during.length ? during : [0]).toFixed(2)), duringExportCalls: during.length };
  console.log(`SPIKE ${JSON.stringify(out)}`);
  expect(manifest.tables.messages!.rows).toBe(CONVERSATIONS * PER_CHAT);
  expect(manifest.tables.conversations!.rows).toBe(CONVERSATIONS);
  expect(manifest.tables.contacts!.rows).toBe(CONVERSATIONS);
  expect(during.length, 'requests were answered while the export ran (it was not one blocking read)').toBeGreaterThan(5);
  const over = [
    overBudget('list50', out.list50P95, unit, BUDGET_RATIO.read, env.BENCH_ABSOLUTE_MS),
    overBudget('openChat50', out.openChatP95, unit, BUDGET_RATIO.read, env.BENCH_ABSOLUTE_MS),
    overBudget('request during export', out.duringExportP95, unit, BUDGET_RATIO.during),
  ].filter(Boolean);
  expect(over).toEqual([]);
});
