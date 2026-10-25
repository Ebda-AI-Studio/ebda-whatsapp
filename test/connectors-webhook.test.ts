import { describe, expect, it } from 'vitest';
import type { WebhookConfig } from '../src/core/api/contract';
import { CONNECTOR_MAX_BYTES } from '../src/core/connectors/net';
import { toolContent } from '../src/core/connectors/registry';
import { webhookConnector } from '../src/core/connectors/webhook';
import { useAgent } from './helpers/agent';
import { apiFor, storeId, useApiKey } from './helpers/api';
import { ctxOf, hangs, hmacHex, logText, spyLogs, stubClient, testEnv } from './helpers/connectors';

useApiKey();
useAgent();

const SECRET = 'test-secret-0123456789abcdef';
const config = (over: Partial<WebhookConfig> = {}): WebhookConfig => ({
  url: 'https://hooks.acme-client.com/wa',
  tools: [{
    name: 'check_booking', description: 'Look up a booking.',
    params: [{ name: 'reference', type: 'string', required: true, maxLength: 12 }, { name: 'kind', type: 'enum', values: ['room', 'table'] }, { name: 'guests', type: 'number', min: 1, max: 20 }, { name: 'vip', type: 'boolean' }],
  }],
  ...over,
});
const make = (cfg = config(), secret: string | null = SECRET) => webhookConnector({ env: testEnv, id: 'crm', config: cfg, secret: async () => secret });

describe('webhook connector', () => {
  it('declares its tools as JSON schema limited to string/number/boolean/enum', () => {
    const [t] = make().tools;
    expect(t).toEqual({
      name: 'check_booking', description: 'Look up a booking.',
      parameters: { type: 'object', properties: { reference: { type: 'string', maxLength: 12 }, kind: { type: 'string', enum: ['room', 'table'] }, guests: { type: 'number', minimum: 1, maximum: 20 }, vip: { type: 'boolean' } }, required: ['reference'] },
    });
  });

  it('POSTs the documented body with a signature a client can verify, and hands the result back', async () => {
    const c = stubClient(() => ({ json: { ok: true, result: { status: 'confirmed' } } }));
    const ctx = ctxOf();
    const out = await make().call('check_booking', { reference: 'AB12', kind: 'room', extra: 'dropped' }, ctx);
    expect(out).toEqual({ ok: true, result: { status: 'confirmed' } });
    expect(c.calls).toHaveLength(1);
    const call = c.calls[0]!;
    expect(call.url).toBe('https://hooks.acme-client.com/wa');
    expect(call.json).toEqual({ event: 'tool_call', tool: 'check_booking', args: { reference: 'AB12', kind: 'room' }, workspaceId: 'ws-1', conversationId: 7, buyerKey: ctx.buyerKey, idempotencyKey: 'idem-1', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(call.headers['idempotency-key']).toBe('idem-1');
    expect(call.headers['x-signature']).toBe(`sha256=${await hmacHex(SECRET, `${call.headers['x-timestamp']}.${call.raw}`)}`);
    expect(Math.abs(Number(call.headers['x-timestamp']) - Date.now() / 1000)).toBeLessThan(30);
    expect(call.raw).not.toContain('201001234567'); // never the phone number
  });

  it('refuses bad arguments before any request leaves', async () => {
    const c = stubClient(() => ({ json: { ok: true } }));
    for (const args of [{}, { reference: 'x'.repeat(13) }, { reference: 'A', kind: 'suite' }, { reference: 'A', guests: 99 }, { reference: 'A', vip: 'yes' }, { reference: 'A', guests: Number.NaN }]) {
      expect(await make().call('check_booking', args, ctxOf()), JSON.stringify(args)).toEqual({ ok: false, error: 'invalid_arguments' });
    }
    expect(await make().call('nope', {}, ctxOf())).toEqual({ ok: false, error: 'unknown_tool' });
    expect(c.calls).toHaveLength(0);
  });

  it('a host that is no longer allowed is refused on the call itself (the check runs every time)', async () => {
    const c = stubClient(() => ({ json: { ok: true } }));
    for (const url of ['http://hooks.acme-client.com/wa', 'https://127.0.0.1/wa', 'https://10.1.2.3/wa', 'https://169.254.169.254/x', 'https://[::1]/wa', 'https://localhost/wa', 'https://db.internal/wa']) {
      expect(await make(config({ url })).call('check_booking', { reference: 'A' }, ctxOf()), url).toEqual({ ok: false, error: 'blocked_host' });
    }
    expect(c.calls).toHaveLength(0);
  });

  it('a redirect is an error and is not followed', async () => {
    const c = stubClient(() => ({ status: 302, headers: { location: 'https://169.254.169.254/latest' }, text: '' }));
    expect(await make().call('check_booking', { reference: 'A' }, ctxOf())).toEqual({ ok: false, error: 'redirect' });
    expect(c.calls).toHaveLength(1);
  });

  it('times out with a tool error, and does not retry', async () => {
    const c = stubClient((_c, _n, signal) => hangs(signal));
    const out = await make().call('check_booking', { reference: 'A' }, ctxOf({ deadline: Date.now() + 60 }));
    expect(out).toEqual({ ok: false, error: 'timeout' });
    expect(c.calls).toHaveLength(1);
  });

  it('an already-passed deadline makes no request at all', async () => {
    const c = stubClient(() => ({ json: { ok: true } }));
    expect(await make().call('check_booking', { reference: 'A' }, ctxOf({ deadline: Date.now() - 1 }))).toEqual({ ok: false, error: 'timeout' });
    expect(c.calls).toHaveLength(0);
  });

  it('oversized, non-JSON or wrongly shaped answers and error statuses are tool errors (one attempt each)', async () => {
    const cases: [string, Parameters<typeof stubClient>[0], string][] = [
      ['oversize body', () => ({ text: JSON.stringify({ ok: true, result: 'x'.repeat(CONNECTOR_MAX_BYTES) }) }), 'too_large'],
      ['declared oversize', () => ({ text: '{"ok":true}', headers: { 'content-length': String(CONNECTOR_MAX_BYTES + 1) } }), 'too_large'],
      ['not json', () => ({ text: '<html>oops</html>' }), 'bad_response'],
      ['wrong shape', () => ({ json: { result: 1 } }), 'bad_response'],
      ['ok not boolean', () => ({ json: { ok: 'yes' } }), 'bad_response'],
      ['500', () => ({ status: 500, json: { ok: true } }), 'http_error'],
      ['404', () => ({ status: 404, json: { ok: true } }), 'http_error'],
    ];
    for (const [name, handler, error] of cases) {
      const c = stubClient(handler);
      expect(await make().call('check_booking', { reference: 'A' }, ctxOf()), name).toEqual({ ok: false, error });
      expect(c.calls, name).toHaveLength(1);
      c.graph.restore();
    }
  });

  it('a network failure is a tool error', async () => {
    stubClient(() => { throw new TypeError('connection refused'); });
    expect(await make().call('check_booking', { reference: 'A' }, ctxOf())).toEqual({ ok: false, error: 'network' });
  });

  it('ok:false from the client is a rejection with a bounded message', async () => {
    stubClient(() => ({ json: { ok: false, message: 'no such booking '.repeat(60) } }));
    const out = await make().call('check_booking', { reference: 'A' }, ctxOf());
    expect(out).toMatchObject({ ok: false, error: 'rejected' });
    expect((out as { message: string }).message.length).toBeLessThanOrEqual(300);
  });

  it('without a secret nothing is sent', async () => {
    const c = stubClient(() => ({ json: { ok: true } }));
    expect(await make(config(), null).call('check_booking', { reference: 'A' }, ctxOf())).toEqual({ ok: false, error: 'unavailable' });
    expect(c.calls).toHaveLength(0);
  });

  it('what the model reads back is bounded', () => {
    const big = toolContent({ ok: true, result: { text: 'y'.repeat(10_000) } });
    expect(big.length).toBeLessThanOrEqual(3100);
    expect(JSON.parse(big)).toMatchObject({ truncated: true });
    expect(toolContent({ ok: false, error: 'timeout' })).toBe('{"ok":false,"error":"timeout"}');
  });
});

describe('POST /connectors/:id/test (webhook)', () => {
  it('sends a signed ping, answers with a fixed result, and throttles repeats', async () => {
    const s = storeId(9311);
    const { call } = await apiFor(s);
    const c = stubClient(() => ({ json: { ok: true } }));
    const logs = spyLogs();
    expect((await call('PUT', '/connectors/crm', { kind: 'webhook', enabled: true, config: config(), secret: SECRET })).status).toBe(200);
    const res = await call('POST', '/connectors/crm/test');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const ping = c.calls[0]!;
    expect(ping.json).toMatchObject({ event: 'ping', workspaceId: s });
    expect(ping.headers['x-signature']).toBe(`sha256=${await hmacHex(SECRET, `${ping.headers['x-timestamp']}.${ping.raw}`)}`);
    expect((await call('POST', '/connectors/crm/test')).status).toBe(429);
    expect(c.calls).toHaveLength(1);
    expect((await call('POST', '/connectors/ghost/test')).status).toBe(404);
    expect(logText(logs)).not.toContain(SECRET);
  });

  it('reports a failure as a code, never a body', async () => {
    const s = storeId(9312);
    const { call } = await apiFor(s);
    stubClient(() => ({ status: 500, text: 'stack trace with test-secret-0123456789abcdef inside' }));
    await call('PUT', '/connectors/crm', { kind: 'webhook', enabled: false, config: config(), secret: SECRET });
    const res = await call('POST', '/connectors/crm/test');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'http_error', detail: '500' });
    expect(text).not.toContain('stack');
  });
});
