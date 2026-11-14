import { Hono } from 'hono';
import { z } from 'zod';
import { checkTemplateResponse, createTemplateResponse, editTemplateResponse, listTemplatesResponse, templateDraftRequest, type TemplateDto } from '../core/api/contract';
import { fromStoredComponents, type TemplateDraft } from '../core/template-draft';
import { checkOnly, createTemplate, deleteTemplate, editTemplate, installDefaults, syncTemplates, type Failure, type TemplatesCtx } from '../core/templates-service';
import { componentsSchema } from '../core/templates';
import { activeNumber, apiError, workspaceStub, type ApiContext, type ApiEnv, managesStore } from './shared';

/** The first shape of POST /templates (Meta components as they are). Still accepted: it is converted to a draft and goes through the same gate. */
export const submitTemplateRequest = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().min(2).max(10),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  components: componentsSchema.min(1).refine((cs) => cs.some((c) => c.type.toUpperCase() === 'BODY'), 'a BODY component is required'),
});
export type TemplateSeed = z.input<typeof submitTemplateRequest>;

const canManage = managesStore;

/** Everything a template route needs, or the plain 404 the screen tells apart (`no_active_number`). */
async function context(c: ApiContext): Promise<TemplatesCtx | Response> {
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const number = await activeNumber(c);
  if (!number) return apiError(c, 404, 'not_found', 'no_active_number');
  return { env: c.env, ws, workspaceId: c.req.param('storeId')!, number };
}
const isResponse = (x: TemplatesCtx | Response): x is Response => x instanceof Response;

/** One place that turns a service failure into HTTP. Meta's text travels in `message`; the screen speaks Arabic from `message`/`issues`. */
function failed(c: ApiContext, f: Failure): Response {
  switch (f.reason) {
    case 'invalid': return c.json({ error: 'invalid_request', message: 'invalid_template', issues: f.issues }, 400);
    case 'not_found': return apiError(c, 404, 'not_found', 'template_not_found');
    case 'edit_limit': return c.json({ error: 'invalid_request', message: 'edit_limit', ...(f.retryAt !== undefined ? { retryAt: f.retryAt } : {}) }, 409);
    case 'exists': case 'in_use': case 'payload_changed': case 'not_editable': case 'not_deletable': return apiError(c, 409, 'invalid_request', f.message ?? f.reason);
    case 'token_unavailable': return apiError(c, 503, 'rate_limited', 'token_unavailable');
    case 'meta_unavailable': return apiError(c, 503, 'rate_limited', f.message);
    case 'meta_rejected': return apiError(c, 400, 'invalid_request', f.message);
  }
}

/** A draft from either POST shape, or null when the body is neither. */
function draftFrom(raw: unknown): { draft: TemplateDraft; expectedHash?: string } | null {
  const d = templateDraftRequest.safeParse(raw);
  if (d.success) {
    const { expectedHash, ...draft } = d.data;
    return { draft: draft as TemplateDraft, ...(expectedHash ? { expectedHash } : {}) };
  }
  const old = submitTemplateRequest.safeParse(raw);
  if (!old.success) return null;
  return { draft: fromStoredComponents(old.data.components, { name: old.data.name, language: old.data.language, category: old.data.category, label: null }) };
}

/** Template routes. `defaults` is the product's starter set (supplied by an addon, never imported here). */
export function templatesRoutes(defaults: readonly TemplateSeed[]) {
  const r = new Hono<ApiEnv>();

  r.get('/stores/:storeId/templates', async (c) => {
    const ctx = await context(c);
    if (isResponse(ctx)) return ctx;
    const body = { items: (await ctx.ws.listTemplates()) as unknown as TemplateDto[] } satisfies z.infer<typeof listTemplatesResponse>; // the Rpc type of Meta's loose components is too deep to infer
    return c.json(body);
  });

  r.post('/stores/:storeId/templates/sync', async (c) => {
    const ctx = await context(c);
    if (isResponse(ctx)) return ctx;
    const res = await syncTemplates(ctx);
    return res.ok ? c.json({ upserted: res.upserted, removed: res.removed }) : failed(c, res);
  });

  r.post('/stores/:storeId/templates/install-defaults', async (c) => {
    if (!canManage(c)) return apiError(c, 403, 'forbidden');
    const ctx = await context(c);
    if (isResponse(ctx)) return ctx;
    const res = await installDefaults(ctx, defaults.map((s) => submitTemplateRequest.parse(s)));
    return res.ok ? c.json({ submitted: res.submitted, skipped: res.skipped, failed: res.failed }) : failed(c, res);
  });

  // Free: Meta's rules against a draft. No Meta call, so staff may use it.
  r.post('/stores/:storeId/templates/check', async (c) => {
    const parsed = templateDraftRequest.omit({ expectedHash: true }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 400, 'invalid_request');
    const ctx = await context(c);
    if (isResponse(ctx)) return ctx;
    const { issues, payloadHash } = await checkOnly(ctx, parsed.data as TemplateDraft);
    return c.json({ issues, payloadHash } satisfies z.infer<typeof checkTemplateResponse>);
  });

  r.get('/stores/:storeId/templates/:name/:language', async (c) => {
    const ctx = await context(c);
    if (isResponse(ctx)) return ctx;
    const t = await ctx.ws.getTemplate(c.req.param('name'), c.req.param('language'));
    if (!t) return apiError(c, 404, 'not_found', 'template_not_found');
    const { metaId: _metaId, ...dto } = t; // Meta's internal id is not the merchant's business
    return c.json(dto as unknown as TemplateDto);
  });

  r.post('/stores/:storeId/templates', async (c) => {
    if (!canManage(c)) return apiError(c, 403, 'forbidden');
    const parsed = draftFrom(await c.req.json().catch(() => null));
    if (!parsed) return apiError(c, 400, 'invalid_request');
    const ctx = await context(c);
    if (isResponse(ctx)) return ctx;
    const res = await createTemplate(ctx, parsed.draft, parsed.expectedHash ? { expectedHash: parsed.expectedHash } : {});
    if (!res.ok) return failed(c, res);
    return c.json({ name: res.name, language: res.language, status: res.status, category: res.category as TemplateDto['category'], categoryChanged: res.categoryChanged } satisfies z.infer<typeof createTemplateResponse>, 201);
  });

  r.put('/stores/:storeId/templates/:name/:language', async (c) => {
    if (!canManage(c)) return apiError(c, 403, 'forbidden');
    const parsed = templateDraftRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || parsed.data.name !== c.req.param('name') || parsed.data.language !== c.req.param('language')) return apiError(c, 400, 'invalid_request');
    const ctx = await context(c);
    if (isResponse(ctx)) return ctx;
    const { expectedHash, ...draft } = parsed.data;
    const res = await editTemplate(ctx, draft as TemplateDraft, expectedHash ? { expectedHash } : {});
    return res.ok ? c.json({ status: res.status } satisfies z.infer<typeof editTemplateResponse>) : failed(c, res);
  });

  r.delete('/stores/:storeId/templates/:name/:language', async (c) => {
    if (!canManage(c)) return apiError(c, 403, 'forbidden');
    const ctx = await context(c);
    if (isResponse(ctx)) return ctx;
    const res = await deleteTemplate(ctx, { name: c.req.param('name'), language: c.req.param('language') });
    return res.ok ? c.body(null, 204) : failed(c, res);
  });

  return r;
}
