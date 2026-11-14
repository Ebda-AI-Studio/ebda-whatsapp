import { SELF } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { refreshPending, type TemplatesCtx } from '../src/core/templates-service';
import { env } from 'cloudflare:test';
import { graphStub, storeId as W, useApiKey, apiFor } from './helpers/api';
import type { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { templateStatusPayload } from './helpers/payload';
import { exec, rows, seedNumber, workspace } from './helpers/workspace';
import { listTemplatesResponse } from '../src/core/api/contract';

useApiKey();
let graph: ReturnType<typeof stubGraph> | undefined;
afterEach(() => graph?.restore());
const HOUR = 3_600_000;

async function setup(n: number, waba = `waba-st-${n}`) {
  const id = W(n);
  await seedNumber(`pn-st-${n}`, id, 'active', waba);
  const ctx: TemplatesCtx = { env, ws: workspace(id), workspaceId: id, number: { phoneNumberId: `pn-st-${n}`, wabaId: waba } };
  return { id, ctx, waba };
}
const meta = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'meta-1', name: 'late', language: 'ar', category: 'UTILITY', status, components: [], ...extra });

it('a status webhook that arrives BEFORE our save leaves a PENDING row that the sweep fixes to APPROVED', async () => {
  const { id, ctx, waba } = await setup(500);
  // 1. Meta's webhook beats our own save: there is no row yet, so it is ignored.
  expect((await postWebhook(SELF, templateStatusPayload(waba, { event: 'APPROVED', name: 'late', language: 'ar' }))).status).toBe(200);
  expect(await rows(id, 'SELECT 1 FROM templates')).toEqual([]);
  // 2. our save lands afterwards as PENDING
  await ctx.ws.saveSubmittedTemplate({ name: 'late', language: 'ar', category: 'UTILITY', status: 'PENDING', components: [], metaId: 'meta-1', label: null });
  await exec(id, 'UPDATE templates SET updated_at = 1');
  // 3. the sweep asks Meta and the row becomes APPROVED
  graph = graphStub(() => ({ status: 200, json: { data: [meta('APPROVED')] } }));
  expect(await refreshPending(ctx, HOUR)).toEqual({ ok: true, checked: 1, updated: 1 });
  expect(await rows(id, 'SELECT status, rejected_reason FROM templates')).toEqual([{ status: 'APPROVED', rejected_reason: null }]);
});

it('the sweep leaves a recent PENDING row alone and never calls Meta for it', async () => {
  const { ctx } = await setup(501);
  await ctx.ws.saveSubmittedTemplate({ name: 'late', language: 'ar', category: 'UTILITY', status: 'PENDING', components: [], metaId: 'meta-1', label: null });
  graph = graphStub(() => ({ status: 200, json: { data: [meta('APPROVED')] } }));
  expect(await refreshPending(ctx, HOUR)).toEqual({ ok: true, checked: 0, updated: 0 });
  expect(graph.calls.filter((c) => c.url.includes('message_templates'))).toEqual([]);
});

it('a submitted template schedules the sweep on the DO alarm, which asks Meta once it is stale and applies the answer', async () => {
  const { id, ctx } = await setup(502);
  await ctx.ws.saveSubmittedTemplate({ name: 'late', language: 'ar', category: 'UTILITY', status: 'PENDING', components: [], metaId: 'meta-1', label: null });
  expect(await rows(id, "SELECT kind FROM scheduled_tasks WHERE kind = 'template_refresh'")).toEqual([{ kind: 'template_refresh' }]);
  graph = graphStub(() => ({ status: 200, json: { data: [meta('REJECTED', { rejected_reason: 'INVALID_FORMAT' })] } }));
  await ctx.ws.runDueTasks(Date.now() + 2 * HOUR);
  expect(await rows(id, 'SELECT status, rejected_reason FROM templates')).toEqual([{ status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' }]);
  expect(await rows(id, "SELECT 1 FROM scheduled_tasks WHERE kind = 'template_refresh'")).toEqual([]); // nothing PENDING any more: no polling continues
});

it('a webhook for an unknown template is still ignored and does not throw', async () => {
  const { waba } = await setup(503);
  expect((await postWebhook(SELF, templateStatusPayload(waba, { event: 'APPROVED', name: 'nobody', language: 'ar' }))).status).toBe(200);
});

it('PENDING_DELETION marks the status and removes nothing', async () => {
  const { id, ctx, waba } = await setup(504);
  await ctx.ws.saveSubmittedTemplate({ name: 'late', language: 'ar', category: 'UTILITY', status: 'APPROVED', components: [], metaId: 'meta-1', label: null });
  await postWebhook(SELF, templateStatusPayload(waba, { event: 'PENDING_DELETION', name: 'late', language: 'ar' }));
  expect(await rows(id, 'SELECT status FROM templates')).toEqual([{ status: 'PENDING_DELETION' }]);
});

it('webhook reason NONE is stored as no reason, and the webhook carries the Meta template id', async () => {
  const { id, ctx, waba } = await setup(505);
  await ctx.ws.saveSubmittedTemplate({ name: 'late', language: 'ar', category: 'UTILITY', status: 'PENDING', components: [], metaId: null, label: null });
  await postWebhook(SELF, templateStatusPayload(waba, { event: 'REJECTED', name: 'late', language: 'ar', reason: 'NONE' }));
  expect(await rows(id, 'SELECT status, rejected_reason, meta_id FROM templates')).toEqual([{ status: 'REJECTED', rejected_reason: null, meta_id: '1' }]);
});

it('the list carries plain advice for a rejected template', async () => {
  const api = await apiFor(W(506));
  await exec(W(506), "INSERT INTO templates (name, language, category, status, components, rejected_reason, updated_at) VALUES ('r', 'ar', 'UTILITY', 'REJECTED', '[]', 'INVALID_FORMAT', 1), ('ok', 'ar', 'UTILITY', 'APPROVED', '[]', NULL, 1)");
  const list = listTemplatesResponse.parse(await (await api.call('GET', '/templates')).json());
  const byName = Object.fromEntries(list.items.map((t) => [t.name, t]));
  expect(byName.r!.advice).toMatchObject({ kind: 'format', ar: expect.stringContaining('متغيّر') });
  expect(byName.r!.rejectedReason).toBe('INVALID_FORMAT'); // the raw code is still there
  expect(byName.ok!.advice).toBeUndefined();
});
