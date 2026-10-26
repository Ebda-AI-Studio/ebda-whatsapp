import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { detectOptOut, detectOptOutMessage } from '../src/core/consent';
import { customerKey } from '../src/core/shared/shared-number';
import { rows, workspace } from './helpers/workspace';

const PHONE = '201001234567';

// ---- A3: one widened vocabulary, whole-message match only
it.each([
  'cancel', 'Cancel!', 'stop all', 'STOP ALL', 'optout', 'opt out', 'opt-out', 'unsubscribe me', 'stop messages', 'remove me',
  'توقف', 'ايقاف', 'إيقاف', 'ايقاف الرسائل', 'بطل', 'بطّل', 'بطلوا', 'بطل رسايل', 'مش عايز رسايل', 'مش عايز رسائل', 'لا تراسلني', 'متبعتليش رسايل',
])('A3 opt-out vocabulary: %j is an opt-out', (t) => expect(detectOptOut(t)).toBe(true));
it.each([
  'please cancel my order', 'cancel order 12', 'I cannot stop laughing', 'stop all the deliveries today', 'optout please call me', 'توقف عن الرد علي ايه',
  'بطل يتأخر', 'عايز رسايل اكتر', 'مش عايز اوصل متأخر', 'إلغاء الطلب', 'ايقاف الطلب رقم 5', '',
])('A3 not an opt-out (substring/other meaning): %j', (t) => expect(detectOptOut(t)).toBe(false));

// ---- A2: a button / list reply is judged on title or id, same vocabulary
const rep = (kind: 'button' | 'list', id: string, title: string) => ({ type: 'interactive' as const, reply: { kind, id, title } });
it('A2 a Stop button tap (title or id) is an opt-out; ordinary and COD replies are not', () => {
  expect(detectOptOutMessage(rep('button', 'x1', 'Stop promotions'.slice(0, 4)))).toBe(true); // "Stop"
  expect(detectOptOutMessage(rep('button', 'x1', 'وقف الرسائل'))).toBe(true);
  expect(detectOptOutMessage(rep('button', 'optout', 'Not now'))).toBe(true); // id
  expect(detectOptOutMessage(rep('button', 'opt_out', 'x'))).toBe(true);
  expect(detectOptOutMessage(rep('list', 'stop', 'x'))).toBe(true);
  expect(detectOptOutMessage(rep('button', 'yes', 'أيوه'))).toBe(false);
  expect(detectOptOutMessage(rep('button', 'cod:n:o1', 'cancel'))).toBe(false); // a COD answer is an order answer, never an opt-out
  expect(detectOptOutMessage(rep('list', 'shared:pick:ws', 'Stop'))).toBe(false); // a store pick
  expect(detectOptOutMessage({ type: 'text', text: 'stop' })).toBe(true);
  expect(detectOptOutMessage({ type: 'image' })).toBe(false);
});
it('A2 an inbound Stop button tap opts the contact out end to end', async () => {
  const ws = 'ws-priv-a2';
  await workspace(ws).ingest({ phoneNumberId: 'pn', inbound: [{ wamid: 'a2.1', from: PHONE, ts: 100, type: 'interactive', reply: { kind: 'button', id: 'qr1', title: 'Stop' } }], statuses: [], receivedAt: 1 }, { autoReplyText: 'auto' });
  expect(await rows(ws, 'SELECT opted_out_at, consent_source FROM contacts')).toEqual([{ opted_out_at: 100_000, consent_source: 'keyword_stop' }]);
});

// ---- B1: an import that is still running holds phones; erasing a contact must not leave that file behind
it('B1 erasing a contact fails any unfinished import and deletes its CSV', async () => {
  const ws = 'ws-priv-b1';
  const key = `imports/${ws}/live.csv`;
  await env.MEDIA.put(key, `phone\n${PHONE}\n`);
  await workspace(ws).createImport({ id: 'live', filename: 'live.csv', r2Key: key, size: 20, consented: false, mapping: null, actor: 'u' });
  await workspace(ws).ingest({ phoneNumberId: 'pn', inbound: [{ wamid: 'b1.1', from: PHONE, ts: 1, type: 'text', text: 'hi' }], statuses: [], receivedAt: 1 });
  await workspace(ws).eraseContact(PHONE);
  expect(await env.MEDIA.get(key)).toBeNull();
  expect(await rows(ws, "SELECT status, error FROM imports WHERE id = 'live'")).toEqual([{ status: 'failed', error: 'contact_erased' }]);
});

// ---- B7: parked shared-number messages of the sender go with the erasure
it('B7 eraseContact deletes the parked shared-number objects of that sender (and only theirs)', async () => {
  const ws = 'ws-priv-b7';
  const pn = 'pn-priv';
  const mine = await customerKey(env, PHONE);
  const other = await customerKey(env, '201119998888');
  await env.DB.prepare("INSERT INTO shared_routes (phone_number_id, customer_key, workspace_id, last_at) VALUES (?, ?, ?, 1)").bind(pn, mine, ws).run();
  await env.MEDIA.put(`shared-parked/${pn}/${mine}/000000000001-a`, '{"from":"x"}');
  await env.MEDIA.put(`shared-parked/${pn}/${mine}/000000000002-b`, '{"from":"x"}');
  await env.MEDIA.put(`shared-parked/${pn}/${other}/000000000001-c`, '{"from":"y"}');
  const r = await workspace(ws).eraseContact(PHONE);
  expect(r.r2Pending).toBe(0);
  expect((await env.MEDIA.list({ prefix: `shared-parked/${pn}/${mine}/` })).objects).toEqual([]);
  expect((await env.MEDIA.list({ prefix: `shared-parked/${pn}/${other}/` })).objects).toHaveLength(1);
});
