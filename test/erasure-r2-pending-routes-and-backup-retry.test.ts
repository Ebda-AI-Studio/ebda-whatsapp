import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { beforeAll, expect, it, vi } from 'vitest';
import { createEbdaAccountsVerifier } from '../src/addons/ebda/identity';
import { IdentityError } from '../src/core/identity/verifier';
import { ISSUER, JWKS_URL, jwksServer, mint, newKey, type TestKey } from './helpers/issuer';
import { exec, rows, workspace } from './helpers/workspace';

let k: TestKey;
beforeAll(async () => {
  k = await newKey('kr');
});

function stubJwks() {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === JWKS_URL) return new Response(JSON.stringify({ keys: [k.jwk] }), { headers: { 'content-type': 'application/json' } });
    return real(input, init);
  });
}
const A = '201001111111';
async function seedBig(ws: string) {
  await workspace(ws).ingest({ phoneNumberId: 'pn', inbound: [{ wamid: `${ws}.big`, from: A, ts: 1, type: 'text', text: 'ك'.repeat(1200) }], statuses: [], receivedAt: 1 });
}
async function registerWorkspace(id: string) {
  await env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(id, id, Date.now()).run();
}

// I1
it('keeps R2 keys pending when the R2 delete fails and drains them on the next erase', async () => {
  await seedBig('ws-r1');
  const del = vi.spyOn(env.MEDIA, 'delete').mockRejectedValueOnce(new Error('r2 down'));
  const first = await workspace('ws-r1').eraseContact(A);
  expect(first.r2Pending).toBe(1);
  expect(await rows('ws-r1', 'SELECT key FROM r2_pending_deletes')).toEqual([{ key: 'bodies/ws-r1/ws-r1.big' }]);
  del.mockRestore();
  const second = await workspace('ws-r1').eraseContact(A);
  expect(second.r2Pending).toBe(0);
  expect(await rows('ws-r1', 'SELECT key FROM r2_pending_deletes')).toEqual([]);
  expect(await env.MEDIA.get('bodies/ws-r1/ws-r1.big')).toBeNull();
});

it('deletes R2 keys in batches of at most 1000', async () => {
  const ws = 'ws-r2';
  await runInDurableObject(workspace(ws), (_i, s) => {
    for (let i = 0; i < 2500; i++) s.storage.sql.exec('INSERT INTO r2_pending_deletes (key) VALUES (?)', `bodies/${ws}/m${i}`);
  });
  const del = vi.spyOn(env.MEDIA, 'delete');
  await workspace(ws).eraseContact('200000000000');
  expect(del.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([1000, 1000, 500]);
});

// I2
it('route: 404 for a store with no workspace, 404 for an unknown contact', async () => {
  stubJwks();
  const store = '44444444-4444-4444-8444-444444444444';
  const token = await mint(k, { stores: [{ id: store, role: 'owner' }] });
  const del = () => SELF.fetch(`https://x/api/v1/stores/${store}/contacts/%2B201001111111`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  expect((await del()).status).toBe(404);
  await registerWorkspace(store);
  expect((await del()).status).toBe(404);
});

it('route: a super admin who is also staff may erase', async () => {
  stubJwks();
  const store = '55555555-5555-4555-8555-555555555555';
  await registerWorkspace(store);
  await seedBig(store);
  const token = await mint(k, { stores: [{ id: store, role: 'staff' }], pa: 'super_admin' });
  const r = await SELF.fetch(`https://x/api/v1/stores/${store}/contacts/%2B201001111111`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  expect(r.status).toBe(200);
});

it('route: a literal % in the phone is 400, not 500', async () => {
  stubJwks();
  const store = '66666666-6666-4666-8666-666666666666';
  await registerWorkspace(store);
  const token = await mint(k, { stores: [{ id: store, role: 'owner' }] });
  const r = await SELF.fetch(`https://x/api/v1/stores/${store}/contacts/100%25`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  expect(r.status).toBe(400);
});

// I5
it('a failing backup alarm re-arms itself with backoff instead of ending the schedule', async () => {
  await seedBig('ws-r5');
  await exec('ws-r5', 'UPDATE scheduled_tasks SET due_at = 1');
  vi.spyOn(env.BACKUPS, 'put').mockRejectedValue(new Error('bucket missing'));
  const before = await runInDurableObject(workspace('ws-r5'), (_i, s) => s.storage.getAlarm());
  await runDurableObjectAlarm(workspace('ws-r5')).catch(() => {});
  const after = await runInDurableObject(workspace('ws-r5'), (_i, s) => s.storage.getAlarm());
  expect(before).toBeTypeOf('number');
  expect(after).toBeGreaterThan(Date.now());
  expect(await rows('ws-r5', "SELECT attempts FROM scheduled_tasks WHERE kind = 'backup'")).toEqual([{ attempts: 1 }]);
});

it('restore arms the backup alarm', async () => {
  await seedBig('ws-r6');
  await workspace('ws-r6').exportSnapshot('2026-10-24');
  expect((await workspace('ws-r6-restored').importSnapshot('backups/ws-r6/2026-10-24/')).ok).toBe(true);
  expect(await runInDurableObject(workspace('ws-r6-restored'), (_i, s) => s.storage.getAlarm())).toBeTypeOf('number');
});

it('restore rejects a manifest that is not a valid manifest', async () => {
  await env.BACKUPS.put('backups/ws-r7/2026-10-24/manifest.json', JSON.stringify({ hello: 'world' }));
  expect((await workspace('ws-r7-restored').importSnapshot('backups/ws-r7/2026-10-24/')).ok).toBe(false);
});

// I8 + minors on identity
function verifier() {
  return createEbdaAccountsVerifier({ jwksUrl: JWKS_URL, issuer: ISSUER, audience: 'whatsapp', fetchJwks: jwksServer([k]).fetchJwks });
}
const sign = (claims: Record<string, unknown>, set: (j: SignJWT) => SignJWT) =>
  set(new SignJWT({ sid: 's', stores: [], ...claims }).setProtectedHeader({ alg: 'ES256', kid: 'kr', typ: 'at+jwt' }).setSubject('6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e6f').setIssuer(ISSUER)).sign(k.privateKey);
async function status(p: Promise<unknown>) {
  return p.then(() => 200, (e) => (e instanceof IdentityError ? e.status : 500));
}

it('rejects a token without exp', async () => {
  expect(await status(verifier().verify(await sign({}, (j) => j.setAudience('whatsapp').setIssuedAt().setJti('j'))))).toBe(401);
});
it('rejects a token older than 16 minutes even with a far exp', async () => {
  const iat = Math.floor(Date.now() / 1000) - 20 * 60;
  expect(await status(verifier().verify(await sign({}, (j) => j.setAudience('whatsapp').setIssuedAt(iat).setExpirationTime(iat + 3600).setJti('j'))))).toBe(401);
});
it('rejects an audience array', async () => {
  expect(await status(verifier().verify(await sign({}, (j) => j.setAudience(['store', 'whatsapp']).setIssuedAt().setExpirationTime('10m').setJti('j'))))).toBe(401);
});
it('ignores an unknown pa value instead of failing the login', async () => {
  const p = await verifier().verify(await sign({ pa: 'support' }, (j) => j.setAudience('whatsapp').setIssuedAt().setExpirationTime('10m').setJti('j')));
  expect(p.superAdmin).toBe(false);
});

it('the nightly alarm drains owed R2 deletes even when the backup export fails', async () => {
  await seedBig('ws-r8');
  await runInDurableObject(workspace('ws-r8'), (_i, s) => s.storage.sql.exec("INSERT INTO r2_pending_deletes (key) VALUES ('bodies/ws-r8/old')"));
  await exec('ws-r8', 'UPDATE scheduled_tasks SET due_at = 1'); // due now, as it is when the alarm really fires
  vi.spyOn(env.BACKUPS, 'put').mockRejectedValue(new Error('bucket missing'));
  await runDurableObjectAlarm(workspace('ws-r8')).catch(() => {});
  expect(await rows('ws-r8', 'SELECT key FROM r2_pending_deletes')).toEqual([]);
});
