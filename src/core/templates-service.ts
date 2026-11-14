import type { Env } from '../env';
import type { TemplateDto } from './api/contract';
import type { WorkspaceDO } from './workspace-do';
import { deleteTemplate as metaDelete, editTemplate as metaEdit, fetchTemplates, submitTemplate, type MetaTemplate } from './meta/templates-api';
import { checkTemplate, type ExistingTemplate, type RuleIssue } from './meta/template-rules';
import { graphTokenFor, TokenUnavailable } from './numbers/token';
import { payloadHash, toMetaComponents, type TemplateDraft } from './template-draft';
import { bodyTextOf, componentsSchema } from './templates';
import { z } from 'zod';

/**
 * The ONE template API: the Templates screen and the AI Smart Layer call exactly these functions. Failures are values, never throws;
 * Meta's own text travels untouched in `message` and is turned into Arabic only by the screen, from `reason`.
 *
 * Action policy (spec section 4): checkOnly, syncTemplates and refreshPending are `free`; createTemplate, editTemplate, deleteTemplate and installDefaults
 * are `confirm` (a submission cannot be recalled). The policy lives in the capability registry, not here.
 */
export type TemplatesCtx = { env: Env; ws: DurableObjectStub<WorkspaceDO>; workspaceId: string; number: { phoneNumberId: string; wabaId: string } };
export type FailureReason = 'hash_required' | 'edit_in_progress' | 'invalid' | 'exists' | 'not_found' | 'not_editable' | 'edit_limit' | 'in_use' | 'not_deletable' | 'payload_changed' | 'token_unavailable' | 'meta_unavailable' | 'meta_rejected';
export type Failure = { ok: false; reason: FailureReason; issues?: RuleIssue[]; retryAt?: number; message?: string };
export type TemplateSeedInput = { name: string };

const fail = (reason: FailureReason, extra: Omit<Failure, 'ok' | 'reason'> = {}): Failure => ({ ok: false, reason, ...extra });
const metaFail = (r: { message: string; retryable: boolean }): Failure => fail(r.retryable ? 'meta_unavailable' : 'meta_rejected', { message: r.message });

export type Auth = { token: string; graphVersion: string; wabaId: string };
async function auth(ctx: TemplatesCtx): Promise<Auth | Failure> {
  try {
    return { token: await graphTokenFor(ctx.env, { wabaId: ctx.number.wabaId }), graphVersion: ctx.env.META_GRAPH_VERSION, wabaId: ctx.number.wabaId };
  } catch (err) {
    if (err instanceof TokenUnavailable) return fail('token_unavailable');
    throw err;
  }
}
const isFailure = (x: Auth | Failure): x is Failure => 'ok' in x;

async function existingOf(ctx: TemplatesCtx): Promise<ExistingTemplate[]> {
  return ((await ctx.ws.listTemplates()) as unknown as TemplateDto[]).map((t) => { // the Rpc type of Meta's loose components is too deep to infer
    const parts = componentsSchema.safeParse(t.components ?? []);
    return { name: t.name, language: t.language, bodyText: bodyTextOf(parts.success ? parts.data : []), footer: parts.success ? (parts.data.find((c) => c.type.toUpperCase() === 'FOOTER')?.text ?? null) : null };
  });
}

/** Free: Meta's documented rules against the draft, plus the hash the merchant (or the assistant) confirms. No Meta call. */
export async function checkOnly(ctx: TemplatesCtx, draft: TemplateDraft): Promise<{ ok: true; issues: RuleIssue[]; payloadHash: string }> {
  return { ok: true, issues: checkTemplate(draft, await existingOf(ctx)), payloadHash: await payloadHash(draft) };
}

/** A claim that has had no answer for a minute is not a call in flight (every Meta call times out at 15 s): it is an ambiguous leftover. */
const CLAIM_STALE_MS = 60_000;

/**
 * The gate shared by create and edit: the approval is bound to the payload, so a hash is REQUIRED (no unbound submission ever reaches Meta),
 * then rule errors, then "is this what was confirmed".
 */
async function gate(ctx: TemplatesCtx, draft: TemplateDraft, expectedHash: string | undefined): Promise<Failure | null> {
  if (!expectedHash) return fail('hash_required');
  const { issues, payloadHash: hash } = await checkOnly(ctx, draft);
  if (issues.some((i) => i.severity === 'error')) return fail('invalid', { issues });
  if (expectedHash !== hash) return fail('payload_changed');
  return null;
}

/** What Meta lists for one template, or null (Meta does not have it), or a Failure (Meta could not be asked). */
async function findAtMeta(a: Auth, name: string, language: string): Promise<MetaTemplate | null | Failure> {
  const r = await fetchTemplates(a, { name });
  if (!r.ok) return metaFail(r);
  return r.value.find((t) => t.name === name && t.language === language) ?? null;
}

/** Takes Meta's copy of a template into the workspace (status, category, id, reason), keeping the merchant's title. */
async function adopt(ctx: TemplatesCtx, hit: MetaTemplate, label: string | null): Promise<void> {
  await ctx.ws.saveSubmittedTemplate({ name: hit.name, language: hit.language, category: hit.category, status: hit.status, components: hit.components, metaId: hit.id || null, label });
  const reason = hit.rejected_reason && hit.rejected_reason !== 'NONE' ? hit.rejected_reason : null;
  if (hit.status !== 'PENDING') await ctx.ws.applyTemplateStatus(hit.name, hit.language, hit.status, reason, hit.id || null);
}

export async function createTemplate(ctx: TemplatesCtx, draft: TemplateDraft, opts: { expectedHash: string }): Promise<{ ok: true; name: string; language: string; status: string; category: string; categoryChanged: boolean } | Failure> {
  const blocked = await gate(ctx, draft, opts.expectedHash);
  if (blocked) return blocked;
  const a = await auth(ctx);
  if (isFailure(a)) return a;
  const components = toMetaComponents(draft);
  const claim = () => ctx.ws.reserveTemplate({ name: draft.name, language: draft.language, category: draft.category, components, label: draft.label });
  // Claim the name first (atomic in the DO): a double tap or a second staff tab loses HERE, before any Meta call.
  if (!(await claim())) {
    // A claim that stayed behind after an ambiguous failure (timeout, 5xx: Meta may have created the template) is reconciled, never hidden.
    const row = await ctx.ws.getTemplate(draft.name, draft.language);
    const leftover = row && row.status === 'PENDING' && !row.metaId && row.submittedAt !== null && Date.now() - row.submittedAt > CLAIM_STALE_MS;
    if (!leftover) return fail('exists');
    const found = await findAtMeta(a, draft.name, draft.language);
    if (found !== null && !('ok' in found)) { await adopt(ctx, found, draft.label); return fail('exists'); } // Meta has it: it is shown now, not resubmitted
    if (found !== null) return fail('exists'); // Meta could not be asked: keep the claim, say so
    await ctx.ws.removeTemplate(draft.name, draft.language); // Meta never got it: the leftover is dead
    if (!(await claim())) return fail('exists');
  }
  const res = await submitTemplate(a, { name: draft.name, language: draft.language, category: draft.category, components });
  if (!res.ok) {
    // Retryable (timeout, 5xx, 429) = the outcome is UNKNOWN: Meta may have the template. The claim stays PENDING and the sweep resolves it by name.
    if (res.retryable) return metaFail(res);
    await ctx.ws.removeTemplate(draft.name, draft.language); // a definite refusal releases the name
    // "Already exists" is not a dead end: if Meta does have it, the merchant sees that template now.
    const found = await findAtMeta(a, draft.name, draft.language);
    if (found !== null && !('ok' in found)) { await adopt(ctx, found, draft.label); return fail('exists', { message: res.message }); }
    return metaFail(res);
  }
  await ctx.ws.saveSubmittedTemplate({ name: draft.name, language: draft.language, category: res.value.category, status: res.value.status, components, metaId: res.value.id, label: draft.label });
  console.log(JSON.stringify({ audit: 'template_submitted', workspace: ctx.workspaceId, name: draft.name, language: draft.language, category: res.value.category, status: res.value.status }));
  return { ok: true, name: draft.name, language: draft.language, status: res.value.status, category: res.value.category, categoryChanged: res.value.category !== draft.category };
}

/** Meta's id for one template (an edit and a one-language delete need it). Null = Meta does not list it; a Failure = Meta could not be asked. */
async function resolveMetaId(a: Auth, name: string, language: string): Promise<{ id: string | null } | Failure> {
  const r = await fetchTemplates(a, { name });
  if (!r.ok) return metaFail(r);
  const hit = r.value.find((t: MetaTemplate) => t.name === name && t.language === language);
  return { id: hit?.id || null };
}

export async function editTemplate(ctx: TemplatesCtx, draft: TemplateDraft, opts: { expectedHash: string }): Promise<{ ok: true; status: string } | Failure> {
  if (!opts.expectedHash) return fail('hash_required');
  const row = await ctx.ws.getTemplate(draft.name, draft.language);
  if (!row) return fail('not_found');
  const blocked = await gate(ctx, draft, opts.expectedHash);
  if (blocked) return blocked;
  const allowance = await ctx.ws.editAllowance(draft.name, draft.language);
  if (!allowance.allowed) return allowance.reason === 'status' ? fail('not_editable') : fail('edit_limit', allowance.retryAt === null ? {} : { retryAt: allowance.retryAt });
  if (row.status === 'APPROVED' && draft.category !== row.category) return fail('not_editable', { message: 'category_locked' });
  const a = await auth(ctx);
  if (isFailure(a)) return a;
  // One edit in flight per template: the allowance check above is not a lock, so the second of two taps is refused HERE, before Meta.
  if (!(await ctx.ws.claimTemplateEdit(draft.name, draft.language))) return fail('edit_in_progress');
  try {
    let metaId = row.metaId;
    if (!metaId) {
      const found = await resolveMetaId(a, draft.name, draft.language);
      if ('ok' in found) return found;
      if (!found.id) return fail('not_found');
      metaId = found.id;
    }
    const components = toMetaComponents(draft);
    const res = await metaEdit(a, metaId, { ...(row.status === 'APPROVED' ? {} : { category: draft.category }), components });
    if (!res.ok) return metaFail(res);
    // Meta's edit limits count APPROVED templates only (REJECTED/PAUSED are unlimited), so only those edits are logged: Ruling TPL-EDIT-COUNT-1.
    if (row.status === 'APPROVED') await ctx.ws.recordTemplateEdit(draft.name, draft.language, Date.now());
    await ctx.ws.saveSubmittedTemplate({ name: draft.name, language: draft.language, category: row.status === 'APPROVED' ? row.category : draft.category, status: res.value.status, components, metaId, label: draft.label });
    console.log(JSON.stringify({ audit: 'template_edited', workspace: ctx.workspaceId, name: draft.name, language: draft.language, category: draft.category, status: res.value.status }));
    return { ok: true, status: res.value.status };
  } finally {
    await ctx.ws.releaseTemplateEdit(draft.name, draft.language);
  }
}

export async function deleteTemplate(ctx: TemplatesCtx, p: { name: string; language: string }): Promise<{ ok: true } | Failure> {
  const row = await ctx.ws.getTemplate(p.name, p.language);
  if (!row) return fail('not_found');
  if (row.status === 'DISABLED') return fail('not_deletable');
  if (await ctx.ws.templateInUse(p.name, p.language)) return fail('in_use');
  const a = await auth(ctx);
  if (isFailure(a)) return a;
  // Without Meta's id, Meta deletes EVERY language of the name: resolve it first, and refuse when we cannot.
  let metaId = row.metaId;
  if (!metaId) {
    const found = await resolveMetaId(a, p.name, p.language);
    if ('ok' in found) return found;
    metaId = found.id;
    if (!metaId) {
      await ctx.ws.removeTemplate(p.name, p.language); // Meta does not have it: only our copy is left
      return { ok: true };
    }
  }
  const res = await metaDelete(a, { name: p.name, metaId });
  if (!res.ok) {
    if (res.retryable) return metaFail(res);
    // A refusal can mean "it is already gone": ask Meta, and only a template Meta no longer lists counts as deleted.
    const again = await resolveMetaId(a, p.name, p.language);
    if ('ok' in again || again.id !== null) return metaFail(res);
  }
  await ctx.ws.removeTemplate(p.name, p.language);
  console.log(JSON.stringify({ audit: 'template_deleted', workspace: ctx.workspaceId, name: p.name, language: p.language }));
  return { ok: true };
}

const toSyncItem = (t: MetaTemplate) => ({ name: t.name, language: t.language, category: t.category, status: t.status, components: t.components, rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null, metaId: t.id || null });

export async function syncTemplates(ctx: TemplatesCtx): Promise<{ ok: true; upserted: number; removed: number } | Failure> {
  const a = await auth(ctx);
  if (isFailure(a)) return a;
  const fetched = await fetchTemplates(a);
  if (!fetched.ok) return metaFail(fetched);
  return { ok: true, ...(await ctx.ws.syncTemplates(fetched.value.map(toSyncItem))) };
}

/** A pack entry as Meta wants it. Checked here, so one bad entry in a brand's starter set is reported and skipped, never a 500 or a stopped install. */
const seedSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().min(2).max(10),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  components: componentsSchema.min(1).refine((cs) => cs.some((c) => c.type.toUpperCase() === 'BODY'), 'a BODY component is required'),
});

/** Submits every seed this workspace does not have yet. Seeds are Meta-shaped (`components`), already reviewed copy, so no rule check. */
export async function installDefaults(ctx: TemplatesCtx, seeds: readonly unknown[]): Promise<{ ok: true; submitted: string[]; skipped: string[]; failed: string[] } | Failure> {
  const a = await auth(ctx);
  if (isFailure(a)) return a;
  const out = { ok: true as const, submitted: [] as string[], skipped: [] as string[], failed: [] as string[] };
  for (const raw of seeds) {
    const parsed = seedSchema.safeParse(raw);
    if (!parsed.success) {
      const name = typeof (raw as { name?: unknown } | null)?.name === 'string' ? (raw as { name: string }).name : 'invalid_entry';
      out.failed.push(name);
      console.warn(JSON.stringify({ warn: 'starter_template_entry_invalid', workspace: ctx.workspaceId, name }));
      continue;
    }
    const seed = parsed.data;
    if (!(await ctx.ws.reserveTemplate({ ...seed, label: null }))) {
      out.skipped.push(seed.name);
      continue;
    }
    const res = await submitTemplate(a, seed);
    if (!res.ok) {
      if (!res.retryable) await ctx.ws.removeTemplate(seed.name, seed.language); // a refusal releases the name; an ambiguous failure keeps the claim for the sweep
      out.failed.push(seed.name);
      continue;
    }
    await ctx.ws.saveSubmittedTemplate({ ...seed, category: res.value.category, status: res.value.status, metaId: res.value.id, label: null });
    out.submitted.push(seed.name);
  }
  return out;
}

/** What the sweep needs from the workspace: a stub from outside, or the Durable Object itself when its own alarm runs the sweep. */
export type RefreshStore = {
  pendingTemplates(olderThanMs: number, now?: number): Promise<{ name: string; language: string; metaId: string | null }[]>;
  removeTemplate(name: string, language: string): Promise<boolean>;
  applyTemplateStatus(name: string, language: string, status: string, reason: string | null, metaId?: string | null): Promise<{ applied: boolean }>;
  applyTemplateCategory(name: string, language: string, category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'): Promise<unknown>;
};

/**
 * Stale PENDING rows (the status webhook can be lost, or arrive before our save): ask Meta by name and apply its answer.
 * A PENDING row Meta has never heard of and that holds no Meta id is an orphan of a crashed submit and is dropped.
 */
export async function refreshPendingWith(store: RefreshStore, a: Auth, olderThanMs: number, now = Date.now()): Promise<{ ok: true; checked: number; updated: number } | Failure> {
  const pending = await store.pendingTemplates(olderThanMs, now);
  let updated = 0;
  for (const p of pending) {
    const r = await fetchTemplates(a, { name: p.name });
    if (!r.ok) return metaFail(r);
    const hit = r.value.find((t) => t.name === p.name && t.language === p.language);
    if (!hit) {
      if (p.metaId === null && (await store.removeTemplate(p.name, p.language))) updated++;
      continue;
    }
    const reason = hit.rejected_reason && hit.rejected_reason !== 'NONE' ? hit.rejected_reason : null;
    await store.applyTemplateStatus(p.name, p.language, hit.status, reason, hit.id || null);
    if (hit.status !== 'PENDING') updated++;
    if (['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(hit.category)) await store.applyTemplateCategory(p.name, p.language, hit.category as 'MARKETING' | 'UTILITY' | 'AUTHENTICATION');
  }
  return { ok: true, checked: pending.length, updated };
}

export async function refreshPending(ctx: TemplatesCtx, olderThanMs: number): Promise<{ ok: true; checked: number; updated: number } | Failure> {
  if ((await ctx.ws.pendingTemplates(olderThanMs)).length === 0) return { ok: true, checked: 0, updated: 0 };
  const a = await auth(ctx);
  if (isFailure(a)) return a;
  return refreshPendingWith(ctx.ws, a, olderThanMs);
}
