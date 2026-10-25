import { describe, expect, it } from 'vitest';
import type { OdooConfig } from '../src/core/api/contract';
import { odooConnector } from '../src/core/connectors/odoo';
import { useAgent } from './helpers/agent';
import { apiFor, storeId, useApiKey } from './helpers/api';
import { ctxOf, logText, spyLogs, stubClient, testEnv } from './helpers/connectors';
import { FakeOdoo } from './helpers/odoo';

useApiKey();
useAgent();

const HOST = 'erp.acme-client.com';
const cfg: OdooConfig = { url: `https://${HOST}`, database: 'prod', login: 'bot@acme-client.com' };
const KEY = 'test-secret-odoo-api-key';
let n = 0;
/** A fresh settings version per test so the uid cache of one test never serves another. */
const make = (key: string | null = KEY) => odooConnector({ env: testEnv, workspaceId: 'ws-odoo', id: 'erp', config: cfg, updatedAt: ++n, secret: async () => key });
const world = () => {
  const odoo = new FakeOdoo();
  const c = stubClient((call) => odoo.handle(call), HOST);
  return { odoo, c };
};
const kwCalls = (o: FakeOdoo) => o.requests.filter((r) => r.method === 'execute_kw').map((r) => ({ model: r.args[3], method: r.args[4], args: r.args[5], kwargs: r.args[6] }));

describe('odoo connector', () => {
  it('declares the four tools', () => {
    expect(make().tools.map((t) => t.name)).toEqual(['find_or_create_partner', 'create_sale_order', 'read_stock', 'create_calendar_booking']);
  });

  it('find_or_create_partner: JSON-RPC shapes, login once, creates then finds; the phone goes only into the call', async () => {
    const { odoo, c } = world();
    const logs = spyLogs();
    const first = await make().call('find_or_create_partner', { name: 'Mona' }, ctxOf());
    expect(first).toEqual({ ok: true, result: { partnerId: expect.any(Number), name: 'Mona', created: true } });
    const login = odoo.requests[0]!;
    expect(login).toEqual({ service: 'common', method: 'authenticate', args: ['prod', 'bot@acme-client.com', KEY, {}] });
    expect(c.calls[0]!.url).toBe(`https://${HOST}/jsonrpc`);
    expect(c.calls[0]!.json).toMatchObject({ jsonrpc: '2.0', method: 'call', params: { service: 'common' } });
    expect(kwCalls(odoo)).toEqual([
      { model: 'res.partner', method: 'search_read', args: [[['phone', 'in', ['+201001234567', '201001234567', '00201001234567']]]], kwargs: { fields: ['id', 'name'], limit: 1 } },
      { model: 'res.partner', method: 'create', args: [{ name: 'Mona', phone: '+201001234567' }], kwargs: {} },
    ]);
    const again = await make().call('find_or_create_partner', {}, ctxOf());
    expect(again).toEqual({ ok: true, result: { partnerId: (first as any).result.partnerId, name: 'Mona', created: false } });
    expect(JSON.stringify([first, again])).not.toContain('201001234567');
    expect(logText(logs)).not.toContain('1001234567');
    expect(logText(logs)).not.toContain(KEY);
  });

  it('create_sale_order: a draft quotation for the buyer, lines by id or code, duplicate-safe on the idempotency key', async () => {
    const { odoo } = world();
    odoo.partners.push({ id: 7, name: 'Mona', phone: '+201001234567' });
    const conn = make();
    const out = await conn.call('create_sale_order', { lines: [{ productId: 11, qty: 2 }, { code: 'TULIP-1', qty: 1 }] }, ctxOf({ idempotencyKey: 'idem-A' }));
    expect(out).toEqual({ ok: true, result: { orderName: 'S00001', total: 120, currency: 'EGP' } });
    const create = kwCalls(odoo).find((k) => k.model === 'sale.order' && k.method === 'create')!;
    expect(create.args).toEqual([{ partner_id: 7, client_order_ref: 'idem-A', order_line: [[0, 0, { product_id: 11, product_uom_qty: 2 }], [0, 0, { product_id: 12, product_uom_qty: 1 }]] }]);
    const again = await conn.call('create_sale_order', { lines: [{ productId: 11, qty: 2 }] }, ctxOf({ idempotencyKey: 'idem-A' }));
    expect(again).toEqual({ ok: true, result: { orderName: 'S00001', total: 120, duplicate: true } });
    expect(odoo.orders).toHaveLength(1);
    // the model cannot name a customer: an unknown argument is ignored, and a bad line is refused
    expect((await conn.call('create_sale_order', { partnerId: 999, lines: [{ productId: 11, code: 'X', qty: 1 }] }, ctxOf())).ok).toBe(false);
    expect(await conn.call('create_sale_order', { lines: [{ code: 'NOPE', qty: 1 }] }, ctxOf({ idempotencyKey: 'idem-B' }))).toEqual({ ok: false, error: 'not_found', message: 'unknown product code NOPE' });
    expect(odoo.orders).toHaveLength(1);
  });

  it('read_stock: by ids, codes or both', async () => {
    const { odoo } = world();
    const conn = make();
    expect(await conn.call('read_stock', { codes: ['ROSE-1', 'TULIP-1'] }, ctxOf())).toEqual({ ok: true, result: { items: [{ productId: 11, code: 'ROSE-1', name: 'Red roses', qtyAvailable: 24 }, { productId: 12, code: 'TULIP-1', name: 'Tulips', qtyAvailable: 0 }] } });
    await conn.call('read_stock', { ids: [11], codes: ['TULIP-1'] }, ctxOf());
    const last = kwCalls(odoo).at(-1)!;
    expect(last.args).toEqual([['|', ['id', 'in', [11]], ['default_code', 'in', ['TULIP-1']]]]);
    expect(await conn.call('read_stock', {}, ctxOf())).toEqual({ ok: false, error: 'invalid_arguments' });
    expect(await conn.call('read_stock', { ids: Array.from({ length: 11 }, (_, i) => i + 1) }, ctxOf())).toEqual({ ok: false, error: 'invalid_arguments' });
  });

  it('create_calendar_booking: UTC datetimes, buyer as attendee, duration or end, duplicate-safe', async () => {
    const { odoo } = world();
    odoo.partners.push({ id: 7, name: 'Mona', phone: '+201001234567' });
    const conn = make();
    const out = await conn.call('create_calendar_booking', { name: 'Table for 4', start: '2026-11-02T18:30:00+02:00', durationMinutes: 90 }, ctxOf());
    expect(out).toEqual({ ok: true, result: { eventId: expect.any(Number), start: '2026-11-02 16:30:00', stop: '2026-11-02 18:00:00', timeZone: 'UTC' } });
    expect(odoo.events[0]).toMatchObject({ name: 'Table for 4', start: '2026-11-02 16:30:00', stop: '2026-11-02 18:00:00', partner_ids: [[6, 0, [7]]] });
    expect(await conn.call('create_calendar_booking', { name: 'Table for 4', start: '2026-11-02T16:30:00Z' }, ctxOf())).toMatchObject({ ok: true, result: { duplicate: true } });
    expect(odoo.events).toHaveLength(1);
    const withEnd = await conn.call('create_calendar_booking', { name: 'Room', start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:15:00Z' }, ctxOf());
    expect(withEnd).toMatchObject({ ok: true, result: { stop: '2026-11-03 11:15:00' } });
    for (const bad of [{ name: 'x', start: '2026-11-02T18:30:00' }, { name: 'x', start: 'tomorrow' }, { name: 'x', start: '2026-11-03T10:00:00Z', end: '2026-11-03T09:00:00Z' }, { name: 'x', start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:00:00Z', durationMinutes: 30 }, { start: '2026-11-03T10:00:00Z' }]) {
      expect((await conn.call('create_calendar_booking', bad, ctxOf())).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(odoo.events).toHaveLength(2);
  });

  it('maps Odoo faults to clear tool errors and never forwards the debug trace', async () => {
    const { odoo } = world();
    const conn = make();
    odoo.partners.push({ id: 7, name: 'Mona', phone: '+201001234567' });
    const cases: [string, string, string, string | undefined][] = [
      ['odoo.exceptions.AccessError', 'You are not allowed to access Sales', 'access_denied', undefined],
      ['odoo.exceptions.ValidationError', 'The operation cannot be completed: price is missing', 'rejected', 'The operation cannot be completed: price is missing'],
      ['odoo.exceptions.UserError', 'Cannot create an order', 'rejected', 'Cannot create an order'],
      ['odoo.exceptions.MissingError', 'Record does not exist', 'not_found', undefined],
      ['builtins.KeyError', 'x', 'server_error', undefined],
    ];
    for (const [name, message, error, shown] of cases) {
      odoo.fault = { name, message };
      const out = await conn.call('read_stock', { ids: [11] }, ctxOf());
      expect(out, name).toEqual({ ok: false, error, ...(shown ? { message: shown } : {}) });
      expect(JSON.stringify(out)).not.toContain('Traceback');
    }
  });

  it('a wrong key is auth_failed (login returns false); a revoked key mid-flight clears the cached login', async () => {
    const { odoo } = world();
    expect(await make('test-secret-wrong-key-xx').call('read_stock', { ids: [11] }, ctxOf())).toEqual({ ok: false, error: 'auth_failed' });
    const conn = make();
    expect((await conn.call('read_stock', { ids: [11] }, ctxOf())).ok).toBe(true);
    const before = odoo.requests.filter((r) => r.method === 'authenticate').length;
    await conn.call('read_stock', { ids: [11] }, ctxOf());
    expect(odoo.requests.filter((r) => r.method === 'authenticate').length).toBe(before); // uid cached
    odoo.validKey = 'rotated';
    expect(await conn.call('read_stock', { ids: [11] }, ctxOf())).toEqual({ ok: false, error: 'auth_failed' });
  });

  it('is bound by the same transport rules: blocked hosts, redirects, timeouts, size', async () => {
    const odoo = new FakeOdoo();
    const c = stubClient((call, _n, _s) => (call.url.includes('redirect') ? { status: 302, text: '' } : odoo.handle(call)), HOST);
    const bad = odooConnector({ env: testEnv, workspaceId: 'ws-odoo', id: 'erp', config: { ...cfg, url: 'https://10.0.0.5' }, updatedAt: ++n, secret: async () => KEY });
    expect(await bad.call('read_stock', { ids: [1] }, ctxOf())).toEqual({ ok: false, error: 'blocked_host' });
    expect(c.calls).toHaveLength(0);
    c.graph.restore();
    stubClient(() => ({ status: 302, text: '' }), HOST);
    expect(await make().call('read_stock', { ids: [1] }, ctxOf())).toEqual({ ok: false, error: 'redirect' });
    stubClient(() => ({ text: 'x'.repeat(40_000) }), HOST);
    expect(await make().call('read_stock', { ids: [1] }, ctxOf())).toEqual({ ok: false, error: 'too_large' });
  });

  it('without the buyer number the partner tools say unavailable', async () => {
    world();
    expect(await make().call('find_or_create_partner', {}, ctxOf({ buyerPhone: () => null }))).toEqual({ ok: false, error: 'unavailable' });
  });
});

describe('POST /connectors/:id/test (odoo)', () => {
  it('asks for the version, logs in, and answers with a fixed result', async () => {
    const s = storeId(9321);
    const { call } = await apiFor(s);
    const { odoo } = world();
    expect((await call('PUT', '/connectors/erp', { kind: 'odoo', enabled: true, config: cfg, secret: KEY })).status).toBe(200);
    const res = await call('POST', '/connectors/erp/test');
    expect(await res.json()).toEqual({ ok: true, detail: '17.0' });
    expect(odoo.requests.map((r) => `${r.service}.${r.method}`)).toEqual(['common.version', 'common.authenticate']);
    odoo.validKey = 'rotated';
    const other = await apiFor(storeId(9322));
    await other.call('PUT', '/connectors/erp', { kind: 'odoo', enabled: true, config: cfg, secret: KEY });
    expect(await (await other.call('POST', '/connectors/erp/test')).json()).toEqual({ ok: false, error: 'auth_failed', detail: '17.0' });
  });
});
