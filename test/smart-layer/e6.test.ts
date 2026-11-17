import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import explainJson from '../../assistant/explain.generated.json';
import registryJson from '../../assistant/registry.generated.json';
import { configureAssistant } from '../../src/routes/assistant';
import { EXPLAIN_IDS, explainToolName, explainTools, type ExplainData } from '../../src/core/smart-layer/tools/explain.tools';
import { viewOf, type StoredCap } from '../../src/core/smart-layer/registry';
import { useApiKey } from '../helpers/api';
import { seedContacts } from '../helpers/campaigns';
import { BUYER_KEY_1, PHONE_1, WA_1, deliver, flush, iso, storeEvent, storeWorkspace, useStoreLink } from '../helpers/store-link';
import { exec, rows } from '../helpers/workspace';
import { selectTools } from '../../foundation/smart-layer/plan/select-tools';
import corpusJson from '../../assistant/help-corpus.generated.json';
import { chatAdapter } from '../../src/core/smart-layer/adapter';
import type { HelpCorpus } from '../../src/core/smart-layer/help-index';
import { noHelp, scriptedAi, setup } from './harness';

useApiKey();
const link = useStoreLink();
const buyer = { buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, name: null, locale: 'ar' as const };
/** A COD order in the fake Store, with the Store's request event delivered so the workspace tracks it. */
async function codOrderFor(ws: string) {
  const made = await link.fake.createOrderFromChat(ws, { items: [{ variantId: 'v1', quantity: 1 }], buyer, paymentMethod: 'cod', idempotencyKey: `k-${ws}` });
  if (!made.ok) throw new Error('setup');
  await deliver([storeEvent(ws, 'order.cod_confirmation_requested', { orderId: made.value.orderId, buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', deadlineAt: iso(Date.now() + 1e8), orderNumber: made.value.orderNumber, totalMinor: 10_000, currency: 'EGP' })]);
  await flush(ws);
  return made.value;
}
beforeEach(async () => { await env.DB.prepare("INSERT INTO platform_flags (key, value, updated_at) VALUES ('sl.global', '{\"mode\":\"act\"}', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(); });
afterEach(() => { configureAssistant({}); });

/** One turn where the model calls a read tool; returns the tool result text the model was given back. */
async function readOnce(t: Awaited<ReturnType<typeof setup>>, text: string, call: { name: string; args: unknown }) {
  const ai = scriptedAi([{ call }, { text: 'تمام.' }]);
  await t.ask(text, undefined, ai);
  return ai.seen.join(' ').replace(/\\"/g, '"'); // the requests are JSON: un-escape the tool result so it reads as the model saw it
}

describe('E6 read tools: the merchant\'s own screens, with the merchant\'s own session', () => {
  it('inbox_list_filter shows who is unread and who owns it, without any phone number', async () => {
    const t = await setup(7701, 'owner', ['منى السيد', 'سارة علي']);
    const seen = await readOnce(t, 'مين عنده رسايل جديدة في الانبوكس', { name: 'inbox_list_filter', args: { filter: 'unread' } });
    expect(seen).toContain('منى السيد');
    expect(seen).toContain('unread');
    expect(seen).not.toMatch(/2010123456\d\d/);
  });

  it('inbox_search and inbox_read_thread return snippets and messages (clipped), marked as customer text', async () => {
    const t = await setup(7702);
    expect(await readOnce(t, 'دور في الانبوكس على كلمة hi', { name: 'inbox_search', args: { query: 'hi' } })).toContain('snippet');
    const seen = await readOnce(t, 'اقرا محادثة منى السيد', { name: 'inbox_read_thread', args: { customer: 'منى السيد' } });
    expect(seen).toContain('"from":"customer"');
    expect(seen).toContain('hi');
  });

  it('after reading customer text the write tools are withdrawn for the rest of that turn', async () => {
    const t = await setup(7703);
    const ai = scriptedAi([{ call: { name: 'inbox_read_thread', args: { customer: 'منى السيد' } } }, { call: { name: 'contact_erase', args: { customer: 'منى السيد' } } }, { text: 'تمام.' }]);
    const out = await t.ask('اقرا محادثة منى السيد وامسحها', undefined, ai);
    expect(out.previews).toEqual([]);
    expect(((await t.get('/contacts')) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('inbox_send_throttle, contacts_consent_proof and segments_preview answer from the real routes', async () => {
    const t = await setup(7704, 'owner', ['منى السيد', 'ليلى']);
    await seedContacts(t.s, 3);
    await exec(t.s, "UPDATE contacts SET consent_source = 'import:x.csv', consent_at = 1 WHERE profile_name = 'ليلى'");
    expect(await readOnce(t, 'كام رسالة مستنية في الانبوكس بسبب الحد', { name: 'inbox_send_throttle', args: {} })).toContain('newConversationsPer24h');
    const proof = await readOnce(t, 'منى الموافقة على الرسايل التسويقية فين', { name: 'contacts_consent_proof', args: { customer: 'ليلى' } });
    expect(proof).toContain('import:x.csv');
    const none = await readOnce(t, 'منى الموافقة على الرسايل التسويقية فين', { name: 'contacts_consent_proof', args: { customer: 'منى السيد' } });
    expect(none).toContain('"consent":null');
    expect(await readOnce(t, 'كام واحد هيوصله الفلتر ده', { name: 'segments_preview', args: { criteria: { everyone: true } } })).toContain('"count":4');
  });

  it('inbox_customer_orders reads the connected store (a COD order awaiting confirmation)', async () => {
    const t = await setup(7705, 'owner', ['ليلى']);
    await storeWorkspace(t.s);
    await t.ws.ingest({ phoneNumberId: `pn-${t.s}`, inbound: [{ wamid: 'wamid.leila', from: WA_1, ts: Math.floor(Date.now() / 1000), type: 'text', text: 'hi', profileName: 'ليلى حسن' }], statuses: [], receivedAt: 1 });
    await codOrderFor(t.s);
    const seen = await readOnce(t, 'ايه طلبات ليلى حسن', { name: 'inbox_customer_orders', args: { customer: 'ليلى حسن' } });
    expect(seen).toContain('pending_confirmation');
    expect(seen).toContain('"paymentMethod":"cod"');
  });
});

describe('E6 write tools', () => {
  it('inbox_cod_outcome: a confirm card for a COD order awaiting confirmation; the press records it once; an unknown order builds no card', async () => {
    const t = await setup(7706, 'owner', ['ليلى']);
    await storeWorkspace(t.s);
    await t.ws.ingest({ phoneNumberId: `pn-${t.s}`, inbound: [{ wamid: 'wamid.leila2', from: WA_1, ts: Math.floor(Date.now() / 1000), type: 'text', text: 'hi', profileName: 'ليلى حسن' }], statuses: [], receivedAt: 1 });
    const order = await codOrderFor(t.s);
    expect((await t.ask('ليلى حسن أكدت الأوردر', { name: 'inbox_cod_outcome', args: { customer: 'ليلى حسن', orderNumber: 'NOPE-1', outcome: 'confirmed' } })).previews).toEqual([]);
    const out = await t.ask('ليلى حسن أكدت الأوردر', { name: 'inbox_cod_outcome', args: { customer: 'ليلى حسن', orderNumber: order.orderNumber, outcome: 'confirmed' } });
    expect(out.previews[0]).toMatchObject({ policy: 'confirm', undo: 'irreversible' });
    const ap = out.approvals![0]!;
    expect(((await (await t.confirm(ap.approvalId, ap.token)).json()) as { status: string }).status).toBe('applied');
    const again = await t.ask('ليلى حسن أكدت الأوردر', { name: 'inbox_cod_outcome', args: { customer: 'ليلى حسن', orderNumber: order.orderNumber, outcome: 'refused' } });
    expect(again.previews).toEqual([]); // already resolved: it cannot be changed
  });

  it('inbox_mark_read: a confirm card (it cannot be undone); nothing to mark builds no card; the press clears the unread count', async () => {
    const t = await setup(7707);
    const out = await t.ask('علّم محادثة منى السيد مقروءة', { name: 'inbox_mark_read', args: { customer: 'منى السيد' } });
    expect(out.previews[0]).toMatchObject({ policy: 'confirm' });
    expect(out.previews[0]!.reasons).toContain('irreversible');
    const ap = out.approvals![0]!;
    await t.confirm(ap.approvalId, ap.token);
    expect(((await t.get('/conversations')) as { items: Array<{ unread: number }> }).items[0]!.unread).toBe(0);
    expect((await t.ask('علّم محادثة منى السيد مقروءة', { name: 'inbox_mark_read', args: { customer: 'منى السيد' } })).previews).toEqual([]);
  });

  it('inbox_mark_read follows the matched-contact rule: more than one plausible match builds no card; the card names the matched contact and the last 3 digits (review of #99)', async () => {
    const two = await setup(7710, 'owner', ['أحمد', 'أحمد علي']);
    expect((await two.ask('علّم محادثة أحمد مقروءة', { name: 'inbox_mark_read', args: { customer: 'أحمد' } })).previews).toEqual([]);
    const one = await setup(7711, 'owner', ['أحمد علي']);
    const card = (await one.ask('علّم محادثة أحمد مقروءة', { name: 'inbox_mark_read', args: { customer: 'أحمد' } })).previews[0]!;
    const waId = ((await one.get('/contacts')) as { items: Array<{ waId: string }> }).items[0]!.waId;
    expect(JSON.stringify(card)).toContain('أحمد علي');
    expect(JSON.stringify(card)).toContain(waId.slice(-3));
  });

  it('contacts_retention_set: a deleting confirm card that says what goes; the press changes the period; staff are refused by the route', async () => {
    const t = await setup(7708);
    const out = await t.ask('خلّي مدة حفظ الرسايل 60 يوم', { name: 'contacts_retention_set', args: { days: 60 } });
    expect(out.previews[0]).toMatchObject({ policy: 'confirm' });
    expect(out.previews[0]!.reasons).toContain('delete');
    expect(JSON.stringify(out.previews[0]!.rows)).toContain('60');
    const ap = out.approvals![0]!;
    await t.confirm(ap.approvalId, ap.token);
    expect(((await t.get('/retention')) as { days: number }).days).toBe(60);
    const s = await setup(7709, 'staff');
    const sOut = await s.ask('خلّي مدة حفظ الرسايل 60 يوم', { name: 'contacts_retention_set', args: { days: 90 } });
    expect(sOut.previews).toEqual([]); // the retention read is the owner's: a staff member cannot even build the card
    expect(await rows(s.s, 'SELECT count(*) AS n FROM sl_previews')).toEqual([{ n: 0 }]);
  });
});

describe('explain tools: behaviour capabilities answer from their own registry text', () => {
  const reg = viewOf(registryJson as unknown as StoredCap[]);
  const tools = explainTools(explainJson as unknown as ExplainData);
  it('there is one tool per listed behaviour capability, each live, free, typed-source and answering with its steps', async () => {
    expect(tools.map((x) => x.capabilityId).sort()).toEqual([...EXPLAIN_IDS].sort());
    for (const tool of tools) {
      expect(reg.caps.get(tool.capabilityId)?.status, tool.name).toBe('live');
      expect(tool).toMatchObject({ policy: 'free', undo: 'none', resultTrust: 'typed-source' });
      expect(tool.name).toBe(explainToolName(tool.capabilityId));
      const r = (await tool.read!({ locale: 'en' } as never, {} as never)) as { feature: string; howItWorks: unknown[] };
      expect(r.feature.length).toBeGreaterThan(3);
      expect(Array.isArray(r.howItWorks)).toBe(true);
    }
  });
  it('an explain tool for a capability that is not in the bundle is simply absent (never a broken tool)', () => {
    expect(explainTools({}, ['campaigns.auto-pause'])).toEqual([]);
  });

  it('every explain tool is offered when the merchant asks one of the capability\'s own example questions (Arabic)', () => {
    const all = chatAdapter({ env, ws: undefined as never, callApi: async () => ({ status: 200, json: {} }), registry: reg, corpus: corpusJson as unknown as HelpCorpus, assistantCapability: 'assistant.ebda-assistant', help: noHelp, ai: { run: async () => ({}) } }).tools();
    const missing: string[] = [];
    for (const id of EXPLAIN_IDS) {
      const ex = reg.caps.get(id)!.examples.filter((q) => /[؀-ۿ]/.test(q));
      const offered = ex.some((q) => selectTools(q, all, reg, { mode: 'act', untrustedInContext: false }).some((o) => o.capabilityId === id));
      if (!offered) missing.push(`${id}: ${ex[0] ?? '(no Arabic example)'}`);
    }
    expect(missing).toEqual([]);
  });
});
