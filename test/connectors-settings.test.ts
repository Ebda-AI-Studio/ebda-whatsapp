import { describe, expect, it, vi } from 'vitest';
import { decryptSecret } from '../src/core/ai/secrets';
import { connectorDto } from '../src/core/api/contract';
import { validConnectorUrl } from '../src/core/connectors/net';
import { TEST_SECRETS_KEY, useAgent } from './helpers/agent';
import { SELF } from 'cloudflare:test';
import { apiFor, apiKey, storeId, useApiKey } from './helpers/api';
import { mint } from './helpers/issuer';
import { rows } from './helpers/workspace';

useApiKey();
useAgent();

const SECRET = 'test-secret-0123456789abcdef';
const tool = { name: 'check_booking', description: 'Look up a booking by its reference.', params: [{ name: 'reference', type: 'string' as const, required: true }] };
const webhook = (over: Record<string, unknown> = {}) => ({ kind: 'webhook', enabled: true, config: { url: 'https://hooks.acme-client.com/wa', tools: [tool] }, secret: SECRET, ...over });

describe('connector settings', () => {
  it('lists nothing at first, saves a webhook, and never returns the secret', async () => {
    const s = storeId(9301);
    const { call } = await apiFor(s);
    expect(await (await call('GET', '/connectors')).json()).toEqual([]);
    const put = await call('PUT', '/connectors/crm', webhook());
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain(SECRET);
    const dto = connectorDto.parse(JSON.parse(text));
    expect(dto).toMatchObject({ id: 'crm', kind: 'webhook', enabled: true, hasSecret: true, tools: ['crm__check_booking'] });
    const list = await (await call('GET', '/connectors')).text();
    expect(list).not.toContain(SECRET);
    expect(JSON.parse(list)).toHaveLength(1);
    const stored = (await rows<{ secret_enc: string }>(s, "SELECT secret_enc FROM connectors WHERE id = 'crm'"))[0]!.secret_enc;
    expect(stored).not.toContain(SECRET);
    expect(await decryptSecret(stored, TEST_SECRETS_KEY, s)).toBe(SECRET);
    expect(await decryptSecret(stored, TEST_SECRETS_KEY, storeId(9399))).toBeNull(); // bound to its workspace
  });

  it('WA-SECRETS-1: a super admin who is a member can READ connectors (status only, no secret) but never write, delete or test one', async () => {
    const s = storeId(9398);
    const owner = await apiFor(s);
    await owner.call('PUT', '/connectors/crm', webhook());
    const token = await mint(apiKey(), { pa: 'super_admin', stores: [{ id: s, role: 'owner' }] });
    const op = (method: string, path: string, body?: unknown) => SELF.fetch(`https://x/api/v1/stores/${s}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const read = await op('GET', '/connectors');
    expect(read.status).toBe(200);
    const text = await read.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject([{ id: 'crm', hasSecret: true }]);
    expect((await op('PUT', '/connectors/crm', webhook({ enabled: false }))).status).toBe(403);
    expect((await op('DELETE', '/connectors/crm')).status).toBe(403);
    expect((await op('POST', '/connectors/crm/test')).status).toBe(403);
    expect((await rows<{ enabled: number }>(s, "SELECT enabled FROM connectors WHERE id = 'crm'"))[0]!.enabled).toBe(1);
  });

  it('staff can neither read nor write nor delete nor test connectors', async () => {
    const s = storeId(9302);
    const owner = await apiFor(s);
    await owner.call('PUT', '/connectors/crm', webhook());
    const staff = await apiFor(s, 'staff');
    expect((await staff.call('GET', '/connectors')).status).toBe(403);
    expect((await staff.call('PUT', '/connectors/crm', webhook({ enabled: false }))).status).toBe(403);
    expect((await staff.call('DELETE', '/connectors/crm')).status).toBe(403);
    expect((await staff.call('POST', '/connectors/crm/test')).status).toBe(403);
    expect((await rows<{ enabled: number }>(s, "SELECT enabled FROM connectors WHERE id = 'crm'"))[0]!.enabled).toBe(1);
  });

  it('refuses unsafe hosts: http, IP literals, loopback, private, metadata, localhost, internal names, ports, credentials, query', async () => {
    const s = storeId(9303);
    const { call } = await apiFor(s);
    for (const url of ['http://hooks.acme-client.com/wa', 'https://127.0.0.1/wa', 'https://10.0.0.5/wa', 'https://169.254.169.254/latest', 'https://[::1]/wa', 'https://localhost/wa', 'https://db.internal/wa', 'https://hooks.acme-client.com:8443/wa', 'https://u:p@hooks.acme-client.com/wa', 'https://hooks.acme-client.com/wa?x=1', 'https://2130706433/wa', 'https://0x7f.1/wa', 'nonsense']) {
      const res = await call('PUT', '/connectors/crm', webhook({ config: { url, tools: [tool] } }));
      expect(res.status, url).toBe(400);
      expect(await res.json(), url).toMatchObject({ message: 'invalid_url' });
    }
    expect(await rows(s, 'SELECT 1 FROM connectors')).toEqual([]);
  });

  it('honours the operator allowlist when AGENT_ALLOWED_HOSTS is set', () => {
    expect(validConnectorUrl('https://hooks.acme-client.com/wa', [])).toBe('https://hooks.acme-client.com/wa');
    expect(validConnectorUrl('https://hooks.acme-client.com/wa', ['other-host.com'])).toBeNull();
    expect(validConnectorUrl('https://Hooks.Acme-Client.com./wa/', ['hooks.acme-client.com'])).toBe('https://hooks.acme-client.com/wa');
  });

  it('a change of host needs the secret entered again; the same host keeps it', async () => {
    const s = storeId(9304);
    const { call } = await apiFor(s);
    await call('PUT', '/connectors/crm', webhook());
    const moved = await call('PUT', '/connectors/crm', webhook({ secret: undefined, config: { url: 'https://evil-host.com/wa', tools: [tool] } }));
    expect(moved.status).toBe(400);
    expect(await moved.json()).toMatchObject({ message: 'secret_required' });
    const same = await call('PUT', '/connectors/crm', webhook({ secret: undefined, enabled: false, config: { url: 'https://hooks.acme-client.com/other', tools: [tool] } }));
    expect(same.status).toBe(200);
    expect(await same.json()).toMatchObject({ hasSecret: true, enabled: false });
    const fresh = await call('PUT', '/connectors/crm', webhook({ secret: 'test-secret-brand-new-value', config: { url: 'https://evil-host.com/wa', tools: [tool] } }));
    expect(fresh.status).toBe(200);
  });

  it('enabling needs a secret; the kind of an existing connector cannot change; the number of connectors is bounded', async () => {
    const s = storeId(9305);
    const { call } = await apiFor(s);
    expect(await (await call('PUT', '/connectors/crm', webhook({ secret: undefined }))).json()).toMatchObject({ message: 'secret_required' });
    expect((await call('PUT', '/connectors/crm', webhook({ secret: undefined, enabled: false }))).status).toBe(200);
    const odoo = { kind: 'odoo', enabled: false, config: { url: 'https://erp.acme-client.com', database: 'prod', login: 'bot@acme-client.com' } };
    expect(await (await call('PUT', '/connectors/crm', odoo)).json()).toMatchObject({ message: 'kind_mismatch' });
    for (const id of ['a', 'b', 'c', 'd']) expect((await call('PUT', `/connectors/${id}`, odoo)).status).toBe(200);
    expect(await (await call('PUT', '/connectors/e', odoo)).json()).toMatchObject({ message: 'too_many_connectors' });
  });

  it('validates the body at the edge: ids, tool names, parameter types, limits', async () => {
    const s = storeId(9306);
    const { call } = await apiFor(s);
    const cfg = (t: Record<string, unknown>) => webhook({ config: { url: 'https://hooks.acme-client.com/wa', tools: [{ ...tool, ...t }] } });
    const bad: [string, unknown][] = [
      ['/connectors/Bad_Id', webhook()],
      ['/connectors/crm', cfg({ name: 'Has Space' })],
      ['/connectors/crm', cfg({ name: 'a__b' })],
      ['/connectors/crm', cfg({ params: [{ name: 'x', type: 'object' }] })],
      ['/connectors/crm', cfg({ params: [{ name: 'x', type: 'enum' }] })],
      ['/connectors/crm', cfg({ params: [{ name: 'x', type: 'string', values: ['a'] }] })],
      ['/connectors/crm', cfg({ params: [{ name: 'x', type: 'string' }, { name: 'x', type: 'number' }] })],
      ['/connectors/crm', cfg({ description: 'x'.repeat(301) })],
      ['/connectors/crm', webhook({ config: { url: 'https://hooks.acme-client.com/wa', tools: Array.from({ length: 11 }, (_, i) => ({ ...tool, name: `t${i}` })) } })],
      ['/connectors/crm', webhook({ secret: 'short' })],
      ['/connectors/crm', { kind: 'ftp' }],
    ];
    for (const [path, body] of bad) expect((await call('PUT', path, body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    expect((await call('PUT', '/connectors/crm', 'null')).status).toBe(400);
    expect(await rows(s, 'SELECT 1 FROM connectors')).toEqual([]);
  });

  it('deletes a connector and its secret; the secret and settings never reach the logs', async () => {
    const s = storeId(9307);
    const { call } = await apiFor(s);
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    await call('PUT', '/connectors/crm', webhook());
    expect((await call('DELETE', '/connectors/crm')).status).toBe(200);
    expect((await call('DELETE', '/connectors/crm')).status).toBe(404);
    expect(await rows(s, 'SELECT 1 FROM connectors')).toEqual([]);
    expect(logs.flatMap((l) => l.mock.calls).map((c) => JSON.stringify(c)).join('\n')).not.toContain(SECRET);
  });

  it('is part of the nightly backup', async () => {
    const { BACKUP_TABLES } = await import('../src/core/backup');
    expect(BACKUP_TABLES).toContain('connectors');
  });
});
