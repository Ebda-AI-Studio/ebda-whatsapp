import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isStandaloneId, isStoreId, mintStandaloneId } from '../src/core/workspace-kind';
import { createStandaloneWorkspace, ensureWorkspace, pruneWorkspaceCreations } from '../src/core/workspace-registry';
import { deliver, storeEvent, useStoreLink } from './helpers/store-link';

// Ruling CHAT-SA-2 / CHAT-SA-3: a second workspace kind with its own id space, checked by D1 triggers; one atomic creation.
useStoreLink();
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); });
const U = (n: number) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const UUID_WS = '00000000-0000-4000-8000-000000009901';
const run = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).run();
const count = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const hashOf = async (code: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))].map((x) => x.toString(16).padStart(2, '0')).join('');
const invite = async (code: string, o: { expires?: number; revoked?: boolean } = {}) => {
  const h = await hashOf(code);
  await run('INSERT INTO standalone_invites (code_hash, created_by, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)', h, 'op', 1, o.expires ?? Date.now() + 86_400_000, o.revoked ? 5 : null);
  return h;
};

describe('id space', () => {
  it('mints 1000 ids that all match sw_<26 base32> and none passes isStoreId', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = mintStandaloneId();
      expect(id).toMatch(/^sw_[a-z2-7]{26}$/);
      expect(isStandaloneId(id)).toBe(true);
      expect(isStoreId(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });
  it('a Store UUID is never standalone; near-misses are neither', () => {
    expect(isStandaloneId(UUID_WS)).toBe(false);
    expect(isStoreId(UUID_WS)).toBe(true);
    for (const bad of ['sw_SHORT', 'SW_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'sw_aaaaaaaaaaaaaaaaaaaaaaaaaaa', 'sw_aaaaaaaaaaaaaaaaaaaaaaaaa1', '../sw_aaaaaaaaaaaaaaaaaaaaaaaaaa', '']) {
      expect(isStandaloneId(bad), bad).toBe(false);
      expect(isStoreId(bad), bad).toBe(false);
    }
  });
});

describe('D1 triggers tie kind to the id prefix', () => {
  it('standalone kind with a UUID id aborts; store kind with an sw_ id aborts; default kind with sw_ id aborts', async () => {
    await expect(run("INSERT INTO workspaces (id, name, created_at, kind) VALUES (?, 'x', 1, 'standalone')", UUID_WS)).rejects.toThrow(/workspace_kind_id_mismatch/);
    await expect(run("INSERT INTO workspaces (id, name, created_at, kind) VALUES (?, 'x', 1, 'store')", 'sw_aaaaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toThrow(/workspace_kind_id_mismatch/);
    await expect(run("INSERT INTO workspaces (id, name, created_at) VALUES (?, 'x', 1)", 'sw_aaaaaaaaaaaaaaaaaaaaaaaaab')).rejects.toThrow(/workspace_kind_id_mismatch/);
    await expect(run("INSERT INTO workspaces (id, name, created_at, kind) VALUES ('SW_aaaaaaaaaaaaaaaaaaaaaaaaac', 'x', 1, 'standalone')")).rejects.toThrow(/workspace_kind_id_mismatch/);
  });
  it('an unknown kind is refused by the column CHECK', async () => {
    await expect(run("INSERT INTO workspaces (id, name, created_at, kind) VALUES (?, 'x', 1, 'other')", UUID_WS)).rejects.toThrow();
  });
  it('a Store workspace row defaults to kind store, country EG; re-kinding it or renaming its id into sw_ aborts', async () => {
    await run("INSERT INTO workspaces (id, name, created_at) VALUES (?, 'shop', 1)", UUID_WS);
    expect(await env.DB.prepare('SELECT kind, country FROM workspaces WHERE id = ?').bind(UUID_WS).first()).toEqual({ kind: 'store', country: 'EG' });
    await expect(run("UPDATE workspaces SET kind = 'standalone' WHERE id = ?", UUID_WS)).rejects.toThrow(/workspace_kind_id_mismatch/);
    await expect(run("UPDATE workspaces SET id = 'sw_aaaaaaaaaaaaaaaaaaaaaaaaad' WHERE id = ?", UUID_WS)).rejects.toThrow(/workspace_kind_id_mismatch/);
    await run("UPDATE workspaces SET name = 'renamed' WHERE id = ?", UUID_WS); // unrelated updates still work
  });
  it('workspace_members rejects a Store (UUID) workspace', async () => {
    await run("INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, 'shop', 1)", UUID_WS);
    await expect(run("INSERT INTO workspace_members (workspace_id, user_id, role, status, added_by, created_at, updated_at) VALUES (?, 'u', 'owner', 'active', 'u', 1, 1)", UUID_WS)).rejects.toThrow(/workspace_members_standalone_only/);
  });
});

describe('ensureWorkspace and Store events refuse sw_ ids', () => {
  it('ensureWorkspace throws for an sw_ id and writes nothing', async () => {
    const id = mintStandaloneId();
    await expect(ensureWorkspace(env, { storeId: id, ownerUserId: U(1), name: 'x' })).rejects.toThrow('standalone_id_refused');
    expect(await count('SELECT count(*) AS n FROM workspaces WHERE id = ?', id)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM workspace_owners WHERE workspace_id = ?', id)).toBe(0);
  });
  it('store.linked naming an sw_ id is acked, creates no row and is logged as store_event_non_store_id', async () => {
    const id = mintStandaloneId();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await deliver([storeEvent(id, 'store.linked', { ownerUserId: U(1) })]);
    expect(res.explicitAcks).toEqual(['e0']);
    expect(await count('SELECT count(*) AS n FROM workspaces WHERE id = ?', id)).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('store_event_non_store_id'))).toBe(true);
  });
});

describe('createStandaloneWorkspace', () => {
  const a = (user: string, h: string | null) => ({ ownerUserId: user, name: ' Acme Marketing ', country: 'EG' as const, inviteCodeHash: h });
  it('creates the workspace, owner membership, owner row and consumes the invite in one go', async () => {
    const h = await invite('code-1');
    const r = await createStandaloneWorkspace(env, a(U(1), h));
    expect(r.status).toBe('created');
    if (r.status !== 'created') return;
    expect(isStandaloneId(r.id)).toBe(true);
    expect(await env.DB.prepare('SELECT name, kind, country FROM workspaces WHERE id = ?').bind(r.id).first()).toEqual({ name: 'Acme Marketing', kind: 'standalone', country: 'EG' });
    expect(await env.DB.prepare('SELECT user_id, role, status FROM workspace_members WHERE workspace_id = ?').bind(r.id).first()).toEqual({ user_id: U(1), role: 'owner', status: 'active' });
    expect(await env.DB.prepare('SELECT owner_user_id FROM workspace_owners WHERE workspace_id = ?').bind(r.id).first()).toEqual({ owner_user_id: U(1) });
    expect(await env.DB.prepare('SELECT used_by, used_workspace_id FROM standalone_invites WHERE code_hash = ?').bind(h).first()).toEqual({ used_by: U(1), used_workspace_id: r.id });
  });
  it('a second call by the same user is already_owns, leaves exactly one workspace and does not burn a fresh invite', async () => {
    const first = await createStandaloneWorkspace(env, a(U(2), null));
    expect(first.status).toBe('created');
    const h2 = await invite('code-2');
    expect((await createStandaloneWorkspace(env, a(U(2), h2))).status).toBe('already_owns');
    expect((await createStandaloneWorkspace(env, a(U(2), null))).status).toBe('already_owns');
    expect(await count("SELECT count(*) AS n FROM workspace_members WHERE user_id = ? AND role = 'owner'", U(2))).toBe(1);
    expect(await env.DB.prepare('SELECT used_at FROM standalone_invites WHERE code_hash = ?').bind(h2).first()).toEqual({ used_at: null });
  });
  it('an invite works once: the second user gets invite_invalid and no workspace row', async () => {
    const h = await invite('code-3');
    expect((await createStandaloneWorkspace(env, a(U(3), h))).status).toBe('created');
    const before = await count('SELECT count(*) AS n FROM workspaces');
    expect((await createStandaloneWorkspace(env, a(U(4), h))).status).toBe('invite_invalid');
    expect(await count('SELECT count(*) AS n FROM workspaces')).toBe(before);
    expect(await count('SELECT count(*) AS n FROM workspace_members WHERE user_id = ?', U(4))).toBe(0);
  });
  it('expired, revoked and unknown invites are invite_invalid with no workspace', async () => {
    const before = await count('SELECT count(*) AS n FROM workspaces');
    expect((await createStandaloneWorkspace(env, a(U(5), await invite('old', { expires: Date.now() - 1000 })))).status).toBe('invite_invalid');
    expect((await createStandaloneWorkspace(env, a(U(5), await invite('rev', { revoked: true })))).status).toBe('invite_invalid');
    expect((await createStandaloneWorkspace(env, a(U(5), await hashOf('never-minted')))).status).toBe('invite_invalid');
    expect(await count('SELECT count(*) AS n FROM workspaces')).toBe(before);
  });
  it('two concurrent calls by one user create exactly one workspace', async () => {
    const [x, y] = await Promise.all([createStandaloneWorkspace(env, a(U(6), null)), createStandaloneWorkspace(env, a(U(6), null))]);
    expect([x.status, y.status].sort()).toEqual(['already_owns', 'created']);
    expect(await count("SELECT count(*) AS n FROM workspace_members WHERE user_id = ? AND role = 'owner'", U(6))).toBe(1);
  });
  it('two concurrent users racing for ONE invite: exactly one workspace', async () => {
    const h = await invite('race');
    const [x, y] = await Promise.all([createStandaloneWorkspace(env, a(U(7), h)), createStandaloneWorkspace(env, a(U(8), h))]);
    expect([x.status, y.status].sort()).toEqual(['created', 'invite_invalid']);
    expect(await count('SELECT count(*) AS n FROM standalone_invites WHERE code_hash = ? AND used_workspace_id IS NOT NULL', h)).toBe(1);
  });
  it('an empty name throws before anything is written', async () => {
    const before = await count('SELECT count(*) AS n FROM workspaces');
    await expect(createStandaloneWorkspace(env, { ownerUserId: U(9), name: '   ', country: 'EG', inviteCodeHash: null })).rejects.toThrow('invalid_name');
    expect(await count('SELECT count(*) AS n FROM workspaces')).toBe(before);
  });
});

describe('creation-attempt log retention', () => {
  it('prunes rows older than 2 days and keeps recent ones', async () => {
    const now = Date.now();
    await run('INSERT INTO workspace_creations (user_id, ip_hash, at) VALUES (?, ?, ?), (?, ?, ?)', 'u', 'ip', now - 3 * 86_400_000, 'u', 'ip', now - 1000);
    await pruneWorkspaceCreations(env, now);
    expect(await count('SELECT count(*) AS n FROM workspace_creations WHERE user_id = ?', 'u')).toBe(1);
  });
});
