import { SELF, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { apiFor, storeId, useApiKey } from './helpers/api';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { listReply, rawMessagePayload } from './helpers/payload';
import { WA_1, storeWorkspace, useStoreLink } from './helpers/store-link';
import { rows, workspace } from './helpers/workspace';

useStoreLink();
useApiKey();
const W = (n: number) => `00000000-0000-4000-8000-0000000063${String(n).padStart(2, '0')}`;
let seq = 0;
const wamid = () => `wamid.loc.${++seq}.${Date.now()}`;
const LOCATION = { name: 'متجر الورد', address: '١٢ شارع التحرير، الدقي، الجيزة', latitude: 30.0381, longitude: 31.2122 };
const MENU = { enabled: true, items: [{ id: 'hours', title: { ar: 'مواعيد الشغل', en: 'Opening hours' }, answer: { ar: 'كل يوم', en: 'Every day' } }] };

type Sent = { kind: string; body: Record<string, any> };
const sentOf = (g: ReturnType<typeof stubGraph>, pn: string, from = 0): Sent[] => g.calls.filter((c) => c.method === 'POST' && c.url.endsWith(`/${pn}/messages`)).slice(from).map((c) => {
  const b = c.body as Record<string, any>;
  return { kind: b.type === 'interactive' ? (b.interactive.type === 'list' ? 'list' : 'buttons') : b.type, body: b };
});
async function say(ws: string, pn: string, message: Record<string, unknown>, g: ReturnType<typeof stubGraph>) {
  const from = sentOf(g, pn).length;
  expect((await postWebhook(SELF, rawMessagePayload(pn, message))).status).toBe(200);
  await workspace(ws).runDueTasks();
  return sentOf(g, pn, from);
}
const text = (t: string) => ({ id: wamid(), from: WA_1, type: 'text', text: { body: t } });
const tap = (id: string) => listReply(wamid(), id, 'x');
async function setup(n: number, settings: Record<string, unknown>) {
  const ws = W(n);
  const pn = await storeWorkspace(ws);
  await runInDurableObject(workspace(ws), (i) => { (i as unknown as { botSendGapMs: number }).botSendGapMs = 0; });
  expect((await workspace(ws).setStoreLinkSettings(settings as never)).ok).toBe(true);
  return { ws, pn };
}
const MAPS = `https://maps.google.com/?q=${LOCATION.latitude},${LOCATION.longitude}`;

describe('store location', () => {
  it('sends a WhatsApp location message and then ONE text with the Google Maps link', async () => {
    const { ws, pn } = await setup(1, { location: LOCATION });
    const g = stubGraph();
    const out = await say(ws, pn, text('العنوان'), g);
    expect(out.map((s) => s.kind)).toEqual(['location', 'text']);
    expect(out[0]!.body.location).toEqual({ latitude: LOCATION.latitude, longitude: LOCATION.longitude, name: LOCATION.name, address: LOCATION.address });
    expect(out[0]!.body.to).toBe(WA_1);
    expect(out[1]!.body.text.body).toBe(MAPS);
    // the inbox shows both
    expect(await rows(ws, "SELECT type FROM messages WHERE direction = 'out' ORDER BY id")).toEqual([{ type: 'location' }, { type: 'text' }]);
  });

  it('every location word triggers it, in Arabic and English', async () => {
    const { ws, pn } = await setup(2, { location: LOCATION });
    const g = stubGraph();
    for (const w of ['location', 'Address', 'فين', 'مكانكم', 'العنوان']) expect((await say(ws, pn, text(w), g)).map((s) => s.kind), w).toEqual(['location', 'text']);
  });

  it('the menu has an "Our location" row only when a location is set, and tapping it sends the location', async () => {
    const { ws, pn } = await setup(3, { menu: MENU, location: LOCATION });
    const g = stubGraph();
    const list = (await say(ws, pn, text('مرحبا'), g))[0]!;
    const ids = (list.body.interactive.action.sections[0].rows as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(['menu:ar:order', 'menu:ar:faq:hours', 'menu:ar:loc', 'menu:ar:human']);
    expect((await say(ws, pn, tap('menu:ar:loc'), g)).map((s) => s.kind)).toEqual(['location', 'text']);
    const other = await setup(4, { menu: MENU });
    const g2 = stubGraph();
    const ids2 = ((await say(other.ws, other.pn, text('مرحبا'), g2))[0]!.body.interactive.action.sections[0].rows as { id: string }[]).map((r) => r.id);
    expect(ids2).not.toContain('menu:ar:loc');
  });

  it('a location with the menu switched off still answers the words, and the greeting stays the normal flow', async () => {
    const { ws, pn } = await setup(5, { location: LOCATION });
    const g = stubGraph();
    expect((await say(ws, pn, text('مرحبا'), g)).map((s) => s.kind)).toEqual(['text', ...Array(9).fill('image'), 'list']);
    expect((await say(ws, pn, text('فين'), g)).map((s) => s.kind)).toEqual(['location', 'text']);
  });

  it('unset: the words go to the normal flow', async () => {
    const { ws, pn } = await setup(6, {});
    const g = stubGraph();
    const out = await say(ws, pn, text('العنوان'), g);
    expect(out.map((s) => s.kind)).toEqual(['text', ...Array(9).fill('image'), 'list']);
  });

  it('while the bot waits for a typed address the words are the address, not a question', async () => {
    const { ws, pn } = await setup(7, { location: LOCATION });
    const g = stubGraph();
    await say(ws, pn, text('مرحبا'), g);
    await runInDurableObject(workspace(ws), (_i, state) => { state.storage.sql.exec("UPDATE bot_sessions SET state = 'awaiting_address', updated_at = ?", Date.now()); });
    const out = await say(ws, pn, text('فين'), g);
    expect(out.some((s) => s.kind === 'location')).toBe(false);
  });
});

describe('store location settings route', () => {
  it('saves for the owner, clears with null, refuses staff and bad coordinates or lengths', async () => {
    const id = storeId(6301);
    const owner = await apiFor(id);
    const staff = await apiFor(id, 'staff');
    const patch = (location: unknown, who = owner) => who.call('PATCH', '/store-link/settings', { location }).then((r) => r.status);
    expect(await patch(LOCATION)).toBe(200);
    expect((await (await owner.call('GET', '/store-link/settings')).json() as any).location).toEqual(LOCATION);
    expect(await patch(LOCATION, staff)).toBe(403);
    expect(await patch({ ...LOCATION, latitude: 90.5 })).toBe(400);
    expect(await patch({ ...LOCATION, latitude: -90.1 })).toBe(400);
    expect(await patch({ ...LOCATION, longitude: 180.1 })).toBe(400);
    expect(await patch({ ...LOCATION, longitude: Number.NaN })).toBe(400);
    expect(await patch({ ...LOCATION, name: 'ا'.repeat(101) })).toBe(400);
    expect(await patch({ ...LOCATION, address: 'ا'.repeat(301) })).toBe(400);
    expect(await patch({ ...LOCATION, name: '' })).toBe(400);
    expect(await patch(null)).toBe(200);
    expect((await (await owner.call('GET', '/store-link/settings')).json() as any).location).toBeNull();
  });
});
