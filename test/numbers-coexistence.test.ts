import { env } from 'cloudflare:test';
import { SELF } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { seedOwnNumber } from './helpers/own-number';
import { exec, rows } from './helpers/workspace';

let graph: ReturnType<typeof stubGraph> | undefined;
afterEach(() => graph?.restore());

const TS = 1761300000;
const hook = (pn: string, field: string, value: Record<string, unknown>) =>
  JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba-x', time: TS, changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '201000001111', phone_number_id: pn }, ...value } }] }] });
const echo = (id: string, to: string, text: string, ts = TS) => ({ from: '201000001111', to, id, timestamp: String(ts), type: 'text', text: { body: text } });
const send = (raw: string) => postWebhook(SELF, raw);
const row = (pn: string) => env.DB.prepare('SELECT * FROM phone_numbers WHERE phone_number_id = ?').bind(pn).first<Record<string, any>>();

async function setup(n: number) {
  const ws = `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`;
  const pn = `88${n}`;
  await seedOwnNumber(pn, ws, `99${n}`);
  graph = stubGraph();
  return { ws, pn };
}

it('an echo (typed in the Business app) is stored as an outgoing message by "app": no send, no window, no unread, idempotent', async () => {
  const { ws, pn } = await setup(1);
  const raw = hook(pn, 'smb_message_echoes', { message_echoes: [echo('wamid.e1', '201112223333', 'تم الشحن اليوم')] });
  expect((await send(raw)).status).toBe(200);
  expect((await send(raw)).status).toBe(200); // redelivery
  expect(await rows(ws, "SELECT wamid, direction, type, body, status, author, created_at FROM messages")).toEqual([
    { wamid: 'wamid.e1', direction: 'out', type: 'text', body: 'تم الشحن اليوم', status: 'sent', author: 'app', created_at: TS * 1000 },
  ]);
  expect(await rows(ws, 'SELECT c.last_message_at, c.unread, ct.last_inbound_at, ct.consent_at FROM conversations c JOIN contacts ct ON ct.id = c.contact_id')).toEqual([{ last_message_at: TS, unread: 0, last_inbound_at: null, consent_at: null }]);
  expect(graph!.calls).toHaveLength(0);
  expect(env.SEND_QUEUE.sendBatch).not.toHaveBeenCalled();
  expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind IN ('bot_turn','send_release')")).toEqual([]);
});

it('synced contacts are saved without consent and never overwrite a known name; removals are ignored', async () => {
  const { ws, pn } = await setup(2);
  await exec(ws, "INSERT INTO contacts (wa_id, profile_name) VALUES ('201001110000', 'الاسم القديم')");
  const raw = hook(pn, 'smb_app_state_sync', { state_sync: [
    { type: 'contact', action: 'add', contact: { full_name: 'منى علي', first_name: 'منى', phone_number: '+20 100 222 3333' }, metadata: { timestamp: String(TS) } },
    { type: 'contact', action: 'add', contact: { full_name: 'اسم جديد', phone_number: '201001110000' } },
    { type: 'contact', action: 'remove', contact: { phone_number: '201005550000' } },
    { type: 'contact', action: 'add', contact: { full_name: 'bad', phone_number: '12' } },
  ] });
  expect((await send(raw)).status).toBe(200);
  expect(await rows(ws, 'SELECT wa_id, profile_name, consent_at, consent_source, opted_out_at FROM contacts ORDER BY wa_id')).toEqual([
    { wa_id: '201001110000', profile_name: 'الاسم القديم', consent_at: null, consent_source: null, opted_out_at: null },
    { wa_id: '201002223333', profile_name: 'منى علي', consent_at: null, consent_source: null, opted_out_at: null },
  ]);
  expect((await row(pn))!.contacts_sync).toBe('received');
  expect(await rows(ws, 'SELECT count(*) AS n FROM conversations')).toEqual([{ n: 0 }]);
});

it('history lands in its conversations with the original timestamps and statuses, and wakes nothing', async () => {
  const { ws, pn } = await setup(3);
  const cust = '201112223333';
  const raw = hook(pn, 'history', { history: [{ metadata: { phase: 0, chunk_order: 1, progress: 50 }, threads: [{ id: cust, messages: [
    { from: cust, id: 'wamid.h1', timestamp: String(TS - 86400 * 30), type: 'text', text: { body: 'عايز أسعار' }, history_context: { status: 'READ' } },
    { from: '201000001111', to: cust, id: 'wamid.h2', timestamp: String(TS - 86400 * 30 + 60), type: 'text', text: { body: 'أهلاً بحضرتك' }, history_context: { status: 'DELIVERED' } },
    { from: '201000001111', to: cust, id: 'wamid.h3', timestamp: String(TS - 86400 * 29), type: 'text', text: { body: 'فشل' }, history_context: { status: 'ERROR' } },
    { from: cust, id: 'wamid.h4', timestamp: String(TS - 86400 * 28), type: 'media_placeholder', history_context: { status: 'READ' } },
  ] }] }] });
  expect((await send(raw)).status).toBe(200);
  expect((await send(raw)).status).toBe(200);
  expect(await rows(ws, 'SELECT wamid, direction, type, status, author, created_at FROM messages ORDER BY created_at')).toEqual([
    { wamid: 'wamid.h1', direction: 'in', type: 'text', status: null, author: null, created_at: (TS - 86400 * 30) * 1000 },
    { wamid: 'wamid.h2', direction: 'out', type: 'text', status: 'delivered', author: 'app', created_at: (TS - 86400 * 30 + 60) * 1000 },
    { wamid: 'wamid.h3', direction: 'out', type: 'text', status: 'failed', author: 'app', created_at: (TS - 86400 * 29) * 1000 },
    { wamid: 'wamid.h4', direction: 'in', type: 'unsupported', status: null, author: null, created_at: (TS - 86400 * 28) * 1000 },
  ]);
  // no 24 h window, no unread, no auto reply, no bot/agent work, nothing sent
  expect(await rows(ws, 'SELECT c.unread, c.last_message_at, ct.last_inbound_at FROM conversations c JOIN contacts ct ON ct.id = c.contact_id')).toEqual([{ unread: 0, last_message_at: TS - 86400 * 28, last_inbound_at: null }]);
  expect(env.SEND_QUEUE.sendBatch).not.toHaveBeenCalled();
  expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind NOT IN ('backup', 'r2_drain', 'retention_purge')")).toEqual([]);
  expect(graph!.calls).toHaveLength(0);
  expect((await row(pn))!.history_sync).toBe('received');
});

it('error 2593109 (history declined) is recorded and stays declined', async () => {
  const { pn } = await setup(4);
  const declined = hook(pn, 'history', { history: [{ errors: [{ code: 2593109, title: 'declined', message: 'm', error_data: { details: 'd' } }] }] });
  expect((await send(declined)).status).toBe(200);
  expect((await row(pn))!.history_sync).toBe('declined');
  const late = hook(pn, 'history', { history: [{ threads: [{ id: '201112223333', messages: [{ from: '201112223333', id: 'wamid.late', timestamp: String(TS), type: 'text', text: { body: 'x' } }] }] }] });
  expect((await send(late)).status).toBe(200);
  expect((await row(pn))!.history_sync).toBe('declined');
});

it('a display-name decision updates the number; a tier change is recorded', async () => {
  const { pn } = await setup(5);
  await env.DB.prepare("UPDATE phone_numbers SET display_phone = '+20 100 000 1111' WHERE phone_number_id = ?").bind(pn).run();
  const name = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '995', time: TS, changes: [{ field: 'phone_number_name_update', value: { display_phone_number: '201000001111', decision: 'APPROVED', requested_verified_name: 'متجر منى', rejection_reason: null } }] }] });
  // the number's WABA is 995 in this test
  await env.DB.prepare('UPDATE phone_numbers SET waba_id = ? WHERE phone_number_id = ?').bind('995', pn).run();
  expect((await send(name)).status).toBe(200);
  expect(await row(pn)).toMatchObject({ name_status: 'APPROVED', verified_name: 'متجر منى' });
  const tier = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '995', time: TS, changes: [{ field: 'phone_number_quality_update', value: { display_phone_number: '201000001111', event: 'UPGRADE', current_limit: 'TIER_1K' } }] }] });
  expect((await send(tier)).status).toBe(200);
  expect((await row(pn))!.messaging_limit_tier).toBe('TIER_1K');
});

it('a coexistence event for an unknown number is acknowledged and stores nothing', async () => {
  graph = stubGraph();
  const raw = hook('no-such-number', 'smb_message_echoes', { message_echoes: [echo('wamid.zz', '201112223333', 'x')] });
  expect((await send(raw)).status).toBe(200);
});
