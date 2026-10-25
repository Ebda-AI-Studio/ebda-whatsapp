import { expect, it } from 'vitest';
import { segmentCriteria, segmentDto, segmentPreviewDto } from '../src/core/api/contract';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { exec, openChat, rows, workspace } from './helpers/workspace';

useApiKey();
const NOW = Date.now();
const DAY = 86_400_000;

/** Seeds: c1 vip+ordered+consent+recent, c2 vip+opted out, c3 vip no consent, c4 eid(conversation tag)+consent, c5 consent old, c6 consent never wrote. */
async function seed(ws: string) {
  const add = async (waId: string, o: { inboundMs?: number; consent?: boolean; optedOut?: boolean; tags?: string[]; convTags?: string[]; order?: string }) => {
    const cid = await openChat(ws, waId, { ts: Math.floor((o.inboundMs ?? NOW) / 1000) });
    await exec(ws, 'UPDATE contacts SET consent_source = ?, consent_at = ?, opted_out_at = ?, last_inbound_at = ? WHERE wa_id = ?', o.consent === false ? null : 'import:x.csv', o.consent === false ? null : 1000, o.optedOut ? 2000 : null, o.inboundMs === undefined ? Math.floor(NOW / 1000) : Math.floor(o.inboundMs / 1000), waId);
    for (const t of o.tags ?? []) await exec(ws, 'INSERT INTO contact_tags (contact_id, tag) SELECT id, ? FROM contacts WHERE wa_id = ?', t, waId);
    for (const t of o.convTags ?? []) await exec(ws, 'INSERT INTO conversation_tags (conversation_id, tag) VALUES (?, ?)', cid, t);
    if (o.order) await exec(ws, "INSERT INTO store_orders (order_id, wa_id, status, updated_at) VALUES (?, ?, ?, 1)", `o-${waId}`, waId, o.order);
  };
  await add('201000000001', { tags: ['vip'], order: 'paid' });
  await add('201000000002', { tags: ['vip'], optedOut: true });
  await add('201000000003', { tags: ['vip'], consent: false });
  await add('201000000004', { convTags: ['EID'] });
  await add('201000000005', { inboundMs: NOW - 40 * DAY, order: 'cancelled' });
  await add('201000000006', {});
  await exec(ws, "UPDATE contacts SET last_inbound_at = NULL WHERE wa_id = '201000000006'");
}
const preview = async (ws: string, criteria: unknown) => segmentPreviewDto.parse(await workspace(ws).previewAudience(segmentCriteria.parse(criteria)));
const waIds = async (ws: string, criteria: unknown) => (await workspace(ws).audiencePage(segmentCriteria.parse(criteria), 0, 100)).map((r) => r.waId).sort();

it('criteria: at least one filter or everyone:true; unknown keys and optedOut:true are refused', () => {
  for (const bad of [{}, { tags: {} }, { tags: { any: [] } }, { optedOut: false }, { optedOut: true, everyone: true }, { everyone: false }, { tags: { any: ['a'] }, extra: 1 }, { lastInboundAfter: 5, lastInboundBefore: 5 }, { tags: { any: Array.from({ length: 11 }, (_, i) => `t${i}`) } }]) {
    expect(segmentCriteria.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  }
  for (const good of [{ everyone: true }, { tags: { any: ['vip'] } }, { hasOrdered: false }, { lastInboundBefore: 5 }, { tags: { all: ['a', 'b'] }, optedOut: false }]) {
    expect(segmentCriteria.safeParse(good).success, JSON.stringify(good)).toBe(true);
  }
});

it('audience is opted_out=false AND consent on record, always; everyone means every such contact', async () => {
  await seed(W(620));
  expect(await waIds(W(620), { everyone: true })).toEqual(['201000000001', '201000000004', '201000000005', '201000000006']);
  expect(await preview(W(620), { everyone: true })).toEqual({ count: 4, excluded: { optedOut: 1, noConsent: 1 } });
});

it('tags any / all read both tag sources and ignore case', async () => {
  await seed(W(621));
  expect(await waIds(W(621), { tags: { any: ['vip', 'eid'] } })).toEqual(['201000000001', '201000000004']);
  expect(await waIds(W(621), { tags: { all: ['vip', 'eid'] } })).toEqual([]);
  await exec(W(621), "INSERT INTO contact_tags (contact_id, tag) SELECT id, 'eid' FROM contacts WHERE wa_id = '201000000001'");
  expect(await waIds(W(621), { tags: { all: ['vip', 'EID'] } })).toEqual(['201000000001']);
  expect(await waIds(W(621), { tags: { any: ['VIP'], all: ['eid'] } })).toEqual(['201000000001']);
  // the preview says who the tag filter matched but cannot be messaged
  expect(await preview(W(621), { tags: { any: ['vip'] } })).toEqual({ count: 1, excluded: { optedOut: 1, noConsent: 1 } });
});

it('last inbound window and has_ordered', async () => {
  await seed(W(622));
  expect(await waIds(W(622), { lastInboundBefore: NOW - 30 * DAY })).toEqual(['201000000005']);
  expect(await waIds(W(622), { lastInboundAfter: NOW - 30 * DAY })).toEqual(['201000000001', '201000000004']);
  expect(await waIds(W(622), { lastInboundAfter: NOW - 60 * DAY, lastInboundBefore: NOW - 30 * DAY })).toEqual(['201000000005']);
  expect(await waIds(W(622), { hasOrdered: true })).toEqual(['201000000001']); // a cancelled order is not an order
  expect(await waIds(W(622), { hasOrdered: false })).toEqual(['201000000004', '201000000005', '201000000006']);
  expect(await waIds(W(622), { hasOrdered: false, lastInboundAfter: NOW - 30 * DAY })).toEqual(['201000000004']);
});

it('a STOP after the consent removes the contact at once (latest STOP wins)', async () => {
  await seed(W(623));
  await workspace(W(623)).ingest({ phoneNumberId: 'pn', inbound: [{ wamid: 'stop.623', from: '201000000001', ts: Math.floor(NOW / 1000) + 5, type: 'text', text: 'STOP' }], statuses: [], receivedAt: 1 });
  expect(await waIds(W(623), { tags: { any: ['vip'] } })).toEqual([]);
});

it('audience pages are keyset-ordered by contact id and a contact opting out between pages drops out', async () => {
  const ws = W(624);
  for (let i = 1; i <= 7; i++) await openChat(ws, `20100000010${i}`);
  await exec(ws, "UPDATE contacts SET consent_source = 'import:x', consent_at = 1");
  const stub = workspace(ws);
  const p1 = await stub.audiencePage({ everyone: true }, 0, 3);
  expect(p1).toHaveLength(3);
  await exec(ws, `UPDATE contacts SET opted_out_at = 9 WHERE id = ${p1[2]!.id + 1}`);
  const p2 = await stub.audiencePage({ everyone: true }, p1[2]!.id, 3);
  const p3 = await stub.audiencePage({ everyone: true }, p2[p2.length - 1]!.id, 3);
  const all = [...p1, ...p2, ...p3].map((r) => r.id);
  expect(new Set(all).size).toBe(all.length);
  expect(all).toHaveLength(6);
  expect(all).toEqual([...all].sort((a, b) => a - b));
});

it('segment CRUD over the API: owner writes, staff reads, names unique, bad criteria 400', async () => {
  const api = await apiFor(W(625));
  const staff = await apiFor(W(625), 'staff');
  await seed(W(625));
  const created = await api.call('POST', '/segments', { name: 'VIP', criteria: { tags: { any: ['vip'] } } });
  expect(created.status).toBe(201);
  const seg = segmentDto.parse(await created.json());
  expect((await api.call('POST', '/segments', { name: 'VIP', criteria: { everyone: true } })).status).toBe(409);
  expect((await api.call('POST', '/segments', { name: 'Empty', criteria: {} })).status).toBe(400);
  expect((await staff.call('POST', '/segments', { name: 'S', criteria: { everyone: true } })).status).toBe(403);
  expect((await staff.call('GET', '/segments')).status).toBe(200);
  expect(((await (await staff.call('GET', '/segments')).json()) as { items: unknown[] }).items).toHaveLength(1);
  expect(segmentDto.parse(await (await staff.call('GET', `/segments/${seg.id}`)).json()).name).toBe('VIP');
  const upd = await api.call('PUT', `/segments/${seg.id}`, { criteria: { hasOrdered: true } });
  expect(upd.status).toBe(200);
  expect(segmentDto.parse(await upd.json()).criteria).toEqual({ hasOrdered: true });
  expect((await api.call('PUT', `/segments/${seg.id}`, {})).status).toBe(400);
  expect((await staff.call('PUT', `/segments/${seg.id}`, { name: 'x' })).status).toBe(403);
  expect((await api.call('PUT', '/segments/99999', { name: 'x' })).status).toBe(404);
  expect(segmentPreviewDto.parse(await (await staff.call('GET', `/segments/${seg.id}/preview`)).json())).toEqual({ count: 1, excluded: { optedOut: 0, noConsent: 0 } });
  const adhoc = await staff.call('POST', '/segments/preview', { criteria: { tags: { any: ['vip'] } } });
  expect(segmentPreviewDto.parse(await adhoc.json())).toEqual({ count: 1, excluded: { optedOut: 1, noConsent: 1 } });
  expect((await staff.call('DELETE', `/segments/${seg.id}`)).status).toBe(403);
  expect((await api.call('DELETE', `/segments/${seg.id}`)).status).toBe(204);
  expect((await api.call('GET', `/segments/${seg.id}`)).status).toBe(404);
  expect(await rows(W(625), 'SELECT 1 FROM segments')).toEqual([]);
});
