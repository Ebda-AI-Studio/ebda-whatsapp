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
import { ToolInputError, row, schemaOf, writeTool, type Kit, type Reader } from './write';

type Check = { issues: RuleIssue[]; payloadHash: string };
type Stored = { name: string; language: string; category: string; status: string; bodyText: string; rejectedReason: string | null; advice?: { ar: string; en: string }; editAllowance?: { allowed: true } | { allowed: false; reason: string; retryAt: number | null } };
const ref = z.object({ name: z.string().min(1).max(512), language: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/) }).strict();
const cairo = (ms: number, lang: 'ar' | 'en') => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
const asDraft = (a: TemplateDraftInput): TemplateDraftInput => a;
const fill = (text: string, ex: string[]) => text.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => ex[Number(n) - 1] ?? `{{${n}}}`);
const issueView = (i: RuleIssue) => ({ code: i.code, severity: i.severity, field: i.field, ar: ruleMessage(i, 'ar'), en: ruleMessage(i, 'en') });
const ask = async (api: Reader, d: TemplateDraftInput): Promise<Check> => (await api.ask('/templates/check', d)) as Check;
const one = async (api: Reader, a: { name: string; language: string }): Promise<Stored> => {
  try { return (await api.get(`/templates/${encodeURIComponent(a.name)}/${encodeURIComponent(a.language)}`)) as Stored; } catch (e) { if (e instanceof ToolApiError && e.status === 404) throw new ToolInputError('not_found'); throw e; }
};
/** Campaigns that still need this template (a draft, a schedule, a run): the service refuses to delete it while one does. */
const campaignsUsing = async (api: Reader, a: { name: string; language: string }): Promise<string[]> =>
  (((await api.get('/campaigns', { limit: '50' })) as { items?: Array<{ name: string; status: string; template: { name: string; language: string } }> }).items ?? [])
    .filter((c) => c.template.name === a.name && c.template.language === a.language && ['draft', 'scheduled', 'running', 'paused'].includes(c.status)).map((c) => c.name);
const blocking = (c: Check) => c.issues.filter((i) => i.severity === 'error');

function draftRows(a: TemplateDraftInput, c: Check, lang: 'ar' | 'en') {
  return [
    row('الاسم', 'Name', undefined, `${a.name} (${a.language})`),
    row('الفئة', 'Category', undefined, a.category),
    ...(a.header ? [row('العنوان', 'Header', undefined, fill(a.header.text, a.header.example ? [a.header.example] : []), 'merchant')] : []),
    row('نص الرسالة (بالأمثلة)', 'Message text (with the examples)', undefined, fill(a.body.text, a.body.examples), 'merchant'),
    ...(a.footer ? [row('السطر الأخير', 'Footer', undefined, a.footer, 'merchant')] : []),
    ...(a.buttons.length ? [row('الأزرار', 'Buttons', undefined, a.buttons.map((b) => ('text' in b ? b.text : b.example)).join(' | '), 'merchant')] : []),
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
          name: t.name, language: t.language, category: t.category, status: t.status, rejectedReason: t.rejectedReason, advice: t.advice ?? null,
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
  ];
}
