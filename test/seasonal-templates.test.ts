import { afterEach, expect, it } from 'vitest';
import { EBDA_RAMADAN_TEMPLATES, EBDA_DEFAULT_TEMPLATES } from '../src/addons/ebda/templates';
import { checkTemplate } from '../src/core/meta/template-rules';
import { fromStoredComponents } from '../src/core/template-draft';
import { apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
import type { stubGraph } from './helpers/graph';
import { exec, rows } from './helpers/workspace';

useApiKey();
let graph: ReturnType<typeof stubGraph> | undefined;
afterEach(() => graph?.restore());
const submits = () => graph!.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/message_templates'));

it('the Ramadan pack: three MARKETING Arabic templates, unique names that do not collide with the starter set, and every one passes Meta\'s rules', () => {
  expect(EBDA_RAMADAN_TEMPLATES.map((t) => t.name)).toEqual(['ramadan_greeting', 'ramadan_offer', 'ramadan_hours']);
  for (const t of EBDA_RAMADAN_TEMPLATES) {
    expect(t.category).toBe('MARKETING');
    expect(EBDA_DEFAULT_TEMPLATES.some((d) => d.name === t.name)).toBe(false);
    const draft = fromStoredComponents(t.components as never, { name: t.name, language: t.language, category: t.category, label: t.name });
    expect(checkTemplate(draft).filter((i) => i.severity === 'error').map((i) => i.code), t.name).toEqual([]);
  }
});

it('install-seasonal submits the three Ramadan templates, skips one the merchant already has, and sends nothing to a customer', async () => {
  const api = await apiFor(W(9601));
  await exec(W(9601), "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('ramadan_offer', 'ar', 'MARKETING', 'APPROVED', '[]', 1)");
  graph = graphStub(() => ({ status: 200, json: { id: '9', status: 'PENDING' } }));
  const res = await api.call('POST', '/templates/install-seasonal', { pack: 'ramadan' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ submitted: ['ramadan_greeting', 'ramadan_hours'], skipped: ['ramadan_offer'], failed: [] });
  expect(submits()).toHaveLength(2);
  expect(graph.calls.some((c) => c.url.endsWith('/messages'))).toBe(false);
  const stored = await rows<{ name: string; status: string }>(W(9601), "SELECT name, status FROM templates WHERE name LIKE 'ramadan_%' ORDER BY name");
  expect(stored.map((r) => r.name)).toEqual(['ramadan_greeting', 'ramadan_hours', 'ramadan_offer']);
});

it('staff are refused, an unknown pack and extra keys are 400, and nothing reaches Meta', async () => {
  const staff = await apiFor(W(9602), 'staff');
  graph = graphStub(() => ({ status: 200, json: { id: '9', status: 'PENDING' } }));
  expect((await staff.call('POST', '/templates/install-seasonal', { pack: 'ramadan' })).status).toBe(403);
  const owner = await apiFor(W(9602), 'owner');
  expect((await owner.call('POST', '/templates/install-seasonal', { pack: 'eid' })).status).toBe(400);
  expect((await owner.call('POST', '/templates/install-seasonal', { pack: 'ramadan', extra: 1 })).status).toBe(400);
  expect((await owner.call('POST', '/templates/install-seasonal')).status).toBe(400);
  expect(submits()).toHaveLength(0);
});
