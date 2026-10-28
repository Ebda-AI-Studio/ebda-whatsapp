/** Final-review minors: price guard (structured prices, words), consent wording, rate limit order, retention hour, backup tolerance, per-owner campaign cap. */
import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { DEFAULT_API_LIMITS, configureApiLimits } from '../src/core/api-rate';
import { guardReply, Trusted } from '../src/core/ai/reply-guard';
import { matchOptIn } from '../src/core/consent';
import { MAX_WORDING_CHARS } from '../src/core/consent-proof';
import { OP1, apiFor, operatorCall, storeId as W0, useApiKey, apiKey } from './helpers/api';
import { mintClient } from './helpers/issuer';
import { exec, own, rows, workspace } from './helpers/workspace';
import { configureSessionCheck } from '../src/core/identity/session';

useApiKey();
const W = (n: number) => W0(9800 + n);
const nowS = () => Math.floor(Date.now() / 1000);

describe('price guard', () => {
  const trusted = (text: string[] = [], store?: unknown) => { const t = Object.assign(new Trusted(), { text }); if (store) t.addStoreResult(JSON.stringify(store)); return t; };
  it('a bare number in the persona or in an unrelated Store field vouches for nothing', () => {
    expect(guardReply('السعر 3 جنيه', trusted(['التوصيل خلال 3 أيام'])).ok).toBe(false);
    expect(guardReply('Item costs 110 EGP', trusted([], { results: [{ name: 'x', price: 99, stock: 110 }] })).ok).toBe(false);
    expect(guardReply('Item costs 99 EGP', trusted([], { results: [{ name: 'x', price: 99, stock: 110 }] })).ok).toBe(true);
    expect(guardReply('إجمالي 250 جنيه', trusted([], { orders: [{ total: 250 }] })).ok).toBe(true);
  });
  it('a price the merchant wrote with a currency is trusted', () => {
    expect(guardReply('الشحن 50 جنيه', trusted(['الشحن 50 جنيه لكل المحافظات'])).ok).toBe(true);
  });
  it.each([
    'It is fifty pounds', 'two hundred and fifty EGP', 'one thousand five hundred pounds', 'twenty-five egp', 'خمسين جنيه', 'مية وخمسين جنيه', 'ألف جنيه', 'ألفين وخمسمية جنيه', 'تلات تلاف جنيه', 'ثلاثمائة جنيه', 'اتنين وعشرين جنيه',
  ])('a price in words is checked: %s', (reply) => {
    expect(guardReply(reply, trusted()).ok).toBe(false);
  });
  it('a price in words that the Store returned, or that the merchant wrote in words, is fine', () => {
    expect(guardReply('It is fifty pounds', trusted([], { results: [{ price: 50 }] })).ok).toBe(true);
    expect(guardReply('خمسين جنيه', trusted([], { results: [{ price: 50 }] })).ok).toBe(true);
    expect(guardReply('الشحن خمسين جنيه', trusted(['الشحن خمسين جنيه'])).ok).toBe(true);
  });
});

describe('consent wording', () => {
  it('a checkout wording up to 600 characters is stored whole (the Store\'s own maximum)', () => expect(MAX_WORDING_CHARS).toBe(600));
  it('matchOptIn returns the matched keyword, not the message', () => {
    expect(matchOptIn(' Start!! 😀 ')).toBe('start');
    expect(matchOptIn('start the engine')).toBeNull();
  });
  it('the START proof stores only the keyword, not the customer\'s whole message', async () => {
    const ws = W(1);
    await own(ws);
    const msg = (id: string, text: string) => ({ wamid: `wamid.ms.${ws}.${id}`, from: '201001234567', ts: nowS() - 10, type: 'text' as const, text });
    await workspace(ws).ingest({ phoneNumberId: 'pn-x', inbound: [msg('a', 'STOP')], statuses: [], receivedAt: Date.now() });
    await workspace(ws).ingest({ phoneNumberId: 'pn-x', inbound: [msg('b', '  Start!! 😀 ')], statuses: [], receivedAt: Date.now() });
    expect(await rows(ws, 'SELECT source, attested_by, wording FROM consent_proofs')).toEqual([{ source: 'opt_in', attested_by: 'customer', wording: 'start' }]);
  });
});

describe('the API rate-limit token is taken AFTER the kill switch', () => {
  afterEach(() => { configureApiLimits(DEFAULT_API_LIMITS); configureSessionCheck(null); });
  it('requests of a revoked integration do not drain the workspace bucket', async () => {
    configureSessionCheck(async () => false);
    configureApiLimits({ workspace: { ratePerSec: 0.0001, burst: 3 }, integration: { ratePerSec: 1000, burst: 1000 } });
    const ws = W(2);
    const owner = await apiFor(ws);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/integrations/revoke`, { reason: 'test: leaked token, ticket 7' })).status).toBe(200);
    const t = await mintClient(apiKey(), { storeId: ws, scope: 'conversations:read' });
    const live = { INTEGRATOR_TOKENS_ENABLED: 'true', ACCOUNTS: { isRevoked: async () => false } };
    for (let i = 0; i < 6; i++) {
      const r = await worker.fetch(new Request(`https://x/api/v1/stores/${ws}/conversations`, { headers: { authorization: `Bearer ${t}` } }), { ...env, ...live } as typeof env, createExecutionContext());
      expect(r.status).toBe(401);
    }
    expect((await owner.call('GET', '/me')).status).toBe(200);
  });
});

describe('retention purge and the nightly backup run at different hours', () => {
  it('the two daily tasks are not due in the same Cairo hour', async () => {
    const ws = W(3);
    await own(ws);
    await workspace(ws).ingest({ phoneNumberId: 'pn-x', inbound: [{ wamid: `wamid.rh.${ws}`, from: '201001234567', ts: nowS(), type: 'text', text: 'hi' }], statuses: [], receivedAt: Date.now() });
    const due = await rows<{ kind: string; due_at: number }>(ws, "SELECT kind, due_at FROM scheduled_tasks WHERE kind IN ('backup', 'retention_purge')");
    const hour = (kind: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hourCycle: 'h23' }).format(due.find((d) => d.kind === kind)!.due_at));
    expect(hour('backup')).toBe(2);
    expect(hour('retention_purge')).not.toBe(hour('backup'));
  });
});

describe('the backup count check tolerates a row deleted below the high-water mark during the export', () => {
  it('a message purged after it was read does not fail the backup', async () => {
    const ws = W(4);
    await workspace(ws).ingest({ phoneNumberId: 'pn', inbound: Array.from({ length: 4 }, (_, i) => ({ wamid: `wamid.bt.${i}`, from: `2010000000${i}`, ts: 1000 + i, type: 'text' as const, text: `m${i}` })), statuses: [], receivedAt: 1 });
    await runInDurableObject(workspace(ws), (inst) => {
      const k = inst as unknown as { backupChunkRows: number; sql: SqlStorage; backupHooks: { afterChunk?: (t: string, i: number) => Promise<void> } };
      k.backupChunkRows = 1;
      let done = false;
      k.backupHooks = { afterChunk: async (t) => { if (t === 'messages' && !done) { done = true; k.sql.exec('DELETE FROM messages WHERE id = (SELECT min(id) FROM messages)'); } } };
    });
    const m = await workspace(ws).exportSnapshot('2026-10-27');
    expect(m.tables.messages!.rows).toBe(4);
    await exec(ws, 'SELECT 1');
  });
});

import { NEW_WORKSPACE_CAP as _CAP, configureNewWorkspaceCap } from '../src/core/campaigns/campaigns';
import { PN as CPN, makeCampaign, resetWallet, seedContacts, seedTemplate, setTier } from './helpers/campaigns';

describe('the new-workspace campaign cap is per owner and per shared number', () => {
  afterEach(() => resetWallet());
  const running = (ws: string, id: string) => exec(ws, "UPDATE campaigns SET status = 'running', started_at = 1, attempt = 1 WHERE id = ?", id);
  const page = (ws: string, id: string, n: number) => workspace(ws).campaignPage(id, 1, n);
  // Each scenario gets its own phone numbers: D1 is not reset between tests, and the cap is also per number.
  const setup = async (ws: string, pn: string = CPN) => {
    await seedTemplate(ws); await seedContacts(ws, 6); await setTier(ws, 1000); await own(ws, pn);
    const c = await makeCampaign(ws);
    await exec(ws, 'UPDATE campaigns SET phone_number_id = ? WHERE id = ?', pn, c.id);
    await env.DB.prepare("INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, 'merchant_card', 0)").bind(pn).run();
    await exec(ws, 'INSERT OR REPLACE INTO number_limits (phone_number_id, tier, mps, tokens, tokens_at, alerted_at) VALUES (?, 1000, 80, 80, 0, 0)', pn);
    await running(ws, c.id);
    return c;
  };
  beforeEach(async () => { await env.DB.prepare('DELETE FROM new_cap_usage').run(); });
  it('two new workspaces of ONE owner share the allowance', async () => {
    const prev = configureNewWorkspaceCap({ days: 14, perDay: 3 });
    try {
      const [a, b, other] = [W(11), W(12), W(13)];
      for (const ws of [a, b, other]) await env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, 1)').bind(ws, ws).run();
      await env.DB.prepare("INSERT INTO workspace_owners (workspace_id, owner_user_id, updated_at) VALUES (?, 'owner-1', 1), (?, 'owner-1', 1), (?, 'owner-2', 1)").bind(a, b, other).run();
      const [ca, cb, co] = [await setup(a, 'pn-own-a'), await setup(b, 'pn-own-b'), await setup(other, 'pn-own-c')];
      expect(await page(a, ca.id, 0)).toEqual({ state: 'next', count: 3 });
      expect((await page(b, cb.id, 0)).state).toBe('wait'); // the owner's day is used up in workspace a
      expect(await page(other, co.id, 0)).toEqual({ state: 'next', count: 3 }); // another owner is unaffected
    } finally { configureNewWorkspaceCap(prev); }
  });
  it('two new workspaces on ONE own number share the allowance; on the shared platform number they do not pool', async () => {
    const prev = configureNewWorkspaceCap({ days: 14, perDay: 3 });
    try {
      const [a, b, c, d] = [W(14), W(15), W(17), W(18)];
      for (const ws of [a, b, c, d]) await env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, 1)').bind(ws, ws).run();
      await env.DB.prepare("INSERT INTO workspace_owners (workspace_id, owner_user_id, updated_at) VALUES (?, 'owner-s1', 1), (?, 'owner-s2', 1), (?, 'owner-s3', 1), (?, 'owner-s4', 1)").bind(a, b, c, d).run();
      const ca = await setup(a, 'pn-shared');
      expect(await page(a, ca.id, 0)).toEqual({ state: 'next', count: 3 });
      const cb = await setup(b, 'pn-shared'); // the fixture hands the own number to the second workspace; the allowance is the number's, so it is already used
      expect((await page(b, cb.id, 0)).state).toBe('wait');
      // platform number: tenant C exhausts its own allowance, tenant D (another owner) still sends
      const cc = await setup(c, 'pn-platform');
      await env.DB.prepare("UPDATE phone_numbers SET kind = 'platform' WHERE phone_number_id = 'pn-platform'").run();
      expect(await page(c, cc.id, 0)).toEqual({ state: 'next', count: 3 });
      const cd = await setup(d, 'pn-platform');
      await env.DB.prepare("UPDATE phone_numbers SET kind = 'platform' WHERE phone_number_id = 'pn-platform'").run();
      expect(await page(d, cd.id, 0)).toEqual({ state: 'next', count: 3 });
      void CPN; void _CAP;
    } finally { configureNewWorkspaceCap(prev); }
  });
  it('the Store events record who owns a workspace', async () => {
    const ws = W(16);
    await env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, 1)').bind(ws, ws).run();
    const { recordWorkspaceOwner } = await import('../src/core/campaigns/new-cap');
    await recordWorkspaceOwner(env, ws, 'owner-9', 5);
    await recordWorkspaceOwner(env, ws, 'owner-9', 6);
    expect(await env.DB.prepare('SELECT owner_user_id FROM workspace_owners WHERE workspace_id = ?').bind(ws).all()).toMatchObject({ results: [{ owner_user_id: 'owner-9' }] });
  });
});
