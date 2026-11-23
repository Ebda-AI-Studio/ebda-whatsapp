import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EBDA_AGENT_COPY } from '../src/addons/ebda/agent-copy';
import { extractEvents } from '../src/core/meta/webhook-schema';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text, wamid } from './helpers/agent-chat';
import { stubGraph } from './helpers/graph';
import { listReply, buttonReply } from './helpers/payload';
import { WA_1, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

// Audit row 25: an inbound WhatsApp location pin. In the address step it IS the delivery address; anywhere else the agent asks what the customer needs.
const link = useStoreLink();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000089${String(n).padStart(2, '0')}`;
const LAT = 30.04442;
const LNG = 31.23571;
const pin = (loc: Record<string, unknown> = { latitude: LAT, longitude: LNG }) => ({ id: wamid(), from: WA_1, type: 'location', location: loc });
const tapList = (id: string) => listReply(wamid(), id, 'x');
const tapBtn = (id: string) => buttonReply('', wamid(), id, 'x');
const session = async (ws: string) => JSON.parse((await rows<{ data: string }>(ws, 'SELECT data FROM bot_sessions'))[0]!.data) as { pin: { latitude: number; longitude: number } | null };

/** The agent on AND the ordering flow open, the customer standing at "send me your address". */
async function toAddressStep(ws: string, g: ReturnType<typeof stubGraph>) {
  const pn = await agentWorkspace(ws);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  await say(ws, pn, text('طلب جديد'), g);
  await say(ws, pn, tapList('v:v2'), g);
  await say(ws, pn, tapBtn('q:2'), g);
  await say(ws, pn, tapBtn('cart:checkout'), g);
  const asked = await say(ws, pn, tapBtn('pay:cod'), g);
  expect(asked.at(-1)!.text ?? '').toContain('عنوان التوصيل');
  return pn;
}

afterEach(() => vi.restoreAllMocks());

describe('a location pin in the address step', () => {
  it('with a name and address: the order is placed to that text, coordinates stay Chat-side and the pin is shown back', async () => {
    const ws = W(1);
    const g = stubGraph();
    const pn = await toAddressStep(ws, g);
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info'), vi.spyOn(console, 'error')];
    const out = await say(ws, pn, pin({ latitude: LAT, longitude: LNG, name: 'مكتب المعادي', address: 'شارع 9، المعادي' }), g);
    expect(out[0]!.text).toContain('مكتب المعادي');
    expect(link.fake.lastCall('saveCustomerAddress')[2]).toEqual({ label: 'مكتب المعادي', area: 'مكتب المعادي', street: 'شارع 9، المعادي' });
    expect(link.fake.count('createOrderFromChat')).toBe(1);
    const everything = JSON.stringify([link.fake.calls, g.calls, logs.map((l) => l.mock.calls)]);
    expect(everything).not.toContain('30.0444');
    expect(everything).not.toContain('31.2357');
    expect((await session(ws)).pin).toBeNull(); // dropped with the order
  });

  it('with only an address text: it is split like a typed address', async () => {
    const ws = W(2);
    const g = stubGraph();
    const pn = await toAddressStep(ws, g);
    await say(ws, pn, pin({ latitude: LAT, longitude: LNG, address: 'الدقي، شارع التحرير' }), g);
    expect(link.fake.lastCall('saveCustomerAddress')[2]).toEqual({ area: 'الدقي', street: 'شارع التحرير' });
    expect(link.fake.count('createOrderFromChat')).toBe(1);
  });

  it('a bare pin keeps the coordinates in the session, asks for one line of text, and the typed address completes the order', async () => {
    const ws = W(3);
    const g = stubGraph();
    const pn = await toAddressStep(ws, g);
    const out = await say(ws, pn, pin(), g);
    expect(out[0]!.text).toContain('اكتبلي كمان سطر');
    expect(link.fake.count('createOrderFromChat')).toBe(0);
    expect(await session(ws)).toMatchObject({ pin: { latitude: LAT, longitude: LNG } });
    await say(ws, pn, text('المعادي، شارع 9 عمارة 4'), g);
    expect(link.fake.count('createOrderFromChat')).toBe(1);
    expect(JSON.stringify(link.fake.calls)).not.toContain('30.0444');
    expect((await session(ws)).pin).toBeNull();
  });

  it('erasing the customer removes the stored coordinates everywhere (no table keeps them)', async () => {
    const ws = W(4);
    const g = stubGraph();
    const pn = await toAddressStep(ws, g);
    await say(ws, pn, pin(), g);
    expect(JSON.stringify(await rows(ws, 'SELECT data FROM bot_sessions'))).toContain('30.04442');
    await workspace(ws).eraseContact(WA_1);
    const dump = await runInDurableObject(workspace(ws), (_i, state) => {
      const sql = state.storage.sql;
      const names = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray().map((r) => r.name);
      return JSON.stringify(names.map((n) => sql.exec(`SELECT * FROM "${n}"`).toArray()));
    });
    expect(dump).not.toContain('30.04442');
    expect(dump).not.toContain('31.23571');
  });
});

describe('a location pin anywhere else', () => {
  it('the agent asks what the customer needs and offers an order, without calling the model or holding a credit', async () => {
    const ws = W(5);
    const pn = await agentWorkspace(ws);
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
    const m = (agent.model = new ScriptedProvider([])) as ScriptedProvider;
    const out = await say(ws, pn, pin({ latitude: LAT, longitude: LNG, name: 'البيت' }), stubGraph());
    expect(out.map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.locationNote.ar]);
    expect(out[0]!.text).toContain('عايز توصلك لحاجة');
    expect(m.callCount).toBe(0);
    expect(await rows(ws, "SELECT outcome FROM agent_turns WHERE outcome = 'location'")).toHaveLength(1);
    expect(link.fake.count('createOrderFromChat')).toBe(0);
  });

  it('a pin the customer sends before the address question (cart step) is not taken as an address', async () => {
    const ws = W(6);
    const g = stubGraph();
    const pn = await agentWorkspace(ws);
    await say(ws, pn, text('طلب جديد'), g);
    await say(ws, pn, tapList('v:v2'), g);
    const out = await say(ws, pn, pin({ latitude: LAT, longitude: LNG, name: 'x' }), g);
    expect(out.map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.locationNote.ar]);
    expect(link.fake.count('saveCustomerAddress')).toBe(0);
  });

  it('a stale address step (older than 30 minutes) is not an open order any more', async () => {
    const ws = W(7);
    const g = stubGraph();
    const pn = await toAddressStep(ws, g);
    await exec(ws, 'UPDATE bot_sessions SET updated_at = updated_at - ?', 31 * 60_000);
    const out = await say(ws, pn, pin({ latitude: LAT, longitude: LNG, name: 'x' }), g);
    expect(out.map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.locationNote.ar]);
    expect(link.fake.count('createOrderFromChat')).toBe(0);
  });
});

describe('the webhook parse', () => {
  const payload = (location: unknown) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'p' }, messages: [{ from: '1', id: 'w1', timestamp: '1', type: 'location', location }] } }] }] });
  it('keeps the label in the inbox text and never the coordinates; invalid coordinates drop the pin', () => {
    const ok = extractEvents(payload({ latitude: LAT, longitude: LNG, name: 'مكتب', address: 'شارع 9' }))![0]!.inbound[0]!;
    expect(ok.location).toEqual({ latitude: LAT, longitude: LNG, name: 'مكتب', address: 'شارع 9' });
    expect(ok.text).toBe('📍 مكتب');
    expect(JSON.stringify(ok.text)).not.toContain('30.04');
    const bad = extractEvents(payload({ latitude: 95, longitude: LNG }))![0]!.inbound[0]!;
    expect(bad.location).toBeUndefined();
  });
});
