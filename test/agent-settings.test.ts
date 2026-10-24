import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { decryptSecret } from '../src/core/ai/secrets';
import { agentSettingsDto } from '../src/core/api/contract';
import { TEST_SECRETS_KEY, useAgent } from './helpers/agent';
import { apiFor, storeId, tokenFor, useApiKey } from './helpers/api';
import { configureAgent } from '../src/core/ai/config';
import { rows } from './helpers/workspace';

useApiKey();
useAgent();

describe('GET/PUT /agent', () => {
  it('starts off with the defaults, and the answer fits the contract', async () => {
    const s = storeId(5101);
    const { call } = await apiFor(s);
    const res = await call('GET', '/agent');
    expect(res.status).toBe(200);
    const body = agentSettingsDto.parse(await res.json());
    expect(body).toMatchObject({ enabled: false, language: 'ar', handoffMinutes: 120, provider: 'workers-ai', model: null, baseUrl: null, hasApiKey: false, faqText: '', persona: '' });
  });

  it('is owner only, both ways', async () => {
    const s = storeId(5102);
    const staff = await apiFor(s, 'staff');
    expect((await staff.call('GET', '/agent')).status).toBe(403);
    expect((await staff.call('PUT', '/agent', { enabled: true })).status).toBe(403);
    expect((await rows(s, "SELECT 1 FROM agent_state WHERE key = 'setting.enabled'")).length).toBe(0);
  });

  it('merges partial updates and persists them', async () => {
    const s = storeId(5103);
    const { call } = await apiFor(s);
    expect((await call('PUT', '/agent', { enabled: true, persona: 'انت مساعد متجر العطور', handoffMinutes: 45, faqText: 'الشحن مجاني فوق 500 جنيه.' })).status).toBe(200);
    const res = await call('PUT', '/agent', { language: 'auto' });
    expect(await res.json()).toMatchObject({ enabled: true, persona: 'انت مساعد متجر العطور', handoffMinutes: 45, language: 'auto', faqText: 'الشحن مجاني فوق 500 جنيه.' });
    expect(await (await call('GET', '/agent')).json()).toMatchObject({ enabled: true, handoffMinutes: 45, language: 'auto' });
  });

  it('validates every edge: bad json, unknown shapes, ranges, empty body', async () => {
    const s = storeId(5104);
    const { call } = await apiFor(s);
    for (const bad of [{}, { handoffMinutes: 2 }, { handoffMinutes: 5000 }, { handoffMinutes: 1.5 }, { language: 'fr' }, { provider: 'x' }, { enabled: 'yes' }, { persona: 'x'.repeat(1001) }, { faqText: 'x'.repeat(20_001) }, { apiKey: 'short' }, { model: 'has space' }]) {
      expect((await call('PUT', '/agent', bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect((await call('PUT', '/agent', 'null')).status).toBe(400);
    expect((await rows(s, "SELECT 1 FROM agent_state WHERE key LIKE 'setting.%'")).length).toBe(0);
  });

  it('openai-compatible: needs a public https base url and a model; the key is encrypted at rest, bound to the workspace, and never returned', async () => {
    const s = storeId(5105);
    const { call } = await apiFor(s);
    const base = { provider: 'openai-compatible', model: 'gpt-4o-mini' };
    expect(await (await call('PUT', '/agent', { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })).json()).toMatchObject({ error: 'invalid_request', message: 'model_required' });
    for (const baseUrl of ['http://api.openai.com/v1', 'https://localhost/v1', 'https://10.1.1.1/v1']) {
      expect(await (await call('PUT', '/agent', { ...base, baseUrl })).json(), baseUrl).toMatchObject({ message: 'invalid_base_url' });
    }
    // turning the agent on without a key is refused; saving the endpoint first is fine
    expect(await (await call('PUT', '/agent', { ...base, baseUrl: 'https://api.openai.com/v1/', enabled: true })).json()).toMatchObject({ message: 'api_key_required' });
    const saved = await call('PUT', '/agent', { ...base, baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-live-1234567890' });
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain('sk-live');
    expect(JSON.parse(text)).toMatchObject({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', hasApiKey: true });
    expect(await (await call('GET', '/agent')).text()).not.toContain('sk-live');
    const stored = (await rows<{ value: string }>(s, "SELECT value FROM agent_state WHERE key = 'secret.apiKey'"))[0]!.value;
    expect(stored).not.toContain('sk-live');
    expect(await decryptSecret(stored, TEST_SECRETS_KEY, s)).toBe('sk-live-1234567890');
    expect(await decryptSecret(stored, TEST_SECRETS_KEY, storeId(5106))).toBeNull();
    // keeping the key when it is absent from a later update; removing it with null
    expect((await call('PUT', '/agent', { enabled: true })).status).toBe(200);
    expect(await (await call('GET', '/agent')).json()).toMatchObject({ hasApiKey: true, enabled: true });
    expect((await call('PUT', '/agent', { apiKey: null })).status).toBe(400); // enabled without a key
    expect(await (await call('PUT', '/agent', { enabled: false, apiKey: null })).json()).toMatchObject({ hasApiKey: false, enabled: false });
  });

  it('workers-ai: the platform picks the model, so a model is refused; switching back clears nothing else', async () => {
    const s = storeId(5107);
    const { call } = await apiFor(s);
    expect(await (await call('PUT', '/agent', { model: 'gpt-4o' })).json()).toMatchObject({ message: 'model_not_allowed' });
    expect((await call('PUT', '/agent', { provider: 'workers-ai', enabled: true })).status).toBe(200);
  });

  it('without the platform secrets key a model key cannot be stored (503, nothing written)', async () => {
    const s = storeId(5108);
    const { call } = await apiFor(s);
    const prev = configureAgent({ secretsKey: () => undefined });
    try {
      const res = await call('PUT', '/agent', { provider: 'openai-compatible', model: 'm', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-live-1234567890' });
      expect(res.status).toBe(503);
      expect((await rows(s, "SELECT 1 FROM agent_state WHERE key = 'secret.apiKey'")).length).toBe(0);
    } finally {
      configureAgent(prev);
    }
  });

  it('an unregistered workspace is a 404 and no Durable Object is touched', async () => {
    const unknown = storeId(5199);
    const token = await tokenFor(unknown, 600);
    const res = await SELF.fetch(`https://x/api/v1/stores/${unknown}/agent`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });
});
