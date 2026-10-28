/** Final-review fix I5 (LEGAL-DELETE-1, second form): the Meta user id is recorded server-side; a deletion request erases only that person's mapping and FLAGS workspaces; the queue is durable. */
import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subjectHash } from '../src/core/erasure';
import { MAX_ATTEMPTS, processRequest, recordRequest, sweepDeletionRequests } from '../src/core/meta/data-deletion';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, apiFor, graphStub, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import type { GraphCall, GraphReply } from './helpers/graph';
import { stubGraph } from './helpers/graph';
import { seedOwnNumber } from './helpers/own-number';
import { clearTokenCaches } from '../src/core/numbers/token';
import { TEST_APP_SECRET } from './helpers/meta';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); clearTokenCaches(); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });
const W = (n: number) => W0(9600 + n);
const hash = (id: string) => subjectHash(env, 'meta-user', id);
const b64url = (b: ArrayBuffer | string) => btoa(typeof b === 'string' ? b : String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function signedRequest(payload: Record<string, unknown>): Promise<string> {
  const p = b64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(TEST_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(p)))}.${p}`;
}
const post = (sr: string) => SELF.fetch('https://x/meta/data-deletion', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ signed_request: sr }).toString() });
const payload = (user: string) => ({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: user });
const d1 = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).all<T>().then((r) => r.results);
const mapUser = async (ws: string, waba: string, userId: string) =>
  env.DB.prepare('INSERT INTO waba_signup_users (waba_id, workspace_id, user_hash, first_seen_at) VALUES (?, ?, ?, 1)').bind(waba, ws, await hash(userId)).run();

describe('the Meta user id is recorded SERVER-side, from the exchanged token', () => {
  const phoneOf = (id: string) => ({ id, display_phone_number: '+20 100 000 1111', verified_name: 'Demo', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_250', throughput: { level: 'STANDARD' }, name_status: 'APPROVED', platform_type: 'CLOUD_API', is_on_biz_app: false });
  const meta = (waba: string, pn: string, debug: GraphReply) => (c: GraphCall): GraphReply => {
    const path = new URL(c.url).pathname.replace(/^\/v[\d.]+\//, '').replace(waba, 'WABA').replace(pn, 'PN');
    switch (`${c.method} ${path}`) {
      case 'GET oauth/access_token': return { status: 200, json: { access_token: 'biz-token-new' } };
      case 'GET debug_token': return debug;
      case 'GET WABA/phone_numbers': return { status: 200, json: { data: [phoneOf(pn)] } };
      case 'GET PN': return { status: 200, json: phoneOf(pn) };
      default: return { status: 200, json: { success: true } };
    }
  };
  it('debug_token on the exchanged token names the person; a browser-sent fbUserId is ignored', async () => {
    const ws = W(1);
    const api = await apiFor(ws);
    graphStub(meta('9701', '8701', { status: 200, json: { data: { is_valid: true, app_id: 'app-1', user_id: '5550001' } } }));
    const res = await api.call('POST', '/numbers/connect', { code: 'c1', event: 'FINISH', wabaId: '9701', phoneNumberId: '8701', fbUserId: '9990009' });
    expect(res.status).toBe(200);
    const rows = await d1<{ user_hash: string }>('SELECT user_hash FROM waba_signup_users WHERE waba_id = ?', '9701');
    expect(rows).toEqual([{ user_hash: await hash('5550001') }]);
    expect(await d1('SELECT fb_user_id FROM waba_credentials WHERE waba_id = ?', '9701')).toEqual([{ fb_user_id: null }]);
    expect(JSON.stringify(await d1('SELECT * FROM waba_signup_users'))).not.toMatch(/5550001|9990009/);
  });
  it('a token that is not valid for THIS app records nobody (and the connect still works)', async () => {
    const ws = W(2);
    const api = await apiFor(ws);
    graphStub(meta('9702', '8702', { status: 200, json: { data: { is_valid: true, app_id: 'another-app', user_id: '5550002' } } }));
    expect((await api.call('POST', '/numbers/connect', { code: 'c2', event: 'FINISH', wabaId: '9702', phoneNumberId: '8702' })).status).toBe(200);
    expect(await d1('SELECT 1 FROM waba_signup_users WHERE waba_id = ?', '9702')).toEqual([]);
  });
});

describe('a deletion request erases the PERSON, flags the workspaces, disconnects nothing', () => {
  it('agency staff removing the app: the mapping is gone, every workspace they touched is flagged (P1 + owner notice), every number stays connected', async () => {
    await seedOwnNumber('pn-r1', W(11), 'waba-r1');
    await seedOwnNumber('pn-r2', W(12), 'waba-r2');
    await seedOwnNumber('pn-r3', W(13), 'waba-r3');
    await mapUser(W(11), 'waba-r1', '6660001');
    await mapUser(W(12), 'waba-r2', '6660001');
    await mapUser(W(13), 'waba-r3', '6660002'); // somebody else
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logs.push(String(m)); });
    stubGraph();
    const { confirmation_code } = (await (await post(await signedRequest(payload('6660001')))).json()) as { confirmation_code: string };
    await vi.waitFor(async () => { const r = await d1<{ state: string }>('SELECT state FROM meta_deletion_requests WHERE code = ?', confirmation_code); if (r[0]?.state !== 'done') throw new Error(r[0]?.state); }, { timeout: 5000 });
    expect(await d1("SELECT phone_number_id, status FROM phone_numbers WHERE phone_number_id IN ('pn-r1','pn-r2','pn-r3') ORDER BY 1")).toEqual([{ phone_number_id: 'pn-r1', status: 'active' }, { phone_number_id: 'pn-r2', status: 'active' }, { phone_number_id: 'pn-r3', status: 'active' }]);
    expect(await d1("SELECT count(*) AS n FROM waba_credentials WHERE waba_id IN ('waba-r1','waba-r2','waba-r3')")).toEqual([{ n: 3 }]);
    expect(await d1("SELECT waba_id FROM waba_signup_users WHERE waba_id LIKE 'waba-r%' ORDER BY waba_id")).toEqual([{ waba_id: 'waba-r3' }]); // only the other person's mapping is left
    expect((await d1<{ workspace_id: string }>("SELECT workspace_id FROM workspace_notices WHERE kind = 'meta_user_removed_app' AND resolved_at IS NULL ORDER BY workspace_id")).map((r) => r.workspace_id)).toEqual([W(11), W(12)]);
    expect(logs.filter((l) => l.includes('"alert":"meta_user_removed_app"'))).toHaveLength(2);
    expect(logs.join('\n')).not.toContain('6660001');
  });
  it('the owner sees the notice on the Numbers list and can dismiss it ("keep connected"); the number stays', async () => {
    const ws = W(21);
    await seedOwnNumber('pn-n1', ws, 'waba-n1');
    await mapUser(ws, 'waba-n1', '7770001');
    stubGraph();
    await post(await signedRequest(payload('7770001')));
    await vi.waitFor(async () => { if (!(await d1('SELECT 1 FROM workspace_notices WHERE workspace_id = ?', ws)).length) throw new Error('no notice'); }, { timeout: 5000 });
    const api = await apiFor(ws);
    const list = (await (await api.call('GET', '/numbers')).json()) as { items: unknown[]; notices: { id: number; kind: string; wabaId: string }[] };
    expect(list.notices).toEqual([expect.objectContaining({ kind: 'meta_user_removed_app', wabaId: 'waba-n1' })]);
    expect((await (await apiFor(ws, 'staff')).call('POST', `/numbers/notices/${list.notices[0]!.id}/dismiss`)).status).toBe(403);
    expect((await api.call('POST', `/numbers/notices/${list.notices[0]!.id}/dismiss`)).status).toBe(200);
    expect(((await (await api.call('GET', '/numbers')).json()) as { notices: unknown[] }).notices).toEqual([]);
    expect(await d1("SELECT status FROM phone_numbers WHERE phone_number_id = 'pn-n1'")).toEqual([{ status: 'active' }]);
  });
  it('an operator can confirm the disconnect (with a reason), and that resolves the notice', async () => {
    const ws = W(22);
    await seedOwnNumber('80001', ws, 'waba-o1');
    await env.DB.prepare("INSERT INTO workspace_notices (workspace_id, kind, ref, created_at) VALUES (?, 'meta_user_removed_app', 'waba-o1', 1)").bind(ws).run();
    stubGraph();
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/numbers/80001/disconnect`, {})).status).toBe(400); // a reason is required
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/numbers/80001/disconnect`, { reason: 'owner confirmed by phone, ticket 55' })).status).toBe(200);
    expect(await d1("SELECT status FROM phone_numbers WHERE phone_number_id = '80001'")).toEqual([{ status: 'disconnected' }]);
    expect(await d1('SELECT resolved_at IS NOT NULL AS r FROM workspace_notices WHERE workspace_id = ?', ws)).toEqual([{ r: 1 }]);
  });
});

describe('the queue is durable', () => {
  const queued = async (user: string, ageMs: number, attempts = 0) => {
    const r = (await recordRequest(env, { userId: user, issuedAt: Math.floor(Date.now() / 1000) }, Date.now() - ageMs))!;
    if (attempts) await env.DB.prepare('UPDATE meta_deletion_requests SET attempts = ?, last_attempt_at = ? WHERE code = ?').bind(attempts, Date.now() - ageMs, r.code).run();
    return r.code;
  };
  const state = (code: string) => d1<{ state: string; attempts: number }>('SELECT state, attempts FROM meta_deletion_requests WHERE code = ?', code).then((r) => r[0]!);
  it('a row stuck in `queued` (the waitUntil died) is processed by the sweep', async () => {
    const ws = W(31);
    await seedOwnNumber('pn-q1', ws, 'waba-q1');
    await mapUser(ws, 'waba-q1', '8880001');
    const code = await queued('8880001', 3_600_000);
    expect((await state(code)).state).toBe('queued');
    await sweepDeletionRequests(env, Date.now());
    expect(await state(code)).toMatchObject({ state: 'done', attempts: 1 });
  });
  it('a row that never finishes is retried up to N times, then failed with a P1 alert', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logs.push(String(m)); });
    const code = await queued('8880002', 3_600_000, MAX_ATTEMPTS);
    await sweepDeletionRequests(env, Date.now());
    expect((await state(code)).state).toBe('failed');
    expect(logs.some((l) => l.includes('"alert":"meta_deletion_needs_review"') && l.includes('stuck'))).toBe(true);
    logs.length = 0;
    await sweepDeletionRequests(env, Date.now());
    expect(logs).toEqual([]); // alerted once
  });
  it('a retry of the same signed request returns the same code and runs nothing again', async () => {
    const sr = await signedRequest(payload('8880003'));
    const a = (await (await post(sr)).json()) as { confirmation_code: string };
    await vi.waitFor(async () => { if ((await state(a.confirmation_code)).state === 'queued') throw new Error('queued'); }, { timeout: 5000 });
    const before = await state(a.confirmation_code);
    const b = (await (await post(sr)).json()) as { confirmation_code: string };
    expect(b.confirmation_code).toBe(a.confirmation_code);
    expect(await state(a.confirmation_code)).toEqual(before);
    void processRequest;
  });
});
