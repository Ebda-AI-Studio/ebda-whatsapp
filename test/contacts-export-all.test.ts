import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listContactsResponse } from '../src/core/api/contract';
import { configureSessionCheck } from '../src/core/identity/session';
import { adminToken, apiFor, storeId as W, useApiKey } from './helpers/api';
import { exec, own, workspace } from './helpers/workspace';

// Self-service: the owner exports ALL their own contacts (audited, owner only, tenant-scoped).
useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); });
afterEach(() => configureSessionCheck(null));
const nowS = () => Math.floor(Date.now() / 1000);
const wa = (n: number) => `2010100${String(n).padStart(5, '0')}`;
const audit = (ws: string, action: string) => env.DB.prepare('SELECT * FROM audit_log WHERE workspace_id = ? AND action = ? ORDER BY id').bind(ws, action).all<{ actor_role: string; target_id: string | null; detail: string | null }>().then((r) => r.results);

async function seed(ws: string, n: number, name = 'عميل') {
  await own(ws);
  await workspace(ws).ingest({
    phoneNumberId: 'pn-x',
    inbound: Array.from({ length: n }, (_, i) => ({ wamid: `wamid.${ws}.${i}`, from: wa(i), ts: nowS() - 100 + i, type: 'text' as const, text: 'أهلا', profileName: `${name} ${i}` })),
    statuses: [], receivedAt: Date.now(),
  });
}

describe('GET /contacts/export', () => {
  it('gives the owner every contact across pages (cursor), with consent, opt-out and tags, never another store\'s, and audits each page without a number or a name', async () => {
    const ws = W(4201);
    const other = W(4202);
    await seed(ws, 5);
    await seed(other, 2, 'غريب');
    await exec(ws, "UPDATE contacts SET consent_source = 'keyword_start', consent_at = 77 WHERE wa_id = ?", wa(1));
    await exec(ws, "UPDATE contacts SET opted_out_at = 9 WHERE wa_id = ?", wa(2));
    await exec(ws, "INSERT INTO contact_tags (contact_id, tag) SELECT id, 'vip' FROM contacts WHERE wa_id = ?", wa(1));
    const owner = await apiFor(ws);
    const p1 = listContactsResponse.parse(await (await owner.call('GET', '/contacts/export?limit=3')).json());
    expect(p1.items).toHaveLength(3);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = listContactsResponse.parse(await (await owner.call('GET', `/contacts/export?limit=3&cursor=${p1.nextCursor}`)).json());
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    const all = [...p1.items, ...p2.items];
    expect(new Set(all.map((c) => c.waId)).size).toBe(5);
    expect(all.every((c) => c.name?.startsWith('عميل '))).toBe(true); // none of the other store's contacts
    expect(all.find((c) => c.waId === wa(1))).toMatchObject({ tags: ['vip'], consent: { source: 'keyword_start', at: 77 }, optedOut: false });
    expect(all.find((c) => c.waId === wa(2))!.optedOut).toBe(true);
    const log = await audit(ws, 'contacts.export_all');
    expect(log).toHaveLength(2);
    expect(JSON.parse(log[0]!.detail!)).toMatchObject({ count: 3 });
    expect(JSON.stringify(log)).not.toMatch(/2010100|عميل/);
    expect(await audit(other, 'contacts.export_all')).toEqual([]);
  });

  it('is cached nowhere', async () => {
    const ws = W(4203);
    await seed(ws, 1);
    expect((await (await apiFor(ws)).call('GET', '/contacts/export')).headers.get('cache-control')).toBe('no-store');
  });

  it('staff are refused and nothing is audited; a super admin session is refused too (the operator has its own audited route)', async () => {
    const ws = W(4204);
    await seed(ws, 2);
    expect((await (await apiFor(ws, 'staff')).call('GET', '/contacts/export')).status).toBe(403);
    const res = await (await import('cloudflare:test')).SELF.fetch(`https://x/api/v1/stores/${ws}/contacts/export`, { headers: { authorization: `Bearer ${await adminToken()}` } });
    expect(res.status).toBe(403);
    expect(await audit(ws, 'contacts.export_all')).toEqual([]);
  });

  it('a token for another store cannot export this one', async () => {
    const ws = W(4205);
    const other = W(4206);
    await seed(ws, 2);
    const attacker = await apiFor(other);
    const { SELF } = await import('cloudflare:test');
    const res = await SELF.fetch(`https://x/api/v1/stores/${ws}/contacts/export`, { headers: { authorization: `Bearer ${attacker.token}` } });
    expect([403, 404]).toContain(res.status);
    expect(await audit(ws, 'contacts.export_all')).toEqual([]);
  });

  it('a revoked session cannot read the export (the bulk read re-checks the session like a write)', async () => {
    const ws = W(4208);
    await seed(ws, 1);
    const owner = await apiFor(ws);
    configureSessionCheck(async () => true);
    expect((await owner.call('GET', '/contacts/export')).status).toBe(403);
    expect(await audit(ws, 'contacts.export_all')).toEqual([]);
  });

  it('validates the page size and the cursor at the edge (Zod)', async () => {
    const ws = W(4207);
    await seed(ws, 1);
    const owner = await apiFor(ws);
    for (const bad of ['limit=0', 'limit=501', 'limit=abc', 'cursor=x1', 'cursor=-1']) expect((await owner.call('GET', `/contacts/export?${bad}`)).status, bad).toBe(400);
    expect((await owner.call('GET', '/contacts/export?limit=500')).status).toBe(200);
  });
});
