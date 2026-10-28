import { env, introspectWorkflow } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { importDto, listContactsResponse } from '../src/core/api/contract';
import { DEFAULT_IMPORT_WORDING, STORE_CHECKOUT_WORDING } from '../src/core/consent-proof';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { BUYER_KEY_1, WA_1, deliver, iso, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, openChat, rows, workspace } from './helpers/workspace';

// A4: the consent proof records who attested, the exact wording shown, when, and the source (import / opt_in / link).
useApiKey();
useStoreLink();
type Api = Awaited<ReturnType<typeof apiFor>>;
const form = (csv: string, fields: Record<string, string> = {}) => {
  const f = new FormData();
  f.set('file', new File([csv], 'customers.csv', { type: 'text/csv' }));
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
async function importCsv(api: Api, csv: string, fields: Record<string, string>) {
  const wf = await introspectWorkflow(env.IMPORT_WORKFLOW);
  try {
    await wf.modifyAll(async (m) => { await m.disableRetryDelays(); });
    const res = await api.call('POST', '/imports', form(csv, fields));
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    for (const inst of await wf.get()) await inst.waitForStatus('complete');
    return { id, summary: importDto.parse(await (await api.call('GET', `/imports/${id}`)).json()) };
  } finally { await wf.dispose(); }
}
const proofs = (ws: string) => rows<{ wa_id: string; source: string; attested_by: string; wording: string; at: number; ref: string | null }>(ws, 'SELECT c.wa_id, p.source, p.attested_by, p.wording, p.at, p.ref FROM consent_proofs p JOIN contacts c ON c.id = p.contact_id ORDER BY p.id');
const CSV = 'Phone,Name\n0100 123 4567,Ali\n0111 111 1111,Sara\n';

it('an import with the tick records who attested, the exact wording shown, the time, the source and the import id', async () => {
  const ws = W(9001);
  const api = await apiFor(ws);
  const me = (await (await api.call('GET', '/me')).json()) as { userId: string };
  const before = Date.now();
  const { id } = await importCsv(api, CSV, { consented: 'true', wording: 'أقر إن العملاء دول وافقوا يستقبلوا عروض مني.' });
  const got = await proofs(ws);
  expect(got).toHaveLength(2);
  for (const p of got) expect(p).toMatchObject({ source: 'import', attested_by: me.userId, wording: 'أقر إن العملاء دول وافقوا يستقبلوا عروض مني.', ref: id });
  expect(got[0]!.at).toBeGreaterThanOrEqual(before);
});

it('without a wording field the server records its default attestation text, never an empty one', async () => {
  const ws = W(9002);
  await importCsv(await apiFor(ws), CSV, { consented: 'true' });
  expect((await proofs(ws)).map((p) => p.wording)).toEqual([DEFAULT_IMPORT_WORDING, DEFAULT_IMPORT_WORDING]);
});

it('an import without the tick records no proof; a later import never replaces the proof of a contact that already has one', async () => {
  const ws = W(9003);
  const api = await apiFor(ws);
  await importCsv(api, CSV, { consented: 'false' });
  expect(await proofs(ws)).toEqual([]);
  await importCsv(api, 'Phone\n0100 123 4567\n', { consented: 'true', wording: 'first' });
  await importCsv(api, 'Phone\n0100 123 4567\n', { consented: 'true', wording: 'second' });
  expect((await proofs(ws)).map((p) => p.wording)).toEqual(['first']);
});

it('the proof is shown in the contact view', async () => {
  const ws = W(9004);
  const api = await apiFor(ws);
  await importCsv(api, 'Phone,Name\n0100 123 4567,Ali\n', { consented: 'true', wording: 'W1' });
  const list = listContactsResponse.parse(await (await api.call('GET', '/contacts')).json());
  expect(list.items[0]!.consent).toMatchObject({ source: 'import:customers.csv', proof: { source: 'import', wording: 'W1', attestedBy: expect.any(String), ref: expect.any(String) } });
});

it('START on WhatsApp records an opt_in proof: attested by the customer, with the START keyword that matched, not their whole message', async () => {
  const ws = W(9005);
  await storeWorkspace(ws);
  await openChat(ws, WA_1, { text: 'stop', ts: Math.floor(Date.now() / 1000), wamid: 'wamid.p5.1' });
  await openChat(ws, WA_1, { text: ' START!! ', ts: Math.floor(Date.now() / 1000) + 1, wamid: 'wamid.p5.2' });
  expect(await proofs(ws)).toMatchObject([{ source: 'opt_in', attested_by: 'customer', wording: 'start' }]);
});

it('a Store checkout opt-in records a link proof attested by the store', async () => {
  const ws = W(9006);
  await storeWorkspace(ws);
  const at = Date.now() - 60_000;
  await deliver([storeEvent(ws, 'cart.abandoned', { cartId: 'c1', buyerKey: BUYER_KEY_1, phoneE164: '+201001234567', locale: 'ar', recoveryUrl: 'https://shop.example/cart/x' }, { occurredAt: iso(at) })]);
  expect(await proofs(ws)).toMatchObject([{ source: 'link', attested_by: 'store', at }]);
});

it('contract v1.5: a consent_changed that carries the checkout wording records those exact words and the locale shown (WA-CONSENT-PROOF-1 gap closed)', async () => {
  const ws = W(9016);
  await storeWorkspace(ws);
  const t0 = Date.now() - 120_000;
  await deliver([storeEvent(ws, 'cart.abandoned', { cartId: 'c1', buyerKey: BUYER_KEY_1, phoneE164: '+201001234567', locale: 'ar', recoveryUrl: 'https://shop.example/cart/x' }, { occurredAt: iso(t0) })]);
  await deliver([storeEvent(ws, 'customer.consent_changed', { buyerKey: BUYER_KEY_1, marketingOptIn: false, at: iso(t0 + 1_000) })]);
  const words = 'أوافق على استلام عروض المتجر على واتساب';
  await deliver([storeEvent(ws, 'customer.consent_changed', { buyerKey: BUYER_KEY_1, marketingOptIn: true, at: iso(t0 + 2_000), wording: { text: words, locale: 'ar' } })]);
  const last = (await proofs(ws)).at(-1)!;
  expect(last).toMatchObject({ source: 'link', attested_by: 'store', wording: words, ref: 'locale:ar', at: t0 + 2_000 });
});

it('contract v1.5: a consent_changed without wording still records the marker text (older Store builds)', async () => {
  const ws = W(9017);
  await storeWorkspace(ws);
  const t0 = Date.now() - 120_000;
  await deliver([storeEvent(ws, 'cart.abandoned', { cartId: 'c1', buyerKey: BUYER_KEY_1, phoneE164: '+201001234567', locale: 'en', recoveryUrl: 'https://shop.example/cart/x' }, { occurredAt: iso(t0) })]);
  await deliver([storeEvent(ws, 'customer.consent_changed', { buyerKey: BUYER_KEY_1, marketingOptIn: false, at: iso(t0 + 1_000) })]);
  await deliver([storeEvent(ws, 'customer.consent_changed', { buyerKey: BUYER_KEY_1, marketingOptIn: true, at: iso(t0 + 2_000) })]);
  const last = (await proofs(ws)).at(-1)!;
  expect(last.wording).toBe(STORE_CHECKOUT_WORDING);
  expect(last.ref).toBeNull();
});

it('a backup carries the proofs and restore brings them back', async () => {
  const ws = W(9007);
  await importCsv(await apiFor(ws), CSV, { consented: 'true', wording: 'W7' });
  const m = await workspace(ws).exportSnapshot('2026-10-27');
  expect(m.tables.consent_proofs?.rows).toBe(2);
  const target = W(9008);
  expect((await workspace(target).importSnapshot(`backups/${ws}/2026-10-27/`)).ok).toBe(true);
  expect((await proofs(target)).map((p) => p.wording)).toEqual(['W7', 'W7']);
});

it('erasing a contact erases its proofs', async () => {
  const ws = W(9009);
  await importCsv(await apiFor(ws), CSV, { consented: 'true' });
  expect((await workspace(ws).eraseContact('201001234567')).found).toBe(true);
  expect((await proofs(ws)).map((p) => p.wa_id)).toEqual(['201111111111']);
});
