/**
 * Campaign tools (wave 2). Sending a campaign spends the wallet and messages customers, so send/schedule/resume/cancel/delete are confirm class: the card
 * shows the audience size, the exact template and parameters, and the wallet estimate the product itself computes, and only the merchant's own press on
 * the confirm button sends (a typed "yes" cannot). Drafting one sends nothing; pause is the safe direction.
 */
import { z } from 'zod';
import { campaignParam, segmentCriteria, type CampaignCreate } from '../../api/contract';
import type { ToolSpec } from '../../../../foundation/smart-layer/types';
import { ToolInputError, pickByName, row, writeTool, type L, type Reader, type Kit } from './write';

type Camp = { id: string; name: string; status: string; category: string; template: { name: string; language: string }; params: unknown[]; audience: { segmentId: number | null; criteria: unknown }; scheduledAt: number | null; estimate?: { audience: number; perMessageMinor: number; totalMinor: number } };
const egp = (minor: number) => String(Math.round(minor) / 100);
const fmt = (ms: number, lang: 'ar' | 'en') => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
const j = (v: unknown) => JSON.stringify(v);

const name = z.string().trim().min(1).max(80).describe('the campaign name as the merchant wrote it');
const one = z.object({ campaign: name }).strict();
const draftArgs = z.object({
  name,
  template: z.object({ name: z.string().min(1).max(512), language: z.string().min(2).max(10) }).describe('an approved template'),
  // Tracked links (an address the customers are sent to) are set up on the Campaigns screen, never by the assistant: it only fills text and name parameters.
  params: z.array(z.union([campaignParam.options[0], campaignParam.options[1]])).max(20).default([]),
  segment: z.string().trim().min(1).max(60).optional().describe('the name of a saved segment to send to'),
  criteria: segmentCriteria.optional().describe('or the filter itself, when there is no saved segment'),
  dailySendLimit: z.number().int().min(1).max(1_000_000).optional(),
}).strict().refine((a) => (a.segment === undefined) !== (a.criteria === undefined), 'give a segment or criteria');
const scheduleArgs = z.object({ campaign: name, at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/).describe('when to start, Cairo time with its offset, e.g. 2026-12-01T18:00:00+02:00') }).strict();

async function find(api: Reader, wanted: string): Promise<Camp> {
  const r = (await api.get('/campaigns', { limit: '50' })) as { items?: Camp[] };
  return pickByName(r.items ?? [], (c) => c.name, wanted);
}
/** The campaign again with its pre-send estimate (the list answer may carry none). */
async function detail(api: Reader, wanted: string): Promise<Camp> {
  const c = await find(api, wanted);
  return (await api.get(`/campaigns/${c.id}`)) as Camp;
}
const fingerprint = (c: Camp) => ({ id: c.id, status: c.status, scheduledAt: c.scheduledAt, est: c.estimate ?? null, params: c.params, template: c.template });
const costRows = (c: Camp): ReturnType<typeof row>[] => [
  row('القالب', 'Template', undefined, `${c.template.name} (${c.template.language})`),
  row('البيانات اللي هتتبعت', 'Parameters', undefined, c.params.length ? j(c.params) : '-'),
  row('هيوصل لكام واحد', 'People it reaches', undefined, c.estimate ? String(c.estimate.audience) : '?'),
  row('التكلفة المتوقعة من المحفظة (جنيه)', 'Expected wallet cost (EGP)', undefined, c.estimate && c.estimate.totalMinor > 0 ? egp(c.estimate.totalMinor) : '?'),
];

function stateTool(opts: { tool: string; capability: string; policy: 'preview' | 'confirm'; undo: 'reversible' | 'compensating' | 'irreversible'; from: string[]; verb: L; to: string; path: (id: string) => string; description: string; money?: boolean; messages?: boolean; restoreTool?: string; deletes?: boolean; method?: 'POST' | 'DELETE' }, kit: Kit): ToolSpec {
  return writeTool({
    name: opts.tool, capabilityId: opts.capability, description: opts.description, args: one, policy: opts.policy, undo: opts.undo,
    ...(opts.money ? { money: true } : {}), ...(opts.messages ? { messagesCustomers: true } : {}), ...(opts.deletes ? { deletes: true } : {}),
    read: (api, _c, a) => detail(api, a.campaign),
    fingerprint,
    plan: (a, c) => {
      if (!opts.from.includes(c.status)) throw new ToolInputError('no_change');
      return {
        summary: { ar: `${opts.verb.ar} حملة "${c.name}"`, en: `${opts.verb.en} the campaign "${c.name}"` },
        rows: [row('الحالة', 'Status', c.status, opts.to), ...costRows(c)],
        request: { method: opts.method ?? 'POST', path: opts.path(c.id) },
        ...(opts.restoreTool ? { restore: { tool: opts.restoreTool, args: { campaign: a.campaign } } } : {}),
      };
    },
  }, kit);
}

export function campaignTools(kit: Kit): ToolSpec[] {
  return [
    writeTool({
      name: 'campaign_draft', capabilityId: 'campaigns.create', policy: 'preview', undo: 'compensating',
      description: 'Create a campaign DRAFT: an approved template sent to a saved segment (or a filter). It sends nothing; sending is a separate step the merchant confirms. Shows the audience size and expected cost.',
      args: draftArgs,
      read: async (api, _c, a) => {
        let segmentId: number | null = null;
        let criteria = a.criteria;
        if (a.segment !== undefined) {
          const list = (await api.get('/segments')) as { items?: Array<{ id: number; name: string; criteria: typeof a.criteria }> };
          const seg = pickByName(list.items ?? [], (s) => s.name, a.segment);
          segmentId = seg.id; criteria = seg.criteria;
        }
        const tpl = ((await api.get('/templates')) as { items?: Array<{ name: string; language: string; status: string }> }).items?.find((t) => t.name === a.template.name && t.language === a.template.language);
        if (!tpl || tpl.status !== 'APPROVED') throw new ToolInputError('unavailable');
        const audience = (await api.ask('/segments/preview', { criteria })) as { count: number; excluded: { optedOut: number; noConsent: number } };
        const have = ((await api.get('/campaigns', { limit: '50' })) as { items?: Array<{ name: string }> }).items?.some((c) => c.name.trim().toLowerCase() === a.name.trim().toLowerCase()) ?? false;
        return { segmentId, criteria, audience, have };
      },
      fingerprint: (s) => ({ seg: s.segmentId, criteria: s.criteria, count: s.audience.count, have: s.have }),
      plan: (a, s) => {
        if (s.have) throw new ToolInputError('ambiguous');
        const body: CampaignCreate = { name: a.name, template: a.template, params: a.params, audience: s.segmentId !== null ? { segmentId: s.segmentId } : { criteria: s.criteria! }, ...(a.dailySendLimit ? { dailySendLimit: a.dailySendLimit } : {}) };
        return {
          summary: { ar: `تجهيز حملة "${a.name}" كمسودة (مش هتتبعت)`, en: `Prepare the campaign "${a.name}" as a draft (nothing is sent)` },
          rows: [row('القالب', 'Template', undefined, `${a.template.name} (${a.template.language})`), row('البيانات', 'Parameters', undefined, a.params.length ? j(a.params) : '-'), row('هيوصل لكام واحد', 'People it would reach', undefined, String(s.audience.count)), row('مستبعدين (انسحبوا / مفيش موافقة)', 'Left out (opted out / no consent)', undefined, `${s.audience.excluded.optedOut} / ${s.audience.excluded.noConsent}`)],
          request: { method: 'POST', path: '/campaigns', body },
          restore: { tool: 'campaign_delete_draft', to: 'deleted', args: { campaign: a.name } },
          affected: 1,
        };
      },
    }, kit),
    stateTool({ tool: 'campaign_send_now', to: 'running', capability: 'campaigns.send-now', policy: 'confirm', undo: 'irreversible', from: ['draft'], verb: { ar: 'إرسال الآن', en: 'Send now' }, path: (id) => `/campaigns/${id}/send`, money: true, messages: true, description: 'Send a draft campaign to its whole audience NOW. It messages customers and spends the wallet, so the merchant confirms with the button; the card shows the audience, the template and the expected cost.' }, kit),
    writeTool({
      name: 'campaign_schedule', capabilityId: 'campaigns.schedule', policy: 'confirm', undo: 'compensating', money: true, messagesCustomers: true,
      description: 'Schedule a draft campaign to start at a given time (Cairo time with its offset). It messages customers and spends the wallet then, so the merchant confirms with the button.',
      args: scheduleArgs,
      read: (api, _c, a) => detail(api, a.campaign),
      fingerprint,
      plan: (a, c) => {
        if (c.status !== 'draft') throw new ToolInputError('no_change');
        const at = Date.parse(a.at);
        if (!Number.isFinite(at) || at <= Date.now() + 60_000 || at > Date.now() + 365 * 86_400_000) throw new ToolInputError('unavailable');
        return {
          summary: { ar: `جدولة حملة "${c.name}"`, en: `Schedule the campaign "${c.name}"` },
          rows: [row('هتبدأ', 'Starts', undefined, `${fmt(at, 'ar')} / ${fmt(at, 'en')}`), ...costRows(c)],
          request: { method: 'POST', path: `/campaigns/${c.id}/send`, body: { scheduledAt: at } },
          restore: { tool: 'campaign_cancel', to: 'cancelled', args: { campaign: a.campaign } },
        };
      },
    }, kit),
    stateTool({ tool: 'campaign_pause', to: 'paused', capability: 'campaigns.pause', policy: 'preview', undo: 'reversible', from: ['running', 'scheduled'], verb: { ar: 'إيقاف مؤقت', en: 'Pause' }, path: (id) => `/campaigns/${id}/pause`, restoreTool: 'campaign_resume', description: 'Pause a running or scheduled campaign. Nothing already sent is recalled; resuming needs the merchant to confirm.' }, kit),
    stateTool({ tool: 'campaign_resume', to: 'running', capability: 'campaigns.resume', policy: 'confirm', undo: 'reversible', from: ['paused'], verb: { ar: 'استكمال', en: 'Resume' }, path: (id) => `/campaigns/${id}/resume`, money: true, messages: true, restoreTool: 'campaign_pause', description: 'Resume a paused campaign. It continues messaging customers and spending the wallet, so the merchant confirms with the button.' }, kit),
    stateTool({ tool: 'campaign_cancel', to: 'cancelled', capability: 'campaigns.cancel', policy: 'confirm', undo: 'irreversible', from: ['scheduled', 'running', 'paused'], verb: { ar: 'إلغاء', en: 'Cancel' }, path: (id) => `/campaigns/${id}/cancel`, description: 'Cancel a campaign for good. Messages already sent stay sent; the rest are never sent. It cannot be undone, so the merchant confirms.' }, kit),
    stateTool({ tool: 'campaign_delete_draft', to: 'deleted', capability: 'campaigns.delete-draft', policy: 'confirm', undo: 'irreversible', from: ['draft'], verb: { ar: 'مسح مسودة', en: 'Delete the draft of' }, path: (id) => `/campaigns/${id}`, method: 'DELETE', deletes: true, description: 'Delete a draft campaign that was never sent. It cannot be undone, so the merchant confirms.' }, kit),
  ];
}
