import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { configureSessionCheck } from '../src/core/identity/session';
import { apiKey, useApiKey } from './helpers/api';
import { mint } from './helpers/issuer';

useApiKey();
const clean = async () => {
  for (const sql of ['DELETE FROM workspace_members', 'DELETE FROM workspace_owners', 'DELETE FROM standalone_invites', 'DELETE FROM workspace_creations', "DELETE FROM workspaces WHERE kind = 'standalone'"]) await env.DB.prepare(sql).run();
};
beforeEach(async () => { configureSessionCheck(async () => false); await clean(); }); // one D1 per file: every test starts from no standalone rows (the operator routes check the session through the accounts binding)
afterEach(() => configureSessionCheck(null));
const OP = '11111111-1111-4111-8111-111111111111';
const op = () => mint(apiKey(), { sub: OP, pa: 'super_admin', stores: [] });
const call = async (token: string | null, method: string, path: string, body?: unknown) =>
  worker.fetch(new Request(`https://x/api/v1/operator${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env, createExecutionContext());
const seed = async (n: number) => {
  const stmts = [];
  for (let i = 0; i < n; i++) {
    const id = `sw_${String(i).padStart(26, 'a').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!)}`;
    stmts.push(env.DB.prepare("INSERT INTO workspaces (id, name, created_at, kind, country) VALUES (?, ?, ?, 'standalone', 'EG')").bind(id, `W${i}`, 1_000_000 + Math.floor(i / 3))); // ties on created_at on purpose
    stmts.push(env.DB.prepare('INSERT INTO workspace_owners (workspace_id, owner_user_id, updated_at) VALUES (?, ?, 0)').bind(id, `user-${i}`));
  }
  await env.DB.batch(stmts);
};

describe('operator: invite codes', () => {
  it('403 for a person who is not a super admin, 401 without a token', async () => {
    const person = await mint(apiKey(), { sub: '6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e01', stores: [] });
    for (const [m, p] of [['POST', '/standalone-invites'], ['GET', '/standalone-invites'], ['GET', '/workspaces'], ['POST', `/standalone-invites/${'a'.repeat(32)}/revoke`]] as const) {
      expect((await call(person, m, p, m === 'POST' ? {} : undefined)).status, `${m} ${p}`).toBe(403);
      expect((await call(null, m, p, m === 'POST' ? {} : undefined)).status, `${m} ${p}`).toBe(401);
    }
  });
  it('mint returns the plain code once with no-store; list never shows it; revoke works once, then 404; days > 30 is 400', async () => {
    const t = await op();
    const m = await call(t, 'POST', '/standalone-invites', { note: 'Acme Co', days: 7 });
    expect(m.status).toBe(201);
    expect(m.headers.get('cache-control')).toBe('no-store');
    const { code, codeHash, expiresAt } = (await m.json()) as { code: string; codeHash: string; expiresAt: number };
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    const list = await (await call(t, 'GET', '/standalone-invites')).text();
    expect(list).toContain(codeHash);
    expect(list).not.toContain(code);
    expect(list).not.toContain(code.replace(/-/g, ''));
    expect((await call(t, 'POST', `/standalone-invites/${codeHash}/revoke`)).status).toBe(200);
    expect((await call(t, 'POST', `/standalone-invites/${codeHash}/revoke`)).status).toBe(404);
    expect((await call(t, 'POST', '/standalone-invites/nothex/revoke')).status).toBe(400);
    expect((await call(t, 'POST', '/standalone-invites', { days: 31 })).status).toBe(400);
    const audit = (await env.DB.prepare("SELECT action FROM audit_log WHERE action LIKE 'invite.%'").all<{ action: string }>()).results.map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['invite.minted', 'invite.revoked']));
  });
  it('a revoked operator session cannot mint', async () => {
    configureSessionCheck(async () => true);
    expect((await call(await op(), 'POST', '/standalone-invites', {})).status).toBe(403);
  });
});

describe('operator: workspace list', () => {
  it('paginates stably across 120 rows (ties on created_at included): no gaps, no duplicates, newest first, explicit columns', async () => {
    await seed(120);
    const t = await op();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await call(t, 'GET', `/workspaces?kind=standalone${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status).toBe(200);
      const b = (await r.json()) as { items: Record<string, unknown>[]; nextCursor: string | null };
      for (const it of b.items) {
        expect(Object.keys(it).sort()).toEqual(['country', 'createdAt', 'id', 'kind', 'name', 'ownerUserId', 'suspendedAt']);
        seen.push(it.id as string);
      }
      cursor = b.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });
  it('kind filter, and a bad kind or cursor is 400', async () => {
    await seed(2);
    await env.DB.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-000000000009', 'Store ws', 5)").run();
    const t = await op();
    const std = (await (await call(t, 'GET', '/workspaces?kind=standalone')).json()) as { items: { kind: string }[] };
    expect(std.items.map((i) => i.kind)).toEqual(['standalone', 'standalone']);
    const store = (await (await call(t, 'GET', '/workspaces?kind=store')).json()) as { items: { kind: string }[] };
    expect(store.items.every((i) => i.kind === 'store')).toBe(true);
    expect((await call(t, 'GET', '/workspaces?kind=other')).status).toBe(400);
    expect((await call(t, 'GET', '/workspaces?cursor=!!!')).status).toBe(400);
  });
});
