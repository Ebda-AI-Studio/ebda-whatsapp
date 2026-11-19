import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { apiFor, apiKey, storeId as W, useApiKey } from './helpers/api';
import { mint } from './helpers/issuer';

// CH1/CH2: /me says whether THIS store has a Chat workspace, and lists the person's stores that do (name + role) for the store picker.
useApiKey();

describe('GET /me: workspace + stores', () => {
  it('a store with a workspace says so and lists every store of the person that has one (never one without)', async () => {
    const withChat = W(9101);
    const other = W(9102);
    const noChat = W(9103);
    await apiFor(withChat);
    await apiFor(other);
    const token = await mint(apiKey(), { stores: [{ id: withChat, role: 'owner' }, { id: noChat, role: 'owner' }, { id: other, role: 'staff' }] });
    const me = await (await SELF.fetch(`https://x/api/v1/stores/${withChat}/me`, { headers: { authorization: `Bearer ${token}` } })).json() as { workspace: boolean; stores: { id: string; name: string; role: string }[] };
    expect(me.workspace).toBe(true);
    expect(me.stores.map((s) => s.id).sort()).toEqual([other, withChat].sort());
    expect(me.stores.find((s) => s.id === other)?.role).toBe('staff');
    expect(me.stores.every((s) => typeof s.name === 'string' && s.name !== '')).toBe(true);
  });

  it('an active store with NO workspace answers 200 with workspace:false, and still lists the stores that have Chat', async () => {
    const withChat = W(9111);
    const noChat = W(9112);
    await apiFor(withChat);
    const token = await mint(apiKey(), { stores: [{ id: noChat, role: 'owner' }, { id: withChat, role: 'owner' }] });
    const res = await SELF.fetch(`https://x/api/v1/stores/${noChat}/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const me = await res.json() as { workspace: boolean; stores: { id: string }[] };
    expect(me.workspace).toBe(false);
    expect(me.stores.map((s) => s.id)).toEqual([withChat]);
  });
});
