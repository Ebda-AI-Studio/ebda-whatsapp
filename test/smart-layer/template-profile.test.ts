import { describe, expect, it } from 'vitest';
import type { TemplateDraftInput } from '../../src/core/api/contract';
import { WRITER_SYSTEM, writeTemplate } from '../../src/core/smart-layer/template-writer/writer';
import { storeProfile } from '../../src/core/smart-layer/tools/templates.tools';

// Live: the Ramadan template ideas suggested sweets for a jewellery store. Chat stores no business category, so the writer is told the store's name and the service menu
// the merchant wrote, and told to fit its ideas to what the store sells.
const good: TemplateDraftInput = {
  name: 'ramadan_gift', label: 'هدية رمضان', language: 'ar', category: 'MARKETING', header: null,
  body: { text: 'رمضان كريم يا {{1}}، هدايا الدهب والفضة وصلت.', examples: ['أحمد'] }, footer: null, buttons: [],
};
const deps = (users: string[]) => ({
  complete: async (_s: string, u: string) => { users.push(u); return JSON.stringify(good); },
  check: async () => ({ issues: [], payloadHash: 'h' }),
  taken: () => new Set<string>(),
});

describe('template writer: store profile', () => {
  it('the profile (store name + menu) is in the prompt the model gets, fenced as data, and the system text tells it to fit the store', async () => {
    const users: string[] = [];
    await writeTemplate(deps(users), 'رسالة رمضان', undefined, 'Name: مجوهرات النور\nService menu: خواتم، دبل، سلاسل');
    expect(users[0]).toContain('Store profile');
    expect(users[0]).toContain('مجوهرات النور');
    expect(users[0]).toContain('خواتم');
    expect(WRITER_SYSTEM).toMatch(/jewellery store gets gifts and jewellery, never sweets/);
  });

  it('with no profile the prompt carries no profile block (generic)', async () => {
    const users: string[] = [];
    await writeTemplate(deps(users), 'رسالة رمضان');
    expect(users[0]).not.toContain('Store profile');
  });

  it('storeProfile: name from /me for THIS store, menu titles from the settings; a failed read gives a smaller profile, never a throw', async () => {
    const api = { ask: async () => null, get: async (p: string) => p === '/me' ? { stores: [{ id: 'other', name: 'متجر تاني' }, { id: 's1', name: 'مجوهرات النور' }] } : { menu: { items: [{ title: { ar: 'خواتم', en: 'Rings' } }, { title: { ar: '', en: 'Chains' } }] } } };
    expect(await storeProfile(api as never, 's1')).toBe('Name: مجوهرات النور\nService menu: خواتم، Chains');
    const half = { ask: async () => null, get: async (p: string) => { if (p === '/me') throw new Error('down'); return { menu: { items: [] } }; } };
    expect(await storeProfile(half as never, 's1')).toBe('');
  });
});
