import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureAssistant } from '../../src/routes/assistant';
import { apiFor, storeId, useApiKey } from '../helpers/api';
import { rows, seedNumber, workspace } from '../helpers/workspace';

useApiKey();

type Script = Array<{ text?: string; call?: { name: string; args: unknown } }>;
function scriptedAi(script: Script) {
  let i = 0;
  return {
    run: async (_m: string, inputs: Record<string, unknown>) => {
      const system = (((inputs.messages as Array<{ content?: string }>)[0]?.content) ?? '') as string;
      if (system.includes('Classify the merchant message')) return { choices: [{ message: { content: '{"inScope":true,"abuse":false,"injection":false}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      const s = script[Math.min(i++, script.length - 1)]!;
      return { choices: [{ message: { content: s.text ?? null, ...(s.call ? { tool_calls: [{ id: `c${i}`, type: 'function', function: { name: s.call.name, arguments: JSON.stringify(s.call.args) } }] } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
}
const noHelp = { db: env.DB, embed: undefined, vectors: undefined } as never;

beforeEach(async () => { await env.DB.prepare("INSERT INTO platform_flags (key, value, updated_at) VALUES ('sl.global', '{\"mode\":\"act\"}', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(); });
afterEach(() => { configureAssistant({}); });

const base = (s: string, p: string) => `https://x/api/v1/stores/${s}/assistant${p}`;
const post = (s: string, token: string, path: string, body?: unknown) => SELF.fetch(base(s, path), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body ?? {}) });
type Card = { previewId: string; policy: 'preview' | 'confirm'; reasons: string[]; rows: Array<{ before?: unknown; after?: unknown }>; undo: string; approvalId?: string };
type TurnOut = { status: string; previews: Card[] };

/** One workspace in `act` mode with customers; `ask` runs one scripted turn that calls a tool and returns the cards. */
async function setup(n: number, role: 'owner' | 'staff' = 'owner', names: string[] = ['منى السيد']) {
  const s = storeId(n);
  const api = await apiFor(s, role);
  await seedNumber(`pn-${s}`, s);
  const ws = workspace(s);
  await ws.setAssistantMode('act');
  let k = 0;
  for (const name of names) await ws.ingest({ phoneNumberId: `pn-${s}`, inbound: [{ wamid: `wamid.${s}.${k}`, from: `2010123456${String(k++).padStart(2, '0')}`, ts: Math.floor(Date.now() / 1000), type: 'text', text: 'hi', profileName: name }], statuses: [], receivedAt: 1 });
  const ask = async (text: string, call: { name: string; args: unknown }): Promise<TurnOut> => {
    configureAssistant({ ai: scriptedAi([{ call }, { text: 'المعاينة جاهزة.' }]) as never, help: noHelp });
    const res = await post(s, api.token, '/turn', { conversationId: crypto.randomUUID(), text, locale: 'ar' });
    expect(res.status).toBe(200);
    return (await res.json()) as TurnOut;
  };
  const get = async (path: string) => (await (await api.call('GET', path)).json()) as never;
  return { s, api, ws, ask, get, apply: (id: string) => post(s, api.token, `/previews/${id}/apply`), undo: (id: string) => post(s, api.token, `/applied/${id}/undo`) };
}
const tagsOf = async (get: (p: string) => Promise<{ items: Array<{ id: number; tags: string[] }> }>) => (await get('/conversations')).items[0]!.tags;

describe('wave 1 preview tools: preview, apply, undo through the merchant\'s own routes', () => {
  it('conversation_tag_set: the turn changes nothing; Apply sets the tags; Undo puts the old ones back', async () => {
    const t = await setup(7301);
    const out = await t.ask('عايز اعمل تاج vip للعميل منى السيد', { name: 'conversation_tag_set', args: { customer: 'منى السيد', tags: ['vip'] } });
    expect(out.previews).toHaveLength(1);
    expect(out.previews[0]).toMatchObject({ policy: 'preview', undo: 'reversible' });
    expect(await tagsOf(t.get)).toEqual([]);
    const applied = (await (await t.apply(out.previews[0]!.previewId)).json()) as { status: string; appliedId: string };
    expect(applied.status).toBe('applied');
    expect(await tagsOf(t.get)).toEqual(['vip']);
    expect(((await (await t.undo(applied.appliedId)).json()) as { status: string }).status).toBe('undone');
    expect(await tagsOf(t.get)).toEqual([]);
  });

  it('a double press applies once', async () => {
    const t = await setup(7302);
    const out = await t.ask('عايز اعمل تاج vip للعميل منى السيد', { name: 'conversation_tag_set', args: { customer: 'منى السيد', tags: ['vip'] } });
    const id = out.previews[0]!.previewId;
    const [a, b] = await Promise.all([t.apply(id), t.apply(id)]);
    const statuses = [a, b].map((r) => r.status);
    expect(statuses.filter((x) => x === 200)).toHaveLength(1);
    expect(await tagsOf(t.get)).toEqual(['vip']);
  });

  it('the item changed by hand after the preview: Apply re-previews and writes nothing; Undo after a hand edit shows a stale card and writes nothing', async () => {
    const t = await setup(7303);
    const out = await t.ask('عايز اعمل تاج vip للعميل منى السيد', { name: 'conversation_tag_set', args: { customer: 'منى السيد', tags: ['vip'] } });
    const conv = (await t.get('/conversations') as { items: Array<{ id: number }> }).items[0]!.id;
    await t.api.call('PUT', `/conversations/${conv}/tags`, { tags: ['hand'] });
    const stale = (await (await t.apply(out.previews[0]!.previewId)).json()) as { status: string; card?: Card };
    expect(stale.status).toBe('stale');
    expect(await tagsOf(t.get)).toEqual(['hand']);
    // a fresh preview applied, then edited by hand: undo must not wipe the newer edit
    const again = await t.ask('عايز اعمل تاج vip للعميل منى السيد', { name: 'conversation_tag_set', args: { customer: 'منى السيد', tags: ['vip'] } });
    const applied = (await (await t.apply(again.previews[0]!.previewId)).json()) as { appliedId: string };
    await t.api.call('PUT', `/conversations/${conv}/tags`, { tags: ['hand2'] });
    const undo = (await (await t.undo(applied.appliedId)).json()) as { status: string };
    expect(undo.status).toBe('stale');
    expect(await tagsOf(t.get)).toEqual(['hand2']);
  });

  it('two customers with the same name: no preview is built and nothing is guessed', async () => {
    const t = await setup(7304, 'owner', ['منى السيد', 'منى السيد']);
    const out = await t.ask('عايز اعمل تاج vip للعميل منى السيد', { name: 'conversation_tag_set', args: { customer: 'منى السيد', tags: ['vip'] } });
    expect(out.previews).toEqual([]);
    expect(await rows(t.s, 'SELECT count(*) AS n FROM sl_previews')).toEqual([{ n: 0 }]);
  });

  it('an invented customer finds nothing', async () => {
    const t = await setup(7305);
    const out = await t.ask('عايز اعمل تاج vip للعميل منى السيد', { name: 'conversation_tag_set', args: { customer: 'واحد مش موجود', tags: ['vip'] } });
    expect(out.previews).toEqual([]);
  });

  it('suggest mode builds the card but Apply is refused: only act mode applies', async () => {
    const t = await setup(7306);
    await t.ws.setAssistantMode('suggest');
    const out = await t.ask('عايز اعمل تاج vip للعميل منى السيد', { name: 'conversation_tag_set', args: { customer: 'منى السيد', tags: ['vip'] } });
    expect(out.previews).toHaveLength(1);
    const res = (await (await t.apply(out.previews[0]!.previewId)).json()) as { status: string };
    expect(res.status).toBe('mode');
    expect(await tagsOf(t.get)).toEqual([]);
  });

  it('contact_rename and contact_tags_set: the draft never carries the phone number', async () => {
    const t = await setup(7307);
    const out = await t.ask('الاسم غلط عايز اغير اسم العميل منى السيد', { name: 'contact_rename', args: { customer: 'منى السيد', name: 'منى أحمد' } });
    expect(out.previews).toHaveLength(1);
    const stored = await rows(t.s, 'SELECT json FROM sl_previews');
    expect(JSON.stringify(stored)).not.toMatch(/2010123456/);
    const id = out.previews[0]!.previewId;
    expect(((await (await t.apply(id)).json()) as { status: string }).status).toBe('applied');
    expect(((await t.get('/contacts')) as { items: Array<{ name: string }> }).items[0]!.name).toBe('منى أحمد');
  });

  it('a note cannot be deleted, so it is a confirm card and Apply alone writes nothing', async () => {
    const t = await setup(7308);
    const out = await t.ask('ضيف ملاحظة على محادثة العميل منى السيد', { name: 'conversation_note_add', args: { customer: 'منى السيد', text: 'بتحب الشحن السريع' } });
    expect(out.previews[0]).toMatchObject({ policy: 'confirm' });
    expect(out.previews[0]!.reasons).toContain('irreversible');
    const res = (await (await t.apply(out.previews[0]!.previewId)).json()) as { status: string };
    expect(res.status).toBe('needs_confirm');
    const conv = (await t.get('/conversations') as { items: Array<{ id: number }> }).items[0]!.id;
    expect(((await t.get(`/conversations/${conv}/notes`)) as { items: unknown[] }).items).toEqual([]);
  });

  it('a route refusal (staff on an owner-only switch) is a 403 and nothing changes', async () => {
    const t = await setup(7309, 'staff');
    const out = await t.ask('عايز اوقف البوت', { name: 'bot_ordering_toggle', args: { enabled: false } });
    expect(out.previews).toHaveLength(1);
    const res = await t.apply(out.previews[0]!.previewId);
    expect(res.status).toBe(403);
    expect(((await t.get('/store-link/settings')) as { orderingBot: boolean }).orderingBot).toBe(true);
  });

  it('bot_ordering_toggle round trip, and turning on order confirmations (messages customers) is confirm class', async () => {
    const t = await setup(7310);
    const out = await t.ask('عايز اوقف البوت', { name: 'bot_ordering_toggle', args: { enabled: false } });
    const applied = (await (await t.apply(out.previews[0]!.previewId)).json()) as { appliedId: string };
    expect(((await t.get('/store-link/settings')) as { orderingBot: boolean }).orderingBot).toBe(false);
    await t.undo(applied.appliedId);
    expect(((await t.get('/store-link/settings')) as { orderingBot: boolean }).orderingBot).toBe(true);
    await t.api.call('PATCH', '/store-link/settings', { orderConfirmations: false });
    const c = await t.ask('عايز اشغل رسايل تأكيد الطلب للعميل', { name: 'bot_order_confirmations_toggle', args: { enabled: true } });
    expect(c.previews[0]).toMatchObject({ policy: 'confirm' });
    expect(c.previews[0]!.reasons).toContain('customer_message');
  });

  it('digest and persona round trips; segment create shows the audience', async () => {
    const t = await setup(7311);
    const d = await t.ask('عايز اوقف الملخص الأسبوعي', { name: 'digest_settings_set', args: { enabled: false } });
    expect(d.previews).toHaveLength(1);
    expect(((await (await t.apply(d.previews[0]!.previewId)).json()) as { status: string }).status).toBe('applied');
    expect(((await t.get('/digest')) as { enabled: boolean }).enabled).toBe(false);
    const g = await t.ask('الموظف الذكي يتكلم عربي', { name: 'agent_persona_set', args: { language: 'en' } });
    expect(g.previews).toHaveLength(1);
    const sg = await t.ask('اعمل شريحة العملاء الـ vip', { name: 'segment_upsert', args: { name: 'VIP', criteria: { tags: { any: ['vip'] } } } });
    expect(sg.previews[0]!.rows.some((r) => r.after === '0')).toBe(true);
  });
});
