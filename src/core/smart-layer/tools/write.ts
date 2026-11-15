/**
 * The shape every Chat WRITE tool shares (plan 4 Task B8). A tool is data: how to read the current state through the merchant's own routes, what the
 * change would be (a pure `plan`), and how to put it back. This file turns that into the engine's `ToolSpec`:
 *  - `preview` reads the state and builds the card; its etag is the hash of the state it read (a changed state at apply time re-previews);
 *  - `apply` re-reads, re-plans and sends the ONE request through the merchant's own route (SL-CHAT-1), then re-reads for `etagAfter`;
 *  - `inverse` is the same tool with the before-state (or another tool the plan names), so undo goes through the same authorization.
 * The model never names a store, a path or a phone number. A customer or segment is found from the name the merchant typed, in the merchant's own
 * lists (route answers), so an invented reference simply finds nothing. Nothing identifying a contact is stored in the draft payload: it carries the
 * request BODY and the restore arguments, never the path.
 */
import { z } from 'zod';
import { foldArabic } from '../../../../foundation/text';
import { canonicalJson, sha256Hex } from '../../../../foundation/smart-layer/release';
import { ToolForbidden } from '../../../../foundation/smart-layer/exec/journal';
import type { InverseOp, PreviewDraft, PreviewRow, ToolSpec, TurnCtx, UndoClass } from '../../../../foundation/smart-layer/types';
import { ToolApiError, type CallApi, type CallInit } from './read.tools';

export type L = { ar: string; en: string };
export type Req = { method: CallInit['method']; path: string; body?: unknown };
/** `ask` is a POST that only answers a question (an audience size, a settings-confirm token is NOT one): it never changes anything. */
export type Reader = { get(path: string, query?: Record<string, string>): Promise<unknown>; ask(path: string, body: unknown): Promise<unknown> };

/** A request the model's words cannot be turned into a change from: no match, several matches, or nothing to change. The engine shows the model a generic failure. */
export class ToolInputError extends Error {
  constructor(readonly code: 'not_found' | 'ambiguous' | 'no_change' | 'unavailable' | 'invalid') {
    super(code);
    this.name = 'ToolInputError';
  }
}

export type Plan = {
  summary: L;
  rows: PreviewRow[];
  request: Req;
  /** What puts the before-state back: arguments of the same tool, or `{ tool, args }` for another one. Absent = no inverse is offered. */
  restore?: unknown | { tool: string; args: unknown };
  affected?: number;
  changesPrice?: boolean;
  touchesCheckout?: boolean;
  /** AI credits this change costs (shown on the card). The tool HOLDS them when it prepares the preview; `settle` charges them only on the merchant's press. */
  cost?: number;
  /** The credit hold behind this preview. It travels in the stored draft so the reject route can give it back. */
  hold?: string;
  /** The request body carries a phone number or similar: keep it out of the stored draft (apply re-plans from the arguments anyway). */
  hideBody?: boolean;
};

export interface WriteDef<A, S> {
  name: string;
  capabilityId: string;
  description: string;
  args: z.ZodType<A>;
  policy: 'preview' | 'confirm';
  undo: UndoClass;
  money?: boolean;
  deletes?: boolean;
  messagesCustomers?: boolean;
  /** Current state, read through the merchant's routes. Throws `ToolInputError` for "no such customer" and the like. */
  read(api: Reader, ctx: TurnCtx, a: A): Promise<S>;
  /** The change, a pure function of the arguments and the state just read. Throws `ToolInputError('no_change')` when it would change nothing. */
  plan(a: A, s: S, ctx: TurnCtx): Plan | Promise<Plan>;
  /** What makes the state different from another for the etag (default: all of it). Keep identifying data (phone numbers) out of it. */
  fingerprint?(s: S): unknown;
  /** Extra send step (e.g. the settings confirm token the route itself requires before it will turn a switch on). */
  send?(call: (r: Req) => Promise<unknown>, plan: Plan, a: A, ctx: TurnCtx): Promise<unknown>;
  /** After the change went through: settle what the merchant agreed to pay. Idempotent calls only; a failure here never undoes the change. */
  settle?(s: S, ctx: TurnCtx): Promise<void>;
}

const ok = async (p: Promise<{ status: number; json: unknown }>): Promise<unknown> => {
  const r = await p;
  if (r.status < 200 || r.status >= 300) throw new ToolApiError(r.status);
  return r.json;
};

/** The JSON Schema the model sees (no `$schema` key: OpenAI-compatible endpoints reject unknown top-level keys less gracefully than they ignore a missing one). */
export function schemaOf(args: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(args, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
}

const hash = (v: unknown): Promise<string> => sha256Hex(canonicalJson(v ?? null));

/** What a tool factory is given: the route caller and a lookup of the sibling tools (an undo that lands on another tool must compare against THAT tool's view of the state). */
export type Kit = {
  callApi: CallApi;
  find(name: string): ToolSpec | undefined;
  /** The heavy jobs' own plumbing (the template writer): one model call on the `template` job, a short-lived draft cache, and AI credits held before the call. */
  writer?: {
    complete(system: string, user: string): Promise<string>;
    cache: { get(key: string): Promise<string | null>; put(key: string, json: string): Promise<void> };
    credits: { hold(ref: string, credits: number): Promise<'held' | 'already_charged' | 'insufficient'>; settle(ref: string): Promise<unknown>; release(ref: string): Promise<void> };
  };
};

export function writeTool<A, S>(def: WriteDef<A, S>, kit: Kit): ToolSpec {
  const callApi = kit.callApi;
  const reader = (ctx: TurnCtx): Reader => ({ get: (path, query) => ok(callApi(ctx, path, query)), ask: (path, body) => ok(callApi(ctx, path, undefined, { method: 'POST', body })) });
  const sender = (ctx: TurnCtx) => (r: Req) => ok(callApi(ctx, r.path, undefined, { method: r.method, ...(r.body !== undefined ? { body: r.body } : {}) }));
  const load = async (ctx: TurnCtx, a: A) => {
    const s = await def.read(reader(ctx), ctx, a);
    return { s, plan: await def.plan(a, s, ctx) };
  };
  const spec: ToolSpec<A> = {
    name: def.name, capabilityId: def.capabilityId, description: def.description, args: def.args, jsonSchema: schemaOf(def.args),
    policy: def.policy, undo: def.undo, resultTrust: 'store-data',
    ...(def.money ? { money: true } : {}), ...(def.deletes ? { deletes: true } : {}), ...(def.messagesCustomers ? { messagesCustomers: true } : {}),
    async preview(ctx, a): Promise<PreviewDraft> {
      const { s, plan } = await load(ctx, a);
      return {
        summary: plan.summary, rows: plan.rows, affectedCount: plan.affected ?? 1, etag: await hash(def.fingerprint ? def.fingerprint(s) : s),
        payload: { op: def.name, body: plan.hideBody ? null : plan.request.body ?? null, restore: plan.restore ?? null, ...(plan.hold ? { hold: plan.hold } : {}) },
        ...(plan.changesPrice ? { changesPrice: true } : {}), ...(plan.touchesCheckout ? { touchesCheckout: true } : {}), ...(plan.cost !== undefined ? { costCredits: plan.cost } : {}),
      };
    },
    async apply(ctx, a) {
      const { s: state, plan } = await load(ctx, a);
      const call = sender(ctx);
      try {
        await (def.send ? def.send(call, plan, a, ctx) : call(plan.request));
      } catch (e) {
        // The route's own authorization said no (role, plan, seat): the engine records it as the product's refusal, not a failure.
        if (e instanceof ToolApiError && (e.status === 401 || e.status === 403)) throw new ToolForbidden();
        throw e;
      }
      await def.settle?.(state, ctx).catch(() => undefined); // the change is made: charging for it must not turn it into a failure (settle is idempotent, a retry finds it done)
      // What undo will compare against is the state as the INVERSE tool reads it: another tool's view when the undo is a different action (a created segment is undone by a delete).
      const r = plan.restore as { tool?: string; args?: unknown } | null | undefined;
      const inv = r && typeof r === 'object' && 'tool' in r && r.tool && r.tool !== def.name ? kit.find(r.tool) : undefined;
      if (inv?.preview) {
        const parsed = inv.args.safeParse(r!.args);
        const d = parsed.success ? await inv.preview(ctx, parsed.data).catch(() => null) : null;
        return { ok: true, etagAfter: d ? d.etag : '' };
      }
      const after = await def.read(reader(ctx), ctx, a).catch(() => null);
      return { ok: true, etagAfter: await hash(after === null ? null : def.fingerprint ? def.fingerprint(after) : after) };
    },
    inverse(_ctx, _a, draft): InverseOp | null {
      const r = (draft.payload as { restore?: unknown } | null)?.restore;
      if (r === null || r === undefined) return null;
      if (typeof r === 'object' && r !== null && 'tool' in r && 'args' in r) return r as InverseOp;
      return { tool: def.name, args: r };
    },
  };
  return spec as unknown as ToolSpec;
}

// ---- finding what the merchant meant, in their own lists ------------------------------------------------------------------------------

const same = (a: string, b: string): boolean => foldArabic(a.trim()).toLowerCase() === foldArabic(b.trim()).toLowerCase();

/**
 * The one item whose name is `wanted`: an exact (folded) match wins; anything else is not a guess. `single` (search answers only: the route already filtered by what the
 * merchant typed) also takes a lone candidate; a FULL list never does, so an invented name never lands on the only item that exists.
 */
export function pickByName<T>(items: readonly T[], nameOf: (t: T) => string | null | undefined, wanted: string, o: { single?: boolean } = {}): T {
  const exact = items.filter((t) => { const n = nameOf(t); return n != null && same(n, wanted); });
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw new ToolInputError('ambiguous');
  if (o.single && items.length === 1) return items[0]!;
  throw new ToolInputError(items.length === 0 || !o.single ? 'not_found' : 'ambiguous');
}

export type ConvItem = { id: number; contact: { name: string | null; waId?: string; optedOut?: boolean }; tags: string[]; assigneeUserId: string | null; unread?: number; windowOpenUntil?: number | null };
/** Who a conversation really is, for a card: the MATCHED contact's name and the last 3 digits of the number, never the words the model typed. */
export const matchedLabel = (c: ConvItem): { name: string | null; last3: string | null; text: string } => {
  const last3 = c.contact.waId ? c.contact.waId.slice(-3) : null;
  return { name: c.contact.name, last3, text: `${c.contact.name ?? '؟'}${last3 ? ` (…${last3})` : ''}` };
};
/**
 * `strict` is for anything that reaches a customer or cannot be undone: exactly ONE conversation may match what was typed, however exact one of several looks. More than
 * one plausible person is the merchant's to pick, so the tool refuses (the merchant is asked for the full name) rather than choose.
 */
export async function findConversation(api: Reader, customer: string, conversation?: number, o: { strict?: boolean } = {}): Promise<ConvItem> {
  const r = (await api.get('/conversations', { q: customer, limit: '10' })) as { items?: ConvItem[] };
  const items = r.items ?? [];
  if (o.strict) {
    if (items.length === 0) throw new ToolInputError('not_found');
    if (items.length > 1) throw new ToolInputError('ambiguous');
    return items[0]!;
  }
  if (conversation !== undefined) {
    const hit = items.find((c) => c.id === conversation);
    if (!hit) throw new ToolInputError('not_found');
    return hit;
  }
  return pickByName(items, (c) => c.contact.name, customer, { single: true });
}

export type ContactItem = { waId: string; name: string | null; tags?: string[]; optedOut: boolean };
export async function findContact(api: Reader, customer: string): Promise<ContactItem> {
  const r = (await api.get('/contacts', { q: customer, limit: '10' })) as { items?: ContactItem[] };
  return pickByName(r.items ?? [], (c) => c.name, customer, { single: true });
}

export const row = (ar: string, en: string, before?: unknown, after?: unknown, source?: PreviewRow['source']): PreviewRow => ({ label: { ar, en }, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), ...(source ? { source } : {}) });
export const clip = (s: string, n = 400): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * An idempotency key that belongs to the PREVIEW, not to the press: the apply routes carry the preview id in `ctx.conversationId`, so a crashed apply that is retried
 * (on a fresh approval of the same preview) derives the same key and the route answers with the message it already queued instead of sending a second one.
 */
export async function stableUuid(ctx: Pick<TurnCtx, 'storeId' | 'conversationId'>, req: Pick<Req, 'method' | 'path'>): Promise<string> {
  const h = await sha256Hex(`${ctx.storeId}|${ctx.conversationId}|${req.method} ${req.path}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[Number.parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
