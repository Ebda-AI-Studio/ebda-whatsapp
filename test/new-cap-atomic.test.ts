import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { newCapUsage, reserveNewCap } from '../src/core/campaigns/new-cap';

const base = { phoneNumberId: 'pn-atomic', n: 2, now: 1_000_000, cap: 3, since: 0 };

describe('NEW-CAP-ATOMIC-1: reservation is one conditional statement', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM new_cap_usage').run();
    await env.DB.prepare("DELETE FROM workspace_owners WHERE workspace_id LIKE 'atomic-%'").run();
    await env.DB.prepare("INSERT INTO workspace_owners (workspace_id, owner_user_id, updated_at) VALUES ('atomic-a', 'o1', 1), ('atomic-b', 'o1', 1)").run();
  });

  it('two concurrent reservations that together exceed the cap: exactly one succeeds', async () => {
    const [x, y] = await Promise.all([
      reserveNewCap(env, { ...base, workspaceId: 'atomic-a', ref: 'r-a' }),
      reserveNewCap(env, { ...base, workspaceId: 'atomic-b', ref: 'r-b' }), // same owner, other workspace
    ]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    const loser = x.ok ? y : x;
    expect(loser).toEqual({ ok: false, reason: 'cap_reached' });
    const used = await env.DB.prepare('SELECT sum(n) AS s FROM new_cap_usage').first<{ s: number }>();
    expect(used!.s).toBe(2);
  });

  const ownNumber = async (): Promise<void> => {
    await env.DB.prepare("INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES ('atomic-a', 'a', 1)").run();
    await env.DB.prepare("INSERT OR REPLACE INTO phone_numbers (phone_number_id, waba_id, workspace_id, status, kind) VALUES ('pn-atomic', 'w1', 'atomic-a', 'active', 'own')").run();
  };

  it('an OWN number is capped across different owners', async () => {
    await ownNumber();
    await env.DB.prepare("INSERT OR REPLACE INTO workspace_owners (workspace_id, owner_user_id, updated_at) VALUES ('atomic-b', 'o2', 1)").run();
    const [x, y] = await Promise.all([
      reserveNewCap(env, { ...base, workspaceId: 'atomic-a', ref: 'r-a' }),
      reserveNewCap(env, { ...base, workspaceId: 'atomic-b', ref: 'r-b' }),
    ]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
  });

  it('a missing owner row is refused (fail closed), nothing is written', async () => {
    expect(await reserveNewCap(env, { ...base, workspaceId: 'atomic-none', ref: 'r-n' })).toEqual({ ok: false, reason: 'no_owner' });
    expect((await env.DB.prepare('SELECT count(*) AS c FROM new_cap_usage').first<{ c: number }>())!.c).toBe(0);
  });

  it('the same ref retried is allowed and does not double count', async () => {
    expect(await reserveNewCap(env, { ...base, workspaceId: 'atomic-a', ref: 'r-a' })).toEqual({ ok: true });
    expect(await reserveNewCap(env, { ...base, workspaceId: 'atomic-a', ref: 'r-a' })).toEqual({ ok: true });
    expect((await env.DB.prepare('SELECT sum(n) AS s FROM new_cap_usage').first<{ s: number }>())!.s).toBe(2);
  });

  it('platform number: tenant A exhausting its cap does not block tenant B (other owner), but A stays capped', async () => {
    await env.DB.prepare("DELETE FROM phone_numbers WHERE phone_number_id = 'pn-atomic'").run();
    await env.DB.prepare("INSERT OR REPLACE INTO workspace_owners (workspace_id, owner_user_id, updated_at) VALUES ('atomic-b', 'o2', 1)").run();
    expect(await reserveNewCap(env, { ...base, workspaceId: 'atomic-a', ref: 'r-a1' })).toEqual({ ok: true });
    expect(await reserveNewCap(env, { ...base, workspaceId: 'atomic-a', ref: 'r-a2' })).toEqual({ ok: false, reason: 'cap_reached' });
    expect(await reserveNewCap(env, { ...base, workspaceId: 'atomic-b', ref: 'r-b1' })).toEqual({ ok: true });
    expect((await newCapUsage(env, 'atomic-b', 'pn-atomic', 0)).used).toBe(2);
  });

  it('platform number: one owner with two workspaces is still capped (owner scope)', async () => {
    await env.DB.prepare("DELETE FROM phone_numbers WHERE phone_number_id = 'pn-atomic'").run();
    expect(await reserveNewCap(env, { ...base, workspaceId: 'atomic-a', ref: 'r-a1' })).toEqual({ ok: true });
    expect(await reserveNewCap(env, { ...base, workspaceId: 'atomic-b', ref: 'r-b1' })).toEqual({ ok: false, reason: 'cap_reached' });
  });
});
