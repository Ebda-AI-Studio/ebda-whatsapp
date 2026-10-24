import { SELF, env } from 'cloudflare:test';
import { beforeAll, expect, it, vi as vitestVi } from 'vitest';
import { JWKS_URL, mint, newKey, type TestKey } from './helpers/issuer';
import { rows, workspace } from './helpers/workspace';

const A = '201001111111';
const B = '201002222222';

async function seed(ws: string) {
  await workspace(ws).ingest({
    phoneNumberId: 'pn',
    inbound: [
      { wamid: `${ws}.a1`, from: A, ts: 1, type: 'text', text: 'short' },
      { wamid: `${ws}.a2`, from: A, ts: 2, type: 'text', text: 'ك'.repeat(1200) },
      { wamid: `${ws}.b1`, from: B, ts: 3, type: 'text', text: 'other' },
    ],
    statuses: [{ wamid: `${ws}.a1`, status: 'read', ts: 4 }, { wamid: `${ws}.b1`, status: 'read', ts: 5 }],
    receivedAt: 1,
  });
}

it('removes the contact, conversation, messages and status events, and deletes R2 bodies', async () => {
  await seed('ws-e1');
  const r = await workspace('ws-e1').eraseContact(A);
  expect(r).toEqual({ messages: 2, statusEvents: 1, r2Objects: 1 });
  expect(await rows('ws-e1', 'SELECT wa_id FROM contacts')).toEqual([{ wa_id: B }]);
  expect(await rows('ws-e1', 'SELECT count(*) AS n FROM conversations')).toEqual([{ n: 1 }]);
  expect(await rows('ws-e1', 'SELECT wamid FROM messages')).toEqual([{ wamid: 'ws-e1.b1' }]);
  expect(await rows('ws-e1', 'SELECT wamid FROM message_status_events')).toEqual([{ wamid: 'ws-e1.b1' }]);
  expect(await env.MEDIA.get('bodies/ws-e1/ws-e1.a2')).toBeNull();
});

it('is idempotent', async () => {
  await seed('ws-e2');
  await workspace('ws-e2').eraseContact(A);
  expect(await workspace('ws-e2').eraseContact(A)).toEqual({ messages: 0, statusEvents: 0, r2Objects: 0 });
});

it('also erases outbound replies to that contact', async () => {
  await seed('ws-e3');
  await workspace('ws-e3').claimSend({ workspaceId: 'ws-e3', phoneNumberId: 'pn', to: A, text: 'reply', idempotencyKey: 'k1' });
  await workspace('ws-e3').recordOutbound('k1', { ok: true, wamid: 'out.1' });
  expect((await workspace('ws-e3').eraseContact(A)).messages).toBe(3);
});

let k: TestKey;
beforeAll(async () => {
  k = await newKey('ke');
});
function stubJwks() {
  const real = globalThis.fetch;
  vitestVi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === JWKS_URL) return new Response(JSON.stringify({ keys: [k.jwk] }), { headers: { 'content-type': 'application/json' } });
    return real(input, init);
  });
}
const STORE = '33333333-3333-4333-8333-333333333333';
const del = (token: string, waId = '+20 100 111 1111') =>
  SELF.fetch(`https://x/api/v1/stores/${STORE}/contacts/${encodeURIComponent(waId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });

it('route: staff gets 403', async () => {
  stubJwks();
  expect((await del(await mint(k, { stores: [{ id: STORE, role: 'staff' }] }))).status).toBe(403);
});

it('route: owner erases, phone input normalised', async () => {
  stubJwks();
  await seed(STORE);
  const r = await del(await mint(k, { stores: [{ id: STORE, role: 'owner' }] }));
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ messages: 2, statusEvents: 1, r2Objects: 1 });
});

it('route: 400 for an invalid phone', async () => {
  stubJwks();
  expect((await del(await mint(k, { stores: [{ id: STORE, role: 'owner' }] }), 'abc')).status).toBe(400);
});
