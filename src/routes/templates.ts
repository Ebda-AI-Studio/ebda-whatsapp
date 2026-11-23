import { Hono } from 'hono';
import { z } from 'zod';
import { checkTemplateResponse, createTemplateResponse, editTemplateResponse, listTemplatesResponse, templateDraftRequest, type TemplateDto } from '../core/api/contract';
import { listSharedRequestsResponse, listSharedTemplatesResponse, sharedRequestCreate } from '../core/api/contract';
import { createRequest, listRequests, sharedNumberOf, sharedTemplatesFor } from '../core/shared/shared-template-requests';
import type { TemplateDraft } from '../core/template-draft';
import { checkOnly, createTemplate, deleteTemplate, editTemplate, installDefaults, syncTemplates, type Failure, type TemplatesCtx } from '../core/templates-service';
import { componentsSchema } from '../core/templates';
import { submitCodV2 } from '../core/cod-v2';
import { activeNumber, apiError, workspaceStub, type ApiContext, type ApiEnv, managesStore } from './shared';

/** A starter-set entry (Meta components as they are) and the operator's platform-template submission. A merchant POST /templates takes the draft shape only. */
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
    case 'hash_required': return apiError(c, 400, 'invalid_request', 'hash_required');
    case 'edit_in_progress': return apiError(c, 409, 'invalid_request', 'edit_in_progress');
    case 'invalid': return c.json({ error: 'invalid_request', message: 'invalid_template', issues: f.issues }, 400);
    case 'not_found': return apiError(c, 404, 'not_found', 'template_not_found');
    case 'edit_limit': return c.json({ error: 'invalid_request', message: 'edit_limit', ...(f.retryAt !== undefined ? { retryAt: f.retryAt } : {}) }, 409);
    case 'exists': case 'in_use': case 'payload_changed': case 'not_editable': case 'not_deletable': return apiError(c, 409, 'invalid_request', f.message ?? f.reason);
    case 'token_unavailable': return apiError(c, 503, 'rate_limited', 'token_unavailable');
    case 'meta_unavailable': return apiError(c, 503, 'rate_limited', f.message);
    case 'meta_rejected': return apiError(c, 400, 'invalid_request', f.message);
  }
}

/** The bound hash of a submission, or null when the body carries none: no unbound submission ever reaches Meta (spec section 4: the confirm is bound to the payload). */
const hasHash = (raw: unknown): boolean => typeof raw === 'object' && raw !== null && typeof (raw as { expectedHash?: unknown }).expectedHash === 'string' && /^[0-9a-f]{64}$/.test((raw as { expectedHash: string }).expectedHash);

/** Template routes. `defaults` is the product's starter set (supplied by an addon, never imported here). */
export function templatesRoutes(defaults: readonly TemplateSeed[]) {
  const r = new Hono<ApiEnv>();

  r.get('/stores/:storeId/templates', async (c) => {
    const ctx = await context(c);
    if (isResponse(ctx)) return ctx;
    const body = { items: (await ctx.ws.listTemplates()) as unknown as TemplateDto[], starterInstalled: await ctx.ws.starterInstalled(ctx.number.wabaId) } satisfies z.infer<typeof listTemplatesResponse>; // the Rpc type of Meta's loose components is too deep to infer
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
    const res = await installDefaults(ctx, defaults); // each entry is validated in the service: a bad one is reported in `failed`, never a 500
    if (res.ok && res.failed.length === 0) await ctx.ws.markStarterInstalled(ctx.number.wabaId);
    return res.ok ? c.json({ submitted: res.submitted, skipped: res.skipped, failed: res.failed }) : failed(c, res);
  });

  // The per-store COD v2 template (Ruling WA-COD-V2-2): submit it if it is missing, or replace a REJECTED one. Owner/staff who manage the store only.
  r.post('/stores/:storeId/templates/cod-v2/resubmit', async (c) => {
    if (!canManage(c)) return apiError(c, 403, 'forbidden');
    const ctx = await context(c);
    if (isResponse(ctx)) return ctx;
    const status = await submitCodV2(ctx, { resubmit: true });
    if (status === 'no_origin') return apiError(c, 409, 'invalid_request', 'store_origin_unknown');
    return status === 'failed' ? apiError(c, 503, 'rate_limited', 'meta_unavailable') : c.json({ status });
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

  // A store on the SHARED number (no own number): the platform's sendable templates, and asks for a new utility one. Anything else is 404.
  r.get('/stores/:storeId/templates/shared', async (c) => {
    if (!(await workspaceStub(c)) || !(await sharedNumberOf(c.env, c.req.param('storeId')!))) return apiError(c, 404, 'not_found');
    return c.json({ items: await sharedTemplatesFor(c.env) } satisfies z.infer<typeof listSharedTemplatesResponse>);
  });

  r.get('/stores/:storeId/templates/shared-requests', async (c) => {
    if (!(await workspaceStub(c)) || !(await sharedNumberOf(c.env, c.req.param('storeId')!))) return apiError(c, 404, 'not_found');
    return c.json({ items: await listRequests(c.env, c.req.param('storeId')!) } satisfies z.infer<typeof listSharedRequestsResponse>);
  });

  r.post('/stores/:storeId/templates/shared-requests', async (c) => {
    if (!canManage(c)) return apiError(c, 403, 'forbidden');
    const parsed = sharedRequestCreate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 400, 'invalid_request');
    if (!(await workspaceStub(c)) || !(await sharedNumberOf(c.env, c.req.param('storeId')!))) return apiError(c, 404, 'not_found');
    // WA-SHARED-NOCAMP-1: marketing could never be sent from the shared number, so it is not even asked for.
    if (parsed.data.category === 'MARKETING') return apiError(c, 400, 'invalid_request', 'marketing_not_on_shared_number');
    const made = await createRequest(c.env, c.req.param('storeId')!, { ...parsed.data, category: parsed.data.category });
    if (!made.ok) return apiError(c, 429, 'rate_limited', 'too_many_open_requests');
    console.log(JSON.stringify({ audit: 'shared_template_requested', workspace: c.req.param('storeId'), name: parsed.data.name, language: parsed.data.language, category: parsed.data.category }));
    return c.json(made.request, 201);
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
    const raw = await c.req.json().catch(() => null);
    if (!hasHash(raw)) return apiError(c, 400, 'invalid_request', 'hash_required');
    const parsed = templateDraftRequest.safeParse(raw);
    if (!parsed.success) return apiError(c, 400, 'invalid_request');
    const ctx = await context(c);
    if (isResponse(ctx)) return ctx;
    const { expectedHash, ...draft } = parsed.data;
    const res = await createTemplate(ctx, draft as TemplateDraft, { expectedHash });
    if (!res.ok) return failed(c, res);
    return c.json({ name: res.name, language: res.language, status: res.status, category: res.category as TemplateDto['category'], categoryChanged: res.categoryChanged } satisfies z.infer<typeof createTemplateResponse>, 201);
  });

  r.put('/stores/:storeId/templates/:name/:language', async (c) => {
    if (!canManage(c)) return apiError(c, 403, 'forbidden');
    const raw = await c.req.json().catch(() => null);
    if (!hasHash(raw)) return apiError(c, 400, 'invalid_request', 'hash_required');
    const parsed = templateDraftRequest.safeParse(raw);
    if (!parsed.success || parsed.data.name !== c.req.param('name') || parsed.data.language !== c.req.param('language')) return apiError(c, 400, 'invalid_request');
    const ctx = await context(c);
    if (isResponse(ctx)) return ctx;
    const { expectedHash, ...draft } = parsed.data;
    const res = await editTemplate(ctx, draft as TemplateDraft, { expectedHash });
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
