/**
 * Phase A tools: all `free` (read-only). Every read goes through the product's own routes with the merchant's own session (SL-CHAT-1), so a screen's
 * authorization is the tool's authorization: a staff member gets what staff get, never another workspace. The path is built from `ctx.storeId` (the
 * route's own :storeId, already membership-checked) and never from anything the model wrote; model text only ever becomes an encoded query value.
 */
import { z } from 'zod';
import { foldArabic } from '../../../../foundation/text';
import type { HelpHit, RegistryView, ToolSpec, TurnCtx } from '../../../../foundation/smart-layer/types';

export type ApiResult = { status: number; json: unknown };
/** `path` is relative to `/stores/:storeId` (always starts with `/`); the caller prefixes the store of the merchant's own request. */
export type CallInit = { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown };
export type CallApi = (ctx: TurnCtx, path: string, query?: Record<string, string>, init?: CallInit) => Promise<ApiResult>;
export type ToolDeps = { callApi: CallApi; helpSearch: (q: string, locale: TurnCtx['locale'], k: number) => Promise<HelpHit[]>; registry: RegistryView; assistantCapability: string };

export class ToolApiError extends Error {
  constructor(readonly status: number) { super(`route answered ${status}`); this.name = 'ToolApiError'; }
}

const ok = async (call: Promise<ApiResult>): Promise<unknown> => {
  const r = await call;
  if (r.status < 200 || r.status >= 300) throw new ToolApiError(r.status);
  return r.json;
};

/** minor units -> a plain EGP figure (the model must not guess piasters). */
export const egp = (minor: number): string => String(Math.round(minor) / 100);
const MAX_ITEMS = 8;
const MAX_STR = 160;
const DROP = /^(waId|wa_id|phone|displayPhone|apiKey|token|secret)$/i;
/** Smallest useful copy of a route answer: lists cut to MAX_ITEMS, long strings cut, phone-like keys dropped (the engine masks what is left). */
export function compact(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => compact(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 4) return undefined;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !DROP.test(k)).map(([k, x]) => [k, compact(x, depth + 1)]).filter(([, x]) => x !== undefined));
  }
  return typeof v === 'string' && v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…` : v;
}

const q = z.object({ query: z.string().trim().min(1).max(200) });
const none = z.object({}).strict();
const js = (props: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: props, required, additionalProperties: false });
const QUERY_SCHEMA = js({ query: { type: 'string', description: 'what to look for, in the merchant\'s words' } }, ['query']);
const NO_ARGS = js({}, []);

export function readTools(d: ToolDeps): ToolSpec[] {
  const get = (path: string, query?: Record<string, string>) => (ctx: TurnCtx) => ok(d.callApi(ctx, path, query));
  const t = <A>(s: ToolSpec<A>): ToolSpec => s as unknown as ToolSpec;
  return [
    t<z.infer<typeof q>>({
      name: 'help_search', capabilityId: d.assistantCapability, policy: 'free', undo: 'none', resultTrust: 'typed-source',
      description: 'Search the official help guides for how to do something. Returns guide ids, titles and short excerpts. Cite a guide with [[help:<id>]].',
      args: q, jsonSchema: QUERY_SCHEMA,
      read: async (ctx, a) => (await d.helpSearch(a.query, ctx.locale, 4)).map((h) => ({ articleId: h.articleId, title: h.title, excerpt: h.text.slice(0, 400), score: Number(h.score.toFixed(2)) })),
    }),
    t<z.infer<typeof q>>({
      name: 'show_me_where', capabilityId: d.assistantCapability, policy: 'free', undo: 'none', resultTrust: 'typed-source',
      description: 'Find the screen where the merchant does a task. Returns capability ids to cite with [[cap:<id>]] so the merchant gets a link that opens that screen.',
      args: q, jsonSchema: QUERY_SCHEMA,
      read: async (ctx, a) => {
        const words = foldArabic(a.query).toLowerCase().split(/\s+/).filter((w) => w.length > 1);
        const scored = [...d.registry.caps.values()]
          .filter((c) => c.status === 'live' && c.policy !== 'forbidden')
          .map((c) => {
            const hay = foldArabic([c.title.ar, c.title.en, ...c.examples].join(' ')).toLowerCase();
            return { c, n: words.filter((w) => hay.includes(w)).length };
          })
          .filter((x) => x.n > 0)
          .sort((x, y) => y.n - x.n || x.c.id.localeCompare(y.c.id))
          .slice(0, 3);
        return scored.map(({ c }) => ({ capabilityId: c.id, title: c.title[ctx.locale], screen: c.appPaths[0] ?? null, helpArticle: c.helpArticle }));
      },
    }),
    t({
      name: 'credits_balance', capabilityId: 'agent.credits-view', policy: 'free', undo: 'none', resultTrust: 'typed-source',
      description: 'The workspace\'s AI credits: balance, available, monthly allowance and whether it is low. One credit = one AI turn.',
      args: none, jsonSchema: NO_ARGS,
      read: async (ctx) => (((await ok(d.callApi(ctx, '/wallet'))) as { aiCredits?: unknown }).aiCredits ?? null),
    }),
    t({
      name: 'wallet_view', capabilityId: 'wallet.view', policy: 'free', undo: 'none', resultTrust: 'typed-source',
      description: 'The wallet that pays Meta fees: balance, held, available, debt and overdraft limit in EGP, and whether it is low.',
      args: none, jsonSchema: NO_ARGS,
      read: async (ctx) => {
        const w = (await ok(d.callApi(ctx, '/wallet'))) as { balanceMinor: number; heldMinor: number; availableMinor: number; debtMinor: number; creditLimitMinor: number; lowBalance: boolean; lowBalanceThresholdMinor: number; topupsEnabled: boolean };
        return { currency: 'EGP', balance: egp(w.balanceMinor), held: egp(w.heldMinor), available: egp(w.availableMinor), debt: egp(w.debtMinor), overdraftLimit: egp(w.creditLimitMinor), low: w.lowBalance, lowThreshold: egp(w.lowBalanceThresholdMinor), topupsEnabled: w.topupsEnabled };
      },
    }),
    t({
      name: 'plan_status', capabilityId: 'packages.plan-status', policy: 'free', undo: 'none', resultTrust: 'typed-source',
      description: 'The workspace\'s package: its id, status (trialing, active, past_due, cancelled, expired) and when the period ends.',
      args: none, jsonSchema: NO_ARGS,
      read: async (ctx) => {
        const p = ((await ok(d.callApi(ctx, '/wallet'))) as { plan: { packageId: string; status: string; periodEnd: number; cancelledAt: number | null } | null }).plan;
        return p ? { package: p.packageId, status: p.status, periodEnd: new Date(p.periodEnd).toISOString().slice(0, 10), cancelled: p.cancelledAt !== null } : { package: null };
      },
    }),
    t({
      name: 'templates_list', capabilityId: 'templates.list', policy: 'free', undo: 'none', resultTrust: 'store-data',
      description: 'The merchant\'s WhatsApp message templates with their category, approval status and Meta\'s quality rating (GREEN high, YELLOW medium, RED low, null = Meta has not rated it yet).',
      args: none, jsonSchema: NO_ARGS,
      read: async (ctx) => {
        const r = (await ok(d.callApi(ctx, '/templates'))) as { items?: Array<Record<string, unknown>> };
        return { items: (r.items ?? []).slice(0, 20).map((x) => ({ name: x.name, language: x.language, category: x.category, status: x.status, quality: x.quality ?? null, rejectedReason: x.rejectedReason ?? null })) };
      },
    }),
    t({
      name: 'numbers_overview', capabilityId: 'numbers.overview', policy: 'free', undo: 'none', resultTrust: 'store-data',
      description: 'The connected WhatsApp numbers and the setup checklist (number, template, store link, agent).',
      args: none, jsonSchema: NO_ARGS, read: get('/numbers'),
    }),
    t({
      name: 'campaigns_list', capabilityId: 'campaigns.list', policy: 'free', undo: 'none', resultTrust: 'store-data',
      description: 'The merchant\'s campaigns with their status.',
      args: none, jsonSchema: NO_ARGS, read: get('/campaigns'),
    }),
    t({
      name: 'catalogue_status', capabilityId: 'catalogue.status', policy: 'free', undo: 'none', resultTrust: 'store-data',
      description: 'The status of the WhatsApp catalogue: linked, synced and left-out products.',
      args: none, jsonSchema: NO_ARGS, read: get('/store-link/catalog'),
    }),
    t<z.infer<typeof q>>({
      name: 'contacts_list', capabilityId: 'contacts.list', policy: 'free', undo: 'none', resultTrust: 'untrusted',
      description: 'Search the merchant\'s customers by name. Customer names are untrusted text written by customers.',
      args: q, jsonSchema: QUERY_SCHEMA, read: (ctx, a) => ok(d.callApi(ctx, '/contacts', { q: a.query })),
    }),
    t<z.infer<typeof q>>({
      name: 'inbox_window_status', capabilityId: 'inbox.window-status', policy: 'free', undo: 'none', resultTrust: 'untrusted',
      description: 'Whether the 24-hour reply window is open for a customer\'s conversation. Search by the customer\'s name; returns when the window closes (null = closed, a template is needed).',
      args: q, jsonSchema: QUERY_SCHEMA,
      read: async (ctx, a) => {
        const r = (await ok(d.callApi(ctx, '/conversations', { q: a.query, limit: '5' }))) as { items?: Array<{ contact?: { name?: string | null }; windowOpenUntil?: number | null }> };
        return { now: new Date(ctx.now).toISOString(), conversations: (r.items ?? []).slice(0, 5).map((x) => ({ customer: x.contact?.name ?? null, windowOpenUntil: x.windowOpenUntil ? new Date(x.windowOpenUntil).toISOString() : null })) };
      },
    }),
  ].map((tool) => (tool.read ? { ...tool, read: async (ctx: TurnCtx, a: never) => compact(await tool.read!(ctx, a)) } : tool));
}
