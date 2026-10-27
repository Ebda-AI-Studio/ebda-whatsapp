import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, apiFor, operatorCall, storeId as W, useApiKey } from './helpers/api';
import { exec, own, rows, workspace } from './helpers/workspace';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); });
afterEach(() => configureSessionCheck(null));
const A = '201001234567';
const B = '201007654321';
const nowS = () => Math.floor(Date.now() / 1000);
const audit = (ws: string) => env.DB.prepare('SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY id').bind(ws).all<{ action: string; actor_role: string; target_type: string | null; target_id: string | null; detail: string | null }>().then((r) => r.results);

async function chatWith(ws: string, wa: string, texts: string[], name?: string) {
  await workspace(ws).ingest({
    phoneNumberId: 'pn-x',
    inbound: texts.map((text, i) => ({ wamid: `wamid.${wa}.${ws}.${i}`, from: wa, ts: nowS() - 100 + i, type: 'text' as const, text, ...(name ? { profileName: name } : {}) })),
    statuses: [], receivedAt: Date.now(),
  });
}
const convOf = (ws: string, wa: string) => rows<{ id: number; cid: number }>(ws, 'SELECT c.id AS id, ct.id AS cid FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = ?', wa).then((r) => r[0]!);

describe('data-subject export (B5)', () => {
  async function seed(ws: string) {
    await own(ws);
    await chatWith(ws, A, ['أهلا', 'عايز أطلب', 'x'.repeat(1500)], 'سارة');
    await chatWith(ws, B, ['رسالة شخص تاني']);
    const { id, cid } = await convOf(ws, A);
    await exec(ws, "INSERT INTO notes (conversation_id, author_user_id, text, created_at) VALUES (?, 'u1', 'عميلة مهمة', 5)", id);
    await exec(ws, "INSERT INTO conversation_tags (conversation_id, tag) VALUES (?, 'vip')", id);
    await exec(ws, "INSERT INTO contact_tags (contact_id, tag) VALUES (?, 'gold')", cid);
    await exec(ws, "INSERT INTO store_orders (order_id, order_number, wa_id, status, total_minor, currency, updated_at) VALUES ('o1', '1001', ?, 'paid', 25000, 'EGP', 9)", A);
    await exec(ws, "UPDATE contacts SET consent_source = 'keyword_start', consent_at = 77 WHERE wa_id = ?", A);
  }

  it('gives the owner ONE contact\'s data as JSON (contact, consent, chat, full long bodies, notes, tags, orders), and nobody else\'s', async () => {
    const ws = W(4101);
    await seed(ws);
    const owner = await apiFor(ws);
    const res = await owner.call('GET', `/contacts/${A}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const j = (await res.json()) as any;
    expect(j.subject).toMatchObject({ waId: A, name: 'سارة', optedOut: false, consent: { source: 'keyword_start', at: 77 } });
    expect(j.messages.map((m: any) => m.text.length)).toEqual([4, 9, 1500]); // the long body is read back from R2, in full
    expect(j.messages[0]).toMatchObject({ direction: 'in', type: 'text' });
    expect(j.notes).toEqual([{ at: 5, authorUserId: 'u1', text: 'عميلة مهمة' }]);
    expect(j.tags.sort()).toEqual(['gold', 'vip']);
    expect(j.orders).toEqual([expect.objectContaining({ orderId: 'o1', orderNumber: '1001', totalMinor: 25000 })]);
    expect(j.nextAfter).toBeNull();
    expect(JSON.stringify(j)).not.toContain(B);
    expect(JSON.stringify(j)).not.toContain('شخص تاني');
  });

  it('pages the messages with a cursor; the other sections come with the first page only', async () => {
    const ws = W(4102);
    await seed(ws);
    const owner = await apiFor(ws);
    const p1 = (await (await owner.call('GET', `/contacts/${A}/export?limit=2`)).json()) as any;
    expect(p1.messages).toHaveLength(2);
    expect(p1.nextAfter).toBe(p1.messages[1].id);
    expect(p1.notes).toHaveLength(1);
    const p2 = (await (await owner.call('GET', `/contacts/${A}/export?limit=2&after=${p1.nextAfter}`)).json()) as any;
    expect(p2.messages).toHaveLength(1);
    expect(p2.nextAfter).toBeNull();
    expect(p2.notes).toBeUndefined();
    expect((await owner.call('GET', `/contacts/${A}/export?limit=0`)).status).toBe(400);
  });

  it('is for the owner (and an operator with a reason), 404 for an unknown contact, and is audited without the phone number', async () => {
    const ws = W(4103);
    await seed(ws);
    const staff = await apiFor(ws, 'staff');
    expect((await staff.call('GET', `/contacts/${A}/export`)).status).toBe(403);
    const owner = await apiFor(ws);
    expect((await owner.call('GET', '/contacts/201009999999/export')).status).toBe(404);
    expect((await owner.call('GET', `/contacts/${A}/export`)).status).toBe(200);
    const asOp = await operatorCall(OP1, 'GET', `/workspaces/${ws}/contacts/${A}/export`);
    expect(asOp.status).toBe(400); // an operator states why
    const ok = await operatorCall(OP1, 'GET', `/workspaces/${ws}/contacts/${A}/export?reason=${encodeURIComponent('طلب كتابي من صاحبة البيانات')}`);
    expect(ok.status).toBe(200);
    const rowsLog = (await audit(ws)).filter((r) => r.action === 'contact.export');
    expect(rowsLog.map((r) => r.actor_role)).toEqual(['owner', 'operator']);
    expect(rowsLog[0]!.target_type).toBe('waId');
    expect(rowsLog[0]!.target_id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(rowsLog[1]!.detail!)).toMatchObject({ reason: 'طلب كتابي من صاحبة البيانات' });
    expect(JSON.stringify(await env.DB.prepare('SELECT * FROM audit_log').all())).not.toContain(A);
    expect((await operatorCall(null, 'GET', `/workspaces/${ws}/contacts/${A}/export?reason=abcdef`)).status).toBe(401);
  });
});

describe('contact edit (M-175)', () => {
  it('a name the merchant sets sticks (WhatsApp\'s name no longer overwrites it), is searchable, and can be reset', async () => {
    const ws = W(4110);
    await own(ws);
    await chatWith(ws, A, ['أهلا'], 'Sara WA');
    const owner = await apiFor(ws);
    const staff = await apiFor(ws, 'staff');
    expect((await owner.call('PATCH', `/contacts/${A}`, { name: '' })).status).toBe(400);
    expect((await owner.call('PATCH', `/contacts/201009999999`, { name: 'x' })).status).toBe(404);
    const r = await staff.call('PATCH', `/contacts/${A}`, { name: '  سارة أحمد  ' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ waId: A, name: 'سارة أحمد' });
    await chatWith(ws, A, ['تاني'], 'Sara Changed'); // WhatsApp sends another profile name
    expect(await rows(ws, 'SELECT profile_name FROM contacts')).toEqual([{ profile_name: 'سارة أحمد' }]);
    expect((await (await owner.call('GET', '/contacts?q=' + encodeURIComponent('سارة'))).json()) as any).toMatchObject({ items: [{ waId: A }] });
    expect((await owner.call('PATCH', `/contacts/${A}`, { name: null })).status).toBe(200); // follow WhatsApp again
    await workspace(ws).ingest({ phoneNumberId: 'pn-x', inbound: [{ wamid: 'wamid.third', from: A, ts: nowS(), type: 'text', text: 'ثالثة', profileName: 'Sara Third' }], statuses: [], receivedAt: Date.now() });
    expect(await rows(ws, 'SELECT profile_name FROM contacts')).toEqual([{ profile_name: 'Sara Third' }]);
  });
});

describe('contact merge (M-175)', () => {
  async function two(ws: string) {
    await own(ws);
    await chatWith(ws, A, ['من الرقم القديم 1', 'من الرقم القديم 2'], 'سارة');
    await chatWith(ws, B, ['من الرقم الجديد'], 'Sara new');
    const a = await convOf(ws, A);
    const b = await convOf(ws, B);
    await exec(ws, "INSERT INTO notes (conversation_id, author_user_id, text, created_at) VALUES (?, 'u1', 'ملاحظة قديمة', 5)", a.id);
    await exec(ws, "INSERT INTO conversation_tags (conversation_id, tag) VALUES (?, 'a-only'), (?, 'both'), (?, 'both')", a.id, a.id, b.id);
    await exec(ws, "INSERT INTO contact_tags (contact_id, tag) VALUES (?, 'ca'), (?, 'cb')", a.cid, b.cid);
    await exec(ws, "INSERT INTO store_orders (order_id, wa_id, updated_at) VALUES ('oa', ?, 1)", A);
    await exec(ws, 'UPDATE conversations SET unread = 2 WHERE id = ?', a.id);
    await exec(ws, 'UPDATE conversations SET unread = 1 WHERE id = ?', b.id);
    return { a, b };
  }

  it('moves everything from one number to the other: messages, notes, tags, orders, unread; the old contact is gone', async () => {
    const ws = W(4120);
    const { b } = await two(ws);
    const owner = await apiFor(ws);
    const r = await owner.call('POST', '/contacts/merge', { fromWaId: A, intoWaId: B });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ waId: B, messages: 3 });
    expect(await rows(ws, 'SELECT wa_id FROM contacts')).toEqual([{ wa_id: B }]);
    expect(await rows(ws, 'SELECT id FROM conversations')).toEqual([{ id: b.id }]);
    expect(await rows(ws, 'SELECT count(*) AS n FROM messages WHERE conversation_id = ?', b.id)).toEqual([{ n: 3 }]);
    expect(await rows(ws, 'SELECT count(*) AS n FROM notes WHERE conversation_id = ?', b.id)).toEqual([{ n: 1 }]);
    expect((await rows<{ tag: string }>(ws, 'SELECT tag FROM conversation_tags ORDER BY tag')).map((t) => t.tag)).toEqual(['a-only', 'both']);
    expect((await rows<{ tag: string }>(ws, 'SELECT tag FROM contact_tags ORDER BY tag')).map((t) => t.tag)).toEqual(['ca', 'cb']);
    expect(await rows(ws, 'SELECT wa_id FROM store_orders')).toEqual([{ wa_id: B }]);
    expect(await rows(ws, 'SELECT unread FROM conversations')).toEqual([{ unread: 3 }]);
    expect(await rows(ws, 'SELECT count(*) AS n FROM contacts_fts')).toEqual([{ n: 1 }]);
    expect(await workspace(ws).search('القديم', 10)).toHaveLength(2); // the old messages are searchable under the surviving chat
    expect((await audit(ws)).some((x) => x.action === 'POST /stores/:storeId/contacts/merge')).toBe(true);
  });

  it('an opt-out on either number holds for the merged contact (never lose a STOP)', async () => {
    const ws = W(4121);
    await two(ws);
    await exec(ws, 'UPDATE contacts SET opted_out_at = 123 WHERE wa_id = ?', A);
    const owner = await apiFor(ws);
    expect((await owner.call('POST', '/contacts/merge', { fromWaId: A, intoWaId: B })).status).toBe(200);
    expect(await rows(ws, 'SELECT opted_out_at FROM contacts')).toEqual([{ opted_out_at: 123 }]);
  });

  it('a campaign both numbers were in keeps one row; the other moves over', async () => {
    const ws = W(4122);
    const { a, b } = await two(ws);
    for (const c of [a, b]) await exec(ws, "INSERT INTO campaign_recipients (campaign_id, contact_id, page, idem, state, at) VALUES ('camp1', ?, 0, ?, 'queued', 1)", c.cid, `i-${c.cid}`);
    await exec(ws, "INSERT INTO campaign_recipients (campaign_id, contact_id, page, idem, state, at) VALUES ('camp2', ?, 0, 'i-only-a', 'queued', 1)", a.cid);
    const owner = await apiFor(ws);
    expect((await owner.call('POST', '/contacts/merge', { fromWaId: A, intoWaId: B })).status).toBe(200);
    expect(await rows(ws, 'SELECT campaign_id, contact_id FROM campaign_recipients ORDER BY campaign_id')).toEqual([{ campaign_id: 'camp1', contact_id: b.cid }, { campaign_id: 'camp2', contact_id: b.cid }]);
  });

  it('owner only; refuses the same number, an unknown number and a bad body; a second merge finds nothing to merge', async () => {
    const ws = W(4123);
    await two(ws);
    const staff = await apiFor(ws, 'staff');
    expect((await staff.call('POST', '/contacts/merge', { fromWaId: A, intoWaId: B })).status).toBe(403);
    const owner = await apiFor(ws);
    expect((await owner.call('POST', '/contacts/merge', { fromWaId: A, intoWaId: A })).status).toBe(400);
    expect((await owner.call('POST', '/contacts/merge', { fromWaId: 'abc', intoWaId: B })).status).toBe(400);
    expect((await owner.call('POST', '/contacts/merge', { fromWaId: '201009999999', intoWaId: B })).status).toBe(404);
    expect((await owner.call('POST', '/contacts/merge', { fromWaId: A, intoWaId: B })).status).toBe(200);
    expect((await owner.call('POST', '/contacts/merge', { fromWaId: A, intoWaId: B })).status).toBe(404);
    void SELF;
  });
});
