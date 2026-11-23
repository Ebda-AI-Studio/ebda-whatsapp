import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { configureSessionCheck } from '../src/core/identity/session';
import { inviteHash, mintInviteCode, normaliseInviteCode } from '../src/core/standalone/invites';
import { apiKey, useApiKey } from './helpers/api';
import { mint, mintClient } from './helpers/issuer';

useApiKey();
const clean = async () => {
  for (const sql of ['DELETE FROM workspace_members', 'DELETE FROM workspace_owners', 'DELETE FROM standalone_invites', 'DELETE FROM workspace_creations', "DELETE FROM workspaces WHERE kind = 'standalone'"]) await env.DB.prepare(sql).run();
};
beforeEach(async () => { configureSessionCheck(async () => false); await clean(); }); // one D1 per file: every test starts from no standalone rows (the operator routes check the session through the accounts binding)
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

const U1 = '6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e01';
const U2 = '6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e02';
type Over = Record<string, unknown>;
const call = async (token: string | null, method: string, path: string, body?: unknown, over: Over = {}, ip = '203.0.113.7') =>
  worker.fetch(
    new Request(`https://x/api/v1${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'cf-connecting-ip': ip, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
    { ...env, ...over } as typeof env,
    createExecutionContext(),
  );
const person = (sub: string) => mint(apiKey(), { sub, stores: [] });
const operator = () => mint(apiKey(), { sub: '11111111-1111-4111-8111-111111111111', pa: 'super_admin', stores: [] });
const mintCode = async (days?: number) => {
  const r = await call(await operator(), 'POST', '/operator/standalone-invites', { note: 'client x', ...(days ? { days } : {}) });
  expect(r.status).toBe(201);
  return (await r.json()) as { code: string; codeHash: string; expiresAt: number };
};
const create = (sub: string, body: unknown, mode: string, ip?: string) => person(sub).then((t) => call(t, 'POST', '/workspaces', body, { STANDALONE_WORKSPACES: mode }, ip));
const rows = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).all<Record<string, unknown>>().then((r) => r.results);

describe('invite code format', () => {
  it('12 Crockford characters grouped 4-4-4, normalised case-, dash- and look-alike-insensitively; the hash is keyed and stable', async () => {
    const c = mintInviteCode();
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normaliseInviteCode(c.toLowerCase().replace(/-/g, ' '))).toBe(c.replace(/-/g, ''));
    expect(normaliseInviteCode('OIL0-0000-0000')).toBe('011000000000');
    expect(normaliseInviteCode('short')).toBeNull();
    const h = await inviteHash(env, c);
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(await inviteHash(env, c.toLowerCase())).toBe(h);
    expect(await inviteHash({ ERASURE_HMAC_KEY: 'another-key-another-key-another-key!' }, c)).not.toBe(h);
    expect(await inviteHash({}, c)).toBeNull(); // no key, no invites
  });
});

describe('POST /workspaces: the flag matrix', () => {
  it('off (also unset or unknown): 403 standalone_off, nothing written, no rate row', async () => {
    for (const mode of ['off', '', 'banana']) {
      const r = await create(U1, { name: 'Acme', country: 'EG' }, mode);
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ message: 'standalone_off' });
    }
    expect(await rows('SELECT count(*) AS n FROM workspaces WHERE kind = ?', 'standalone')).toEqual([{ n: 0 }]);
    expect(await rows('SELECT count(*) AS n FROM workspace_creations')).toEqual([{ n: 0 }]);
  });

  it('invite: no code -> invite_required; wrong, malformed -> invite_invalid (one message); a good code creates', async () => {
    const none = await create(U1, { name: 'Acme', country: 'EG' }, 'invite');
    expect(none.status).toBe(403);
    expect(await none.json()).toMatchObject({ message: 'invite_required' });
    for (const [i, inviteCode] of ['ABCD-EFGH-JKMN', 'nope'].entries()) {
      const bad = await create(`6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d70${i}0`, { name: 'Acme', country: 'EG', inviteCode }, 'invite');
      expect(bad.status).toBe(403);
      expect(await bad.json()).toMatchObject({ message: 'invite_invalid' });
    }
    const { code } = await mintCode();
    const ok = await create(U1, { name: '  Acme Studio  ', country: 'EG', inviteCode: code.toLowerCase() }, 'invite');
    expect(ok.status).toBe(201);
    const b = (await ok.json()) as { id: string; name: string };
    expect(b.id).toMatch(/^sw_[a-z2-7]{26}$/);
    expect(b.name).toBe('Acme Studio');
    expect(await rows("SELECT role, status FROM workspace_members WHERE workspace_id = ? AND user_id = ?", b.id, U1)).toEqual([{ role: 'owner', status: 'active' }]);
  });

  it('open: no code needed', async () => {
    const r = await create(U1, { name: 'Open Co', country: 'EG' }, 'open');
    expect(r.status).toBe(201);
  });

  it('a code is single use: the second person gets invite_invalid and no workspace; used_workspace_id points at the first', async () => {
    const { code, codeHash } = await mintCode();
    const first = (await (await create(U1, { name: 'A', country: 'EG', inviteCode: code }, 'invite')).json()) as { id: string };
    const second = await create(U2, { name: 'B', country: 'EG', inviteCode: code }, 'invite');
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ message: 'invite_invalid' });
    expect(await rows("SELECT count(*) AS n FROM workspaces WHERE kind = 'standalone'")).toEqual([{ n: 1 }]);
    expect(await rows('SELECT used_by, used_workspace_id FROM standalone_invites WHERE code_hash = ?', codeHash)).toEqual([{ used_by: U1, used_workspace_id: first.id }]);
  });

  it('an expired or revoked code is invite_invalid', async () => {
    const a = await mintCode();
    await env.DB.prepare('UPDATE standalone_invites SET expires_at = ? WHERE code_hash = ?').bind(Date.now() - 1000, a.codeHash).run();
    expect((await create(U1, { name: 'A', country: 'EG', inviteCode: a.code }, 'invite')).status).toBe(403);
    const b = await mintCode();
    expect((await call(await operator(), 'POST', `/operator/standalone-invites/${b.codeHash}/revoke`)).status).toBe(200);
    expect((await create(U1, { name: 'A', country: 'EG', inviteCode: b.code }, 'invite')).status).toBe(403);
    expect(await rows("SELECT count(*) AS n FROM workspaces WHERE kind = 'standalone'")).toEqual([{ n: 0 }]);
  });
});

describe('POST /workspaces: one per person, validation, rate limit', () => {
  it('a second creation returns 409 with the existing id and does NOT burn the second code', async () => {
    const a = await mintCode();
    const b = await mintCode();
    const first = (await (await create(U1, { name: 'A', country: 'EG', inviteCode: a.code }, 'invite')).json()) as { id: string };
    const again = await create(U1, { name: 'A2', country: 'EG', inviteCode: b.code }, 'invite');
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'already_owns_workspace', id: first.id });
    expect(await rows('SELECT used_at FROM standalone_invites WHERE code_hash = ?', b.codeHash)).toEqual([{ used_at: null }]);
  });

  it('body: 101-char name, empty name after stripping controls, wrong country, extra keys, non-JSON -> 400', async () => {
    for (const [i, body] of [{ name: 'x'.repeat(101), country: 'EG' }, { name: '\u0007\u0000 ', country: 'EG' }, { name: 'A', country: 'KW' }, { name: 'A', country: 'EG', owner: 'me' }, { country: 'EG' }].entries()) {
      const r = await create(`6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d71${i}0`, body, 'open', `198.51.100.${i}`);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    const t = await person(U1);
    const raw = await worker.fetch(new Request('https://x/api/v1/workspaces', { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: 'not json' }), { ...env, STANDALONE_WORKSPACES: 'open' } as typeof env, createExecutionContext());
    expect(raw.status).toBe(400);
  });

  it('control characters are stripped from the name', async () => {
    const r = await create(U1, { name: 'Ac\u0007me\u0000', country: 'EG' }, 'open');
    expect(r.status).toBe(201);
    expect(((await r.json()) as { name: string }).name).toBe('Acme');
  });

  it('per user: the 4th attempt in 24 h is 429 with retry-after, refused attempts count, and the table keeps no plain IP', async () => {
    for (let i = 0; i < 3; i++) expect((await create(U1, { name: 'A', country: 'EG', inviteCode: 'ABCD-EFGH-JKMN' }, 'invite')).status).toBe(403);
    const r = await create(U1, { name: 'A', country: 'EG', inviteCode: 'ABCD-EFGH-JKMN' }, 'invite');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
    const stored = JSON.stringify(await rows('SELECT * FROM workspace_creations'));
    expect(stored).not.toContain('203.0.113.7');
  });

  it('per IP: the 11th attempt from one address is 429 even across different people', async () => {
    for (let i = 0; i < 10; i++) {
      const sub = `6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d6${String(i).padStart(3, '0')}`;
      expect((await create(sub, { name: 'A', country: 'EG', inviteCode: 'ABCD-EFGH-JKMN' }, 'invite', '192.0.2.50')).status).toBe(403);
    }
    expect((await create(U2, { name: 'A', country: 'EG', inviteCode: 'ABCD-EFGH-JKMN' }, 'invite', '192.0.2.50')).status).toBe(429);
    expect((await create(U2, { name: 'A', country: 'EG', inviteCode: 'ABCD-EFGH-JKMN' }, 'invite', '192.0.2.51')).status).toBe(403); // another address is unaffected
  });

  it('two concurrent creations by one person make exactly one workspace', async () => {
    const [a, b] = await Promise.all([create(U1, { name: 'A', country: 'EG' }, 'open'), create(U1, { name: 'A', country: 'EG' }, 'open')]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await rows("SELECT count(*) AS n FROM workspaces WHERE kind = 'standalone'")).toEqual([{ n: 1 }]);
  });
});

describe('POST /workspaces: who may call', () => {
  const body = { name: 'A', country: 'EG' };
  it('no token / garbage -> 401; an integrator token -> 403 (even with every flag on)', async () => {
    expect((await call(null, 'POST', '/workspaces', body, { STANDALONE_WORKSPACES: 'open' })).status).toBe(401);
    expect((await call('garbage', 'POST', '/workspaces', body, { STANDALONE_WORKSPACES: 'open' })).status).toBe(401);
    const client = await mintClient(apiKey(), { storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', scope: 'conversations:read' });
    const r = await call(client, 'POST', '/workspaces', body, { STANDALONE_WORKSPACES: 'open', INTEGRATOR_TOKENS_ENABLED: 'true', ACCOUNTS: { isRevoked: async () => false } });
    expect(r.status).toBe(403);
    expect((await call(client, 'GET', '/workspaces/mine', undefined, { INTEGRATOR_TOKENS_ENABLED: 'true', ACCOUNTS: { isRevoked: async () => false } })).status).toBe(403);
  });
  it('an expired token -> 401', async () => {
    const t = await mint(apiKey(), { sub: U1, stores: [] }, { expSeconds: -600 });
    expect((await call(t, 'POST', '/workspaces', body, { STANDALONE_WORKSPACES: 'open' })).status).toBe(401);
  });
  it('a revoked session -> 403 session_revoked; accounts unreachable -> 503; neither writes anything', async () => {
    configureSessionCheck(async () => true);
    const r = await create(U1, body, 'open');
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ message: 'session_revoked' });
    configureSessionCheck(async () => { throw new Error('down'); });
    expect((await create(U1, body, 'open')).status).toBe(503);
    expect(await rows("SELECT count(*) AS n FROM workspaces WHERE kind = 'standalone'")).toEqual([{ n: 0 }]);
  });
  it('a D1 failure on the rate counter fails closed (503), never creates', async () => {
    const db = env.DB;
    const flaky = { prepare: (sql: string) => { if (sql.includes('workspace_creations')) throw new Error('d1 down'); return db.prepare(sql); }, batch: (st: D1PreparedStatement[]) => db.batch(st), exec: (q: string) => db.exec(q) }; // a plain object: Sentry's D1 instrumentation must not wrap (and keep) the real binding
    const broken = { ...env, STANDALONE_WORKSPACES: 'open', DB: flaky } as unknown as typeof env;
    const r = await worker.fetch(new Request('https://x/api/v1/workspaces', { method: 'POST', headers: { authorization: `Bearer ${await person(U1)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), broken, createExecutionContext());
    expect(r.status).toBe(503);
    expect(await rows("SELECT count(*) AS n FROM workspaces WHERE kind = 'standalone'")).toEqual([{ n: 0 }]);
  });
});

describe('audit and logs', () => {
  it('writes workspace.created and invite.consumed rows (ids/hashes only); the plain code is in no D1 table and no log line', async () => {
    const log = vi.spyOn(console, 'log');
    const { code, codeHash } = await mintCode();
    const r = await create(U1, { name: 'Acme', country: 'EG', inviteCode: code }, 'invite');
    const { id } = (await r.json()) as { id: string };
    const audit = await rows('SELECT action, workspace_id, actor, actor_role, target_id FROM audit_log WHERE workspace_id = ? OR target_id = ? ORDER BY id', id, codeHash); // the audit log is append-only and survives across tests
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['invite.minted', 'workspace.created', 'invite.consumed']));
    expect(audit.filter((a) => a.action === 'workspace.created')).toHaveLength(1);
    expect(audit.find((a) => a.action === 'workspace.created')).toMatchObject({ workspace_id: id, actor: U1, actor_role: 'owner' });
    expect(audit.find((a) => a.action === 'invite.consumed')).toMatchObject({ target_id: codeHash });
    const plain = code.replace(/-/g, '');
    const dump = JSON.stringify([await rows('SELECT * FROM standalone_invites'), audit, await rows('SELECT * FROM workspaces'), await rows('SELECT * FROM workspace_members')]);
    expect(dump).not.toContain(plain);
    expect(dump).not.toContain(code);
    expect(JSON.stringify(log.mock.calls)).not.toContain(plain);
    expect(JSON.stringify(log.mock.calls)).not.toContain(code);
  });
});

describe('GET /workspaces/mine', () => {
  it('lists only my active standalone memberships, with canCreate / needsInvite per flag', async () => {
    const t = await person(U1);
    const empty = (await (await call(t, 'GET', '/workspaces/mine', undefined, { STANDALONE_WORKSPACES: 'invite' })).json()) as Record<string, unknown>;
    expect(empty).toEqual({ items: [], canCreate: true, needsInvite: true });
    const { id } = (await (await create(U1, { name: 'Mine', country: 'EG' }, 'open')).json()) as { id: string };
    await create(U2, { name: 'Theirs', country: 'EG' }, 'open', '198.51.100.20');
    const mine = (await (await call(t, 'GET', '/workspaces/mine', undefined, { STANDALONE_WORKSPACES: 'open' })).json()) as { items: { id: string; role: string; kind: string; name: string }[]; canCreate: boolean; needsInvite: boolean };
    expect(mine.items).toEqual([{ id, name: 'Mine', role: 'owner', kind: 'standalone' }]);
    expect(mine).toMatchObject({ canCreate: false, needsInvite: false });
    const off = (await (await call(t, 'GET', '/workspaces/mine', undefined, { STANDALONE_WORKSPACES: 'off' })).json()) as { canCreate: boolean };
    expect(off.canCreate).toBe(false);
    await env.DB.prepare("UPDATE workspace_members SET status = 'removed' WHERE user_id = ?").bind(U1).run();
    expect(((await (await call(t, 'GET', '/workspaces/mine', undefined, { STANDALONE_WORKSPACES: 'open' })).json()) as { items: unknown[] }).items).toEqual([]);
  });
  it('401 without a token', async () => {
    expect((await call(null, 'GET', '/workspaces/mine')).status).toBe(401);
  });
});
