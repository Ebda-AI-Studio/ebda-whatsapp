import { SELF, env } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { detectOptIn, detectOptOut } from '../src/core/consent';
import { EBDA_OPT_IN_KEYWORDS } from '../src/addons/ebda/consent';
import { normaliseText } from '../src/core/text-normalise';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { postWebhook } from './helpers/meta';
import { inboundPayload } from './helpers/payload';
import { exec, openChat, rows, seedNumber, workspace } from './helpers/workspace';

useApiKey();

it.each(['stop', ' STOP!', 'Stop.', '🛑 stop', 'unsubscribe', 'إلغاء', 'الغاء', 'ألغاء', 'الـغـاء', 'وقف', 'وقف الرسائل', 'وقف  الرسائل!!', 'الغاء الاشتراك', '"stop"'])(
  'opt-out: %j is an opt-out', (t) => expect(detectOptOut(t)).toBe(true),
);
it.each(['please stop calling me', 'stop the order #12', 'I will never stop', 'stopping', 'وقف الحال', 'مش عايز أوقف', 'الغاء الطلب رقم 5', '', '   ', 'ok', 'stop stop'])(
  'opt-out: %j is not an opt-out', (t) => expect(detectOptOut(t)).toBe(false),
);

it('opt-in uses the core keywords plus whatever the product passes in', () => {
  expect(detectOptIn(' Start! ')).toBe(true);
  expect(detectOptIn('اشترك')).toBe(true);
  expect(detectOptIn('ابدأ')).toBe(false); // product-specific: not in core
  for (const t of ['ابدأ', 'ابدا', 'START']) expect(detectOptIn(t, EBDA_OPT_IN_KEYWORDS), t).toBe(true);
  expect(detectOptIn('start the engine', EBDA_OPT_IN_KEYWORDS)).toBe(false);
});

it('normaliseText folds alef forms, tatweel, diacritics, Arabic digits and punctuation', () => {
  expect(normaliseText('  إِلْغَاء!! ')).toBe('الغاء');
  expect(normaliseText('الـغـاء')).toBe('الغاء');
  expect(normaliseText('طلب ١٢٣')).toBe('طلب 123');
  expect(normaliseText('Hello,   WORLD 👋')).toBe('hello world');
});

const inbound = (ws: string, wamid: string, text: string, ts: number) =>
  workspace(ws).ingest({ phoneNumberId: 'pn', inbound: [{ wamid, from: '201001234567', ts, type: 'text', text }], statuses: [], receivedAt: 1 }, { autoReplyText: 'auto' });
const optedOut = async (ws: string) => (await rows<{ opted_out_at: number | null; consent_source: string | null }>(ws, 'SELECT opted_out_at, consent_source FROM contacts'))[0]!;

it('an inbound STOP opts the contact out and sends nothing back; START clears it', async () => {
  const ws = 'ws-c1';
  const first = await inbound(ws, 'c1.a', 'مرحبا', 100);
  expect(first.replies).toHaveLength(1);
  const stop = await inbound(ws, 'c1.b', ' STOP!', 200);
  expect(stop.replies).toEqual([]);
  expect(await optedOut(ws)).toEqual({ opted_out_at: 200_000, consent_source: 'keyword_stop' });
  expect((await inbound(ws, 'c1.b', ' STOP!', 200)).replies).toEqual([]); // redelivery: still no reply
  const start = await inbound(ws, 'c1.c', 'start', 300);
  expect(start.replies).toHaveLength(1);
  expect(await optedOut(ws)).toEqual({ opted_out_at: null, consent_source: 'keyword_start' });
});

it('a message that only contains stop does not opt out', async () => {
  const ws = 'ws-c2';
  await inbound(ws, 'c2.a', 'please do not stop the delivery', 100);
  expect((await optedOut(ws)).opted_out_at).toBeNull();
});

it('the webhook passes the Ebda opt-in keyword, so ابدأ re-subscribes', async () => {
  await seedNumber('pn-c3', 'ws-c3');
  await exec('ws-c3', "INSERT INTO contacts (wa_id, opted_out_at) VALUES ('201001234567', 5)").catch(() => {});
  await postWebhook(SELF, inboundPayload('pn-c3', [{ id: 'c3.a', text: 'ابدأ' }]));
  expect((await optedOut('ws-c3')).opted_out_at).toBeNull();
  await postWebhook(SELF, inboundPayload('pn-c3', [{ id: 'c3.b', text: 'الغاء' }]));
  expect((await optedOut('ws-c3')).opted_out_at).not.toBeNull();
  expect(vi.mocked(env.SEND_QUEUE.sendBatch).mock.calls.length).toBe(1); // only the re-subscribe got the (spike) auto reply
});

it('after STOP, marketing templates are refused and utility ones still go', async () => {
  const api = await apiFor(W(110));
  const conv = await openChat(W(110));
  await exec(W(110), "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('m', 'ar', 'MARKETING', 'APPROVED', ?, 1), ('u', 'ar', 'UTILITY', 'APPROVED', ?, 1)", '[{"type":"BODY","text":"x"}]', '[{"type":"BODY","text":"y"}]');
  await workspace(W(110)).ingest({ phoneNumberId: 'pn', inbound: [{ wamid: 'c4.stop', from: '201001234567', ts: Math.floor(Date.now() / 1000), type: 'text', text: 'إلغاء' }], statuses: [], receivedAt: 1 });
  const send = (name: string, n: number) => api.call('POST', `/conversations/${conv}/messages`, { type: 'template', clientId: `00000000-0000-4000-8000-0000000001${n}0`, name, language: 'ar', params: [] });
  expect((await send('m', 1)).status).toBe(409);
  expect((await send('u', 2)).status).toBe(202);
});
