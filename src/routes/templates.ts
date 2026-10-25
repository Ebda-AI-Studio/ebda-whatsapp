import { Hono } from 'hono';
import { z } from 'zod';
import type { listTemplatesResponse } from '../core/api/contract';
import { fetchTemplates, submitTemplate } from '../core/meta/templates-api';
import { componentsSchema } from '../core/templates';
import { activeNumber, apiError, bizToken, workspaceStub, type ApiContext, type ApiEnv } from './shared';

export const submitTemplateRequest = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().min(2).max(10),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  components: componentsSchema.min(1).refine((cs) => cs.some((c) => c.type.toUpperCase() === 'BODY'), 'a BODY component is required'),
});
export type TemplateSeed = z.input<typeof submitTemplateRequest>;

const canManage = (c: ApiContext) => c.get('storeRole') !== 'staff';

/** Template routes. `defaults` is the product's starter set (supplied by an addon, never imported here). */
export function templatesRoutes(defaults: readonly TemplateSeed[]) {
  const r = new Hono<ApiEnv>();

  r.get('/stores/:storeId/templates', async (c) => {
    const ws = await workspaceStub(c);
    if (!ws) return apiError(c, 404, 'not_found');
    const body: z.infer<typeof listTemplatesResponse> = { items: await ws.listTemplates() };
    return c.json(body);
  });

  r.post('/stores/:storeId/templates/sync', async (c) => {
    const ws = await workspaceStub(c);
    const number = await activeNumber(c);
    if (!ws || !number) return apiError(c, 404, 'not_found');
    const token = await bizToken(c, { wabaId: number.wabaId });
    if (!token) return apiError(c, 503, 'rate_limited', 'token_unavailable');
    const fetched = await fetchTemplates({ token, graphVersion: c.env.META_GRAPH_VERSION, wabaId: number.wabaId });
    if (!fetched.ok) return apiError(c, 503, 'rate_limited', fetched.message);
    return c.json(await ws.syncTemplates(fetched.value.map((t) => ({
      name: t.name, language: t.language, category: t.category, status: t.status, components: t.components, rejectedReason: t.rejected_reason ?? null,
    }))));
  });

  r.post('/stores/:storeId/templates', async (c) => {
    if (!canManage(c)) return apiError(c, 403, 'forbidden');
    const parsed = submitTemplateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 400, 'invalid_request');
    const ws = await workspaceStub(c);
    const number = await activeNumber(c);
    if (!ws || !number) return apiError(c, 404, 'not_found');
    const token = await bizToken(c, { wabaId: number.wabaId });
    if (!token) return apiError(c, 503, 'rate_limited', 'token_unavailable');
    const res = await submitTemplate({ token, graphVersion: c.env.META_GRAPH_VERSION, wabaId: number.wabaId }, parsed.data);
    if (!res.ok) return res.retryable ? apiError(c, 503, 'rate_limited', res.message) : apiError(c, 400, 'invalid_request', res.message);
    await ws.saveSubmittedTemplate({ ...parsed.data, status: res.value.status });
    return c.json({ name: parsed.data.name, language: parsed.data.language, status: res.value.status }, 201);
  });

  r.post('/stores/:storeId/templates/install-defaults', async (c) => {
    if (!canManage(c)) return apiError(c, 403, 'forbidden');
    const ws = await workspaceStub(c);
    const number = await activeNumber(c);
    if (!ws || !number) return apiError(c, 404, 'not_found');
    const token = await bizToken(c, { wabaId: number.wabaId });
    if (!token) return apiError(c, 503, 'rate_limited', 'token_unavailable');
    const out = { submitted: [] as string[], skipped: [] as string[], failed: [] as string[] };
    for (const seed of defaults) {
      const t = submitTemplateRequest.parse(seed);
      if (await ws.hasTemplate(t.name, t.language)) {
        out.skipped.push(t.name);
        continue;
      }
      const res = await submitTemplate({ token, graphVersion: c.env.META_GRAPH_VERSION, wabaId: number.wabaId }, t);
      if (!res.ok) {
        out.failed.push(t.name);
        continue;
      }
      await ws.saveSubmittedTemplate({ ...t, status: res.value.status });
      out.submitted.push(t.name);
    }
    return c.json(out);
  });

  return r;
}
