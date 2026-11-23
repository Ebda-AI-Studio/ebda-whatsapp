/**
 * Template tools. The assistant adds no template logic: drafting is the model's job (D2); checking, hashing, submitting, editing, deleting and rejection advice are the
 * templates service's, reached through its routes with the merchant's own session (SL-CHAT-1). The submit/edit card carries the hash the check returned
 * (`expectedHash`), and the engine's confirm payload hash covers it, so the draft the merchant saw is the draft Meta gets: the service answers `payload_changed` otherwise.
 * Error issues stop a preview (the merchant sees them in plain Arabic through `template_check`); warnings travel on the card.
 */
import { z } from 'zod';
import { templateDraftSchema, type TemplateDraftInput } from '../../api/contract';
import { ruleMessage } from '../../meta/template-rule-copy';
import type { RuleIssue } from '../../meta/template-rules';
import type { ToolSpec, TurnCtx } from '../../../../foundation/smart-layer/types';
import { ToolApiError } from './read.tools';
import { sha256Hex } from '../../../../foundation/smart-layer/release';
import { fromStoredComponents } from '../../template-draft';
import { CACHE_TTL_MS } from '../storage-do';
import { TEMPLATE_WRITE_CREDITS, writeTemplate, type Written } from '../template-writer/writer';
import { ToolInputError, row, schemaOf, writeTool, type Kit, type Reader } from './write';

type Check = { issues: RuleIssue[]; payloadHash: string };
type Stored = { name: string; language: string; category: string; status: string; quality?: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN' | null; bodyText: string; rejectedReason: string | null; advice?: { ar: string; en: string }; editAllowance?: { allowed: true } | { allowed: false; reason: string; retryAt: number | null } };
const ref = z.object({ name: z.string().min(1).max(512), language: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/) }).strict();
const cairo = (ms: number, lang: 'ar' | 'en') => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
const asDraft = (a: TemplateDraftInput): TemplateDraftInput => a;
const issueView = (i: RuleIssue) => ({ code: i.code, severity: i.severity, field: i.field, ar: ruleMessage(i, 'ar'), en: ruleMessage(i, 'en') });
const ask = async (api: Reader, d: TemplateDraftInput): Promise<Check> => (await api.ask('/templates/check', d)) as Check;
const one = async (api: Reader, a: { name: string; language: string }): Promise<Stored> => {
  try { return (await api.get(`/templates/${encodeURIComponent(a.name)}/${encodeURIComponent(a.language)}`)) as Stored; } catch (e) { if (e instanceof ToolApiError && e.status === 404) throw new ToolInputError('not_found'); throw e; }
};
/** Campaigns that still need this template (a draft, a schedule, a run): the service refuses to delete it while one does. */
const campaignsUsing = async (api: Reader, a: { name: string; language: string }): Promise<string[]> =>
  (((await api.get('/campaigns', { limit: '50' })) as { items?: Array<{ name: string; status: string; template: { name: string; language: string } }> }).items ?? [])
    .filter((c) => c.template.name === a.name && c.template.language === a.language && ['draft', 'scheduled', 'running', 'paused'].includes(c.status)).map((c) => c.name);
const blocking = (c: { issues: RuleIssue[] }) => c.issues.filter((i) => i.severity === 'error');


const writeArgs = z.object({
  request: z.string().trim().min(5).max(1000).describe('what the template is for, in the merchant\'s own words (the language the customer should read it in, if they said)'),
  variation: z.number().int().min(1).max(9).optional().describe('1 for the first draft; a bigger number asks for a fresh different take on the same request'),
}).strict();
const fixArgs = z.object({
  name: z.string().min(1).max(512), language: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/),
  hint: z.string().trim().max(500).optional().describe('what the merchant wants changed besides the rejection reason, if anything'),
  variation: z.number().int().min(1).max(9).optional(),
}).strict();
type Generated = { w: Written; hold: string; fresh: boolean };

/**
 * One draft, once, and paid for only on a yes (review of #102). The finished draft is kept for an hour under (workspace, person, request); the 2 AI credits are HELD
 * before the model is called (a deterministic ref, so two identical requests at the same moment share ONE hold), SETTLED by `settle` when the merchant presses confirm,
 * and given back when they reject (the reject route releases `payload.hold`) or simply let the hold lapse. A re-preview reuses the draft and refreshes the same hold, so
 * a cache that expired before the press regenerates under a hold it already owns; a draft that already settled never lets the same ref be reused as "free" (the next
 * attempt takes the next ref).
 */
async function generate(kit: Kit, api: Reader, ctx: TurnCtx, what: string, ask: string, prior?: Parameters<typeof writeTemplate>[2]): Promise<Generated> {
  const w = kit.writer;
  if (!w) throw new ToolInputError('unavailable');
  const key = `${ctx.storeId}:${ctx.userId}:tw:${(await sha256Hex(what)).slice(0, 32)}`;
  const hit = await w.cache.get(key);
  if (hit) {
    const cached = JSON.parse(hit) as Written & { hold: string };
    // The press may come minutes later: refresh the hold (a lapsed one is re-taken if the credits are still there, otherwise the press is refused, never given free).
    if ((await w.credits.hold(cached.hold, TEMPLATE_WRITE_CREDITS)) === 'insufficient') throw new ToolInputError('unavailable');
    return { w: cached, hold: cached.hold, fresh: false };
  }
  const base = `sl:tw:${key.slice(-32)}:${Math.floor(ctx.now / CACHE_TTL_MS)}`;
  let hold = '';
  for (let n = 0; n < 5 && !hold; n++) {
    const r = await w.credits.hold(`${base}:${n}`, TEMPLATE_WRITE_CREDITS);
    if (r === 'insufficient') throw new ToolInputError('unavailable');
    if (r === 'held') hold = `${base}:${n}`; // 'already_charged' = that draft was paid for: this is a new one, take the next ref
  }
  if (!hold) throw new ToolInputError('unavailable');
  try {
    const names = ((await api.get('/templates')) as { items?: Array<{ name: string; language: string }> }).items ?? [];
    const out = await writeTemplate({ complete: w.complete, check: (d) => ask_(api, d), taken: (lang) => new Set(names.filter((n) => n.language === lang).map((n) => n.name)) }, ask, prior, await storeProfile(api, ctx.storeId));
    if (blocking(out).length) throw new ToolInputError('invalid');
    await w.cache.put(key, JSON.stringify({ ...out, hold }));
    return { w: out, hold, fresh: true };
  } catch (e) {
    await w.credits.release(hold).catch(() => undefined); // nothing is charged for a draft that could not be made
    throw e;
  }
}
/**
 * What the writer may know about the store, from data Chat really has (it stores no business category): the store's name and the titles of the service menu the merchant wrote.
 * Empty when neither is readable: the writer then stays generic. Never throws (a profile is a nicety, not a reason to fail a paid draft).
 */
export async function storeProfile(api: Reader, storeId: string): Promise<string> {
  const lines: string[] = [];
  try {
    const me = (await api.get('/me')) as { stores?: Array<{ id: string; name: string }> };
    const name = me.stores?.find((x) => x.id === storeId)?.name?.trim();
    if (name) lines.push(`Name: ${name.slice(0, 80)}`);
  } catch { /* generic */ }
  try {
    const st = (await api.get('/store-link/settings')) as { menu?: { items?: Array<{ title?: { ar?: string; en?: string } }> } };
    const titles = (st.menu?.items ?? []).map((i) => i.title?.ar || i.title?.en || '').filter(Boolean).slice(0, 8);
    if (titles.length) lines.push(`Service menu: ${titles.join('، ')}`.slice(0, 300));
  } catch { /* generic */ }
  return lines.join('\n');
}
const ask_ = (api: Reader, d: TemplateDraftInput): Promise<Check> => ask(api, d);

/** What a preview shows of a draft: its name and category, the message as the customer will see it (the panel draws it as a WhatsApp card), and Meta's warnings. */
export const TEMPLATE_VIEW = 'whatsapp_template';
function draftRows(a: TemplateDraftInput, c: Check, lang: 'ar' | 'en') {
  return [
    row('الاسم', 'Name', undefined, `${a.name} (${a.language})`),
    row('الفئة', 'Category', undefined, a.category),
    row('الرسالة زي ما العميل هيشوفها', 'The message as the customer will see it', undefined, { kind: TEMPLATE_VIEW, draft: a }, 'merchant'),
    ...c.issues.filter((i) => i.severity === 'warning').map((i) => row('تنبيه', 'Warning', undefined, ruleMessage(i, lang))),
  ];
}

export function templateTools(kit: Kit): ToolSpec[] {
  const free = <A>(s: { name: string; capabilityId: string; description: string; args: z.ZodType<A>; read(ctx: TurnCtx, a: A): Promise<unknown> }): ToolSpec =>
    ({ ...s, jsonSchema: schemaOf(s.args), policy: 'free', undo: 'none', resultTrust: 'store-data' }) as unknown as ToolSpec;
  const rd = (ctx: TurnCtx): Reader => ({
    get: async (path, query) => { const r = await kit.callApi(ctx, path, query); if (r.status < 200 || r.status >= 300) throw new ToolApiError(r.status); return r.json; },
    ask: async (path, body) => { const r = await kit.callApi(ctx, path, undefined, { method: 'POST', body }); if (r.status < 200 || r.status >= 300) throw new ToolApiError(r.status); return r.json; },
  });
  return [
    free({
      name: 'template_status', capabilityId: 'templates.list',
      description: "One template's status (APPROVED, PENDING, REJECTED, PAUSED, DISABLED), Meta's reason with plain advice, whether it can still be edited and when it unlocks, and which campaigns still use it. Call it before editing or deleting a template.",
      args: ref,
      async read(ctx, a) {
        const api = rd(ctx);
        const t = await one(api, a);
        const used = await campaignsUsing(api, a);
        const allow = t.editAllowance;
        return {
          name: t.name, language: t.language, category: t.category, status: t.status, quality: t.quality ?? null, rejectedReason: t.rejectedReason, advice: t.advice ?? null,
          canEdit: allow ? allow.allowed : null,
          ...(allow && !allow.allowed ? { editBlockedBy: allow.reason, ...(allow.retryAt ? { editUnlocksAt: cairo(allow.retryAt, ctx.locale) } : {}) } : {}),
          usedByCampaigns: used,
        };
      },
    }),
    free({
      name: 'template_check', capabilityId: 'templates.check-draft',
      description: "Check a template draft against Meta's rules, for free (nothing is sent anywhere). Returns each problem with a plain Arabic and English message, and whether it can be submitted. Always call this before template_submit or template_edit and fix every error.",
      args: templateDraftSchema,
      async read(ctx, a) { const c = await ask(rd(ctx), a); return { canSubmit: blocking(c).length === 0, issues: c.issues.map(issueView) }; },
    }),
    free({
      name: 'template_sync', capabilityId: 'templates.sync',
      description: "Pull the templates and their review status from Meta into the merchant's list. Sends nothing to Meta or to a customer.",
      args: z.object({}).strict(),
      async read(ctx) { return rd(ctx).ask('/templates/sync', {}); },
    }),

    writeTool({
      name: 'template_write', capabilityId: 'templates.ai-writer', policy: 'confirm', undo: 'irreversible',
      description: "Write a Meta-ready WhatsApp template from what the merchant wants to say (Egyptian Arabic by default, English on request), check it against Meta's rules, and prepare it for submission. The card shows the finished message and its cost in AI credits; only the merchant's press submits it to Meta. Use variation 2, 3 ... for a fresh take. If it fails, nothing is charged.",
      args: writeArgs,
      async read(api, ctx, a) { return generate(kit, api, ctx, `write|${a.request}|${a.variation ?? 1}`, a.request); },
      fingerprint: (g) => ({ h: g.w.payloadHash, w: g.w.issues }),
      settle: async (g) => { await kit.writer?.credits.settle(g.hold); },
      plan: (_a, g, ctx) => ({
        summary: { ar: `قالب جاهز للتقديم لـ Meta: "${g.w.draft.label}"`, en: `A template ready to submit to Meta: "${g.w.draft.label}"` },
        rows: draftRows(g.w.draft, g.w, ctx.locale),
        cost: TEMPLATE_WRITE_CREDITS, hold: g.hold,
        request: { method: 'POST', path: '/templates', body: { ...g.w.draft, expectedHash: g.w.payloadHash } },
      }),
    }, kit),
    writeTool({
      name: 'template_fix', capabilityId: 'templates.ai-writer', policy: 'confirm', undo: 'irreversible',
      description: "Fix a template Meta rejected: start from the stored template, Meta's reason and the plain advice, write the corrected version, check it, and prepare the edit. The card shows the corrected message and its cost in AI credits; only the merchant's press sends it to Meta again. Use template_status first to see the reason and whether an edit is allowed.",
      args: fixArgs,
      async read(api, ctx, a) {
        const t = (await one(api, a)) as Stored & { components?: Array<Record<string, unknown>>; label?: string | null };
        if (t.editAllowance && !t.editAllowance.allowed) throw new ToolInputError('unavailable');
        const prior = { draft: fromStoredComponents((t.components ?? []) as never, { name: t.name, language: t.language, category: t.category, label: t.label ?? null }) as TemplateDraftInput, reason: t.rejectedReason, advice: t.advice ?? null };
        return generate(kit, api, ctx, `fix|${a.name}|${a.language}|${a.hint ?? ''}|${a.variation ?? 1}|${t.rejectedReason ?? ''}`, a.hint ?? 'Fix the template so Meta accepts it.', prior);
      },
      fingerprint: (g) => ({ h: g.w.payloadHash, w: g.w.issues }),
      settle: async (g) => { await kit.writer?.credits.settle(g.hold); },
      plan: (a, g, ctx) => ({
        summary: { ar: `نسخة مصلّحة من القالب "${g.w.draft.label}" لإعادة تقديمها`, en: `A corrected version of "${g.w.draft.label}" to send to Meta again` },
        rows: draftRows(g.w.draft, g.w, ctx.locale),
        cost: TEMPLATE_WRITE_CREDITS, hold: g.hold,
        request: { method: 'PUT', path: `/templates/${encodeURIComponent(a.name)}/${encodeURIComponent(a.language)}`, body: { ...g.w.draft, expectedHash: g.w.payloadHash } },
      }),
    }, kit),
    writeTool({
      name: 'template_submit', capabilityId: 'templates.create-submit', policy: 'confirm', undo: 'irreversible',
      description: "Submit a new template draft to Meta for review. Meta reviews it and the submission cannot be taken back, so the merchant confirms with the button. Run template_check first and fix every error.",
      args: templateDraftSchema,
      async read(api, _c, a) {
        const t = ((await api.get('/templates')) as { items?: Array<{ name: string; language: string }> }).items ?? [];
        if (t.some((x) => x.name === a.name && x.language === a.language)) throw new ToolInputError('ambiguous');
        return ask(api, a);
      },
      // The warnings are part of what the merchant agreed to: a new one (a duplicate appeared) is a new card.
      fingerprint: (c) => ({ h: c.payloadHash, w: c.issues }),
      plan: (a, c, ctx) => {
        if (blocking(c).length) throw new ToolInputError('invalid');
        return {
          summary: { ar: `تقديم القالب "${a.label}" لـ Meta للمراجعة`, en: `Submit the template "${a.label}" to Meta for review` },
          rows: draftRows(asDraft(a), c, ctx.locale),
          request: { method: 'POST', path: '/templates', body: { ...a, expectedHash: c.payloadHash } },
        };
      },
    }, kit),
    writeTool({
      name: 'template_edit', capabilityId: 'templates.edit-delete', policy: 'confirm', undo: 'irreversible',
      description: "Edit an existing template (same name and language). Meta reviews it again and the edit cannot be taken back; Meta limits how often a template can be edited (template_status says if and when). The merchant confirms with the button.",
      args: templateDraftSchema,
      async read(api, _c, a) {
        const t = await one(api, a);
        if (t.editAllowance && !t.editAllowance.allowed) throw new ToolInputError('unavailable');
        return { stored: { status: t.status, body: t.bodyText }, check: await ask(api, a) };
      },
      fingerprint: (s) => ({ st: s.stored, h: s.check.payloadHash, w: s.check.issues }),
      plan: (a, s, ctx) => {
        if (blocking(s.check).length) throw new ToolInputError('invalid');
        return {
          summary: { ar: `تعديل القالب "${a.label}" وإعادة تقديمه لـ Meta`, en: `Edit the template "${a.label}" and send it to Meta again` },
          rows: [row('نص الرسالة الحالي', 'Current message text', s.stored.body, undefined), ...draftRows(asDraft(a), s.check, ctx.locale)],
          request: { method: 'PUT', path: `/templates/${encodeURIComponent(a.name)}/${encodeURIComponent(a.language)}`, body: { ...a, expectedHash: s.check.payloadHash } },
        };
      },
    }, kit),
    writeTool({
      name: 'template_delete', capabilityId: 'templates.edit-delete', policy: 'confirm', undo: 'irreversible', deletes: true,
      description: 'Delete a template (also at Meta). It cannot be taken back, and an approved name is blocked for 30 days afterwards. Refused while a campaign still uses it. The merchant confirms with the button.',
      args: ref,
      async read(api, _c, a) { const t = await one(api, a); return { status: t.status, used: await campaignsUsing(api, a) }; },
      plan: (a, s) => {
        if (s.used.length) throw new ToolInputError('unavailable');
        return {
          summary: { ar: `مسح القالب ${a.name}`, en: `Delete the template ${a.name}` },
          rows: [row('القالب', 'Template', `${a.name} (${a.language})`, undefined), row('الحالة', 'Status', s.status, undefined), row('تنبيه', 'Note', undefined, 'لو كان معتمد، اسمه بيتقفل 30 يوم بعد المسح / an approved name is blocked for 30 days')],
          request: { method: 'DELETE', path: `/templates/${encodeURIComponent(a.name)}/${encodeURIComponent(a.language)}` },
        };
      },
    }, kit),
    writeTool({
      name: 'templates_install_defaults', capabilityId: 'templates.install-defaults', policy: 'confirm', undo: 'irreversible',
      description: 'Submit the starter set of message templates to Meta for approval. Each one is sent to Meta and cannot be taken back, so the merchant confirms with the button.',
      args: z.object({}).strict(),
      read: async (api) => ({ names: ((await api.get('/templates')) as { items?: Array<{ name: string; language: string }> }).items?.map((t) => `${t.name}/${t.language}`).sort() ?? [] }),
      plan: (_a, s) => ({
        summary: { ar: 'تقديم قوالب البداية لـ Meta', en: 'Submit the starter templates to Meta' },
        rows: [row('قوالب موجودة عندك دلوقتي', 'Templates you already have', undefined, String(s.names.length)), row('اللي هيحصل', 'What happens', undefined, 'القوالب الناقصة بتتبعت لـ Meta للمراجعة / the missing ones are sent to Meta for review')],
        request: { method: 'POST', path: '/templates/install-defaults' },
      }),
    }, kit),
    writeTool({
      name: 'templates_install_seasonal', capabilityId: 'campaigns.seasonal-ramadan', policy: 'confirm', undo: 'irreversible',
      description: 'Submit the Ramadan message templates (a greeting, an offer, opening hours) to Meta for approval. Each one is sent to Meta and cannot be taken back, so the merchant confirms with the button. They are only submitted, never sent to customers.',
      args: z.object({ pack: z.literal('ramadan').default('ramadan') }).strict(),
      read: async (api) => ({ names: ((await api.get('/templates')) as { items?: Array<{ name: string; language: string }> }).items?.map((t) => `${t.name}/${t.language}`).sort() ?? [] }),
      plan: (_a, s) => {
        const have = ['ramadan_greeting', 'ramadan_offer', 'ramadan_hours'].filter((n) => s.names.includes(`${n}/ar`));
        if (have.length === 3) throw new ToolInputError('no_change');
        return {
          summary: { ar: 'تقديم قوالب رمضان لـ Meta', en: 'Submit the Ramadan templates to Meta' },
          rows: [row('قوالب رمضان الموجودة عندك', 'Ramadan templates you already have', undefined, String(have.length)), row('اللي هيحصل', 'What happens', undefined, 'القوالب الناقصة بتتبعت لـ Meta للمراجعة، ومفيش رسالة بتروح لعميل / the missing ones are sent to Meta for review, nothing is sent to a customer')],
          request: { method: 'POST', path: '/templates/install-seasonal', body: { pack: 'ramadan' } },
        };
      },
    }, kit),
  ];
}
