import { afterEach, describe, expect, it } from 'vitest';
import { apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
import type { stubGraph } from './helpers/graph';
import { deliver, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, rows } from './helpers/workspace';

useApiKey();
useStoreLink();
let graph: ReturnType<typeof stubGraph> | undefined;
afterEach(() => graph?.restore());

const ORIGIN = 'https://souq.ebda.app';
const posts = () => graph!.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/message_templates'));
const linked = (ws: string, extra: Record<string, unknown> = { storefrontOrigin: ORIGIN }) => storeEvent(ws, 'store.linked', { ownerUserId: 'u', ...extra });
/** A tiny Meta: lists what was submitted (so a sync keeps it), accepts a submission as PENDING, accepts a delete. */
const answer = () => {
  const have: { id: string; name: string; language: string; category: string; status: string; components: unknown }[] = [];
  return graphStub((c) => {
    if (c.method === 'GET') return { status: 200, json: { data: have } };
    if (c.method === 'DELETE') return { status: 200, json: { success: true } };
    const b = c.body as { name: string; language: string; category: string; components: unknown };
    have.push({ id: `m-${have.length + 1}`, name: b.name, language: b.language, category: b.category, status: 'PENDING', components: b.components });
    return { status: 200, json: { id: `m-${have.length}`, status: 'PENDING', category: 'UTILITY' } };
  });
};
const v2Rows = (ws: string) => rows<{ status: string }>(ws, "SELECT status FROM templates WHERE name = 'cod_confirmation_v2'");

describe('COD v2 per-store submission (Ruling WA-COD-V2-2)', () => {
  it('store.linked with an origin submits cod_confirmation_v2 with that store\'s URL base; it stays PENDING (approval never assumed)', async () => {
    const ws = W(200);
    await storeWorkspace(ws, { templates: false });
    graph = answer();
    await deliver([linked(ws)]);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toMatchObject({ name: 'cod_confirmation_v2', language: 'ar', category: 'UTILITY' });
    const buttons = (posts()[0]!.body as { components: { type: string; buttons?: { type: string; url?: string; text: string }[] }[] }).components.find((c) => c.type === 'BUTTONS')!.buttons!;
    expect(buttons.map((b) => b.type)).toEqual(['URL', 'QUICK_REPLY', 'QUICK_REPLY']);
    expect(buttons[0]!.url).toBe(`${ORIGIN}/o/{{1}}`);
    expect(await v2Rows(ws)).toEqual([{ status: 'PENDING' }]);
  });

  it('is idempotent: a second store.linked (new envelope id) or a redelivery submits nothing more', async () => {
    const ws = W(201);
    await storeWorkspace(ws, { templates: false });
    graph = answer();
    await deliver([linked(ws)]);
    await deliver([linked(ws)]);
    await deliver([linked(ws)], 2);
    expect(posts()).toHaveLength(1);
  });

  it('a link without an origin (older Store) submits nothing', async () => {
    const ws = W(202);
    await storeWorkspace(ws, { templates: false });
    graph = answer();
    await deliver([linked(ws, {})]);
    expect(posts()).toHaveLength(0);
  });

  it('a REJECTED v2 is shown with its status and the resubmit action replaces it; an APPROVED one is left alone', async () => {
    const ws = W(203);
    const api = await apiFor(ws);
    await exec(ws, "INSERT OR REPLACE INTO store_state (key, value) VALUES ('storefront_origin', ?)", ORIGIN);
    await exec(ws, "INSERT INTO templates (name, language, category, status, components, updated_at, meta_id, rejected_reason) VALUES ('cod_confirmation_v2', 'ar', 'UTILITY', 'REJECTED', '[]', 1, 'm-old', 'INVALID_FORMAT')");
    const have = [{ id: 'm-old', name: 'cod_confirmation_v2', language: 'ar', category: 'UTILITY', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', components: [{ type: 'BODY', text: 'x' }] }];
    graph = graphStub((c) => {
      if (c.method === 'GET') return { status: 200, json: { data: have } };
      if (c.method === 'DELETE') { have.length = 0; return { status: 200, json: { success: true } }; }
      have.push({ id: 'm-new', name: 'cod_confirmation_v2', language: 'ar', category: 'UTILITY', status: 'PENDING', rejected_reason: '', components: [{ type: 'BODY', text: 'x' }] });
      return { status: 200, json: { id: 'm-new', status: 'PENDING', category: 'UTILITY' } };
    });
    const list = (await (await api.call('GET', '/templates')).json()) as { items: { name: string; status: string }[] };
    expect(list.items.find((t) => t.name === 'cod_confirmation_v2')?.status).toBe('REJECTED');
    const res = await api.call('POST', '/templates/cod-v2/resubmit');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'submitted' });
    expect(graph.calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(await v2Rows(ws)).toEqual([{ status: 'PENDING' }]);
    have[0]!.status = 'APPROVED';
    await exec(ws, "UPDATE templates SET status = 'APPROVED' WHERE name = 'cod_confirmation_v2'");
    const again = await api.call('POST', '/templates/cod-v2/resubmit');
    expect(await again.json()).toEqual({ status: 'exists' });
    expect(posts()).toHaveLength(1);
  });

  it('resubmit needs a manager and a known store origin', async () => {
    const ws = W(204);
    const api = await apiFor(ws);
    const staff = await apiFor(ws, 'staff');
    expect((await staff.call('POST', '/templates/cod-v2/resubmit')).status).toBe(403);
    graph = answer();
    expect((await api.call('POST', '/templates/cod-v2/resubmit')).status).toBe(409);
  });
});
