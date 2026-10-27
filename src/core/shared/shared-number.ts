/**
 * The shared platform number (Phase 8.2). Several stores send from ONE number and customers answer it, so an inbound message cannot be
 * routed by who owns the number. It is routed by who last wrote to that customer (`shared_routes`), and:
 *  - more than one store wrote within 24 h → the customer gets ONE interactive list of store display names; their message waits
 *    (R2, `shared-parked/`) until they tap, then it and what follows go to the chosen store (Ruling WA-SHARED-PIN-1);
 *  - nobody wrote to them → one polite generic reply a day, nothing is stored anywhere;
 *  - a routing decision never puts one store's name, conversation or customer into another store's reach: the list carries display names only.
 * D1 keeps no message content and no raw phone number: a customer is a keyed hash (customerKey). Funding of the number is `platform_line`
 * (the wallet pays Meta, WA-FUND-1), written explicitly at setup; a number with no funding row cannot send (fail closed, see billing/pricing).
 */
import type { Env } from '../../env';
import type { SharedNumberCopy } from '../../brand';
import { z } from 'zod';
import { canonicalDisplayName } from '../api/contract';
import { fundingStatement } from '../billing/funding';
import { detectOptOutMessage } from '../consent';
import { sendList, sendText } from '../meta/client';
import type { InboundMessage, StatusEvent, WebhookEvents } from '../meta/webhook-schema';
import type { SendJob } from '../send-queue';
import type { WorkspaceConfig } from '../workspace-do';
import { alert } from '../observability';

export const sharedEnabled = (env: Pick<Env, 'SHARED_NUMBER_ENABLED'>): boolean => env.SHARED_NUMBER_ENABLED === '1' || env.SHARED_NUMBER_ENABLED?.toLowerCase() === 'true';

/** Two stores that wrote to the same customer within this window make a reply ambiguous. */
/** How long a store's contact with a customer counts when another store writes too: within it, the customer chooses (never a silent takeover). */
export const ROUTE_MEMORY_MS = 30 * 24 * 3_600_000;
/** A message waiting for the customer's choice is kept this long, then swept (the daily pass). */
export const PARKED_TTL_MS = 48 * 3_600_000;
/** One "which store?" list per customer per this long; one generic no-route reply per customer per this long. */
export const MARKER_TTL_MS = 24 * 3_600_000;
export const SENT_RETENTION_MS = 35 * 24 * 3_600_000;
/** Row ids of the "which store?" list; the rest is the workspace id. The prefix keeps a store's own list from ever being read as a choice. */
export const PICK_PREFIX = 'shared:pick:';
const MAX_ROWS = 10;
const ROW_TITLE_MAX = 24;

type Db = Pick<Env, 'DB'>;

// ---- keys --------------------------------------------------------------------------------------------------------------

/** HMAC-SHA256(META_APP_SECRET, "shared-route:v1:" + WhatsApp id) as hex. Ruling WA-SHARED-KEY-1. */
export async function customerKey(env: Pick<Env, 'META_APP_SECRET'>, waId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.META_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`shared-route:v1:${waId}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- the number and its members -----------------------------------------------------------------------------------------

export type SharedNumberRow = { phone_number_id: string; waba_id: string; display_phone: string | null };

export async function sharedNumberById(env: Db, phoneNumberId: string): Promise<SharedNumberRow | null> {
  return env.DB.prepare('SELECT phone_number_id, waba_id, display_phone FROM shared_numbers WHERE phone_number_id = ?').bind(phoneNumberId).first<SharedNumberRow>();
}

/** The platform number members join (the oldest registered one). */
export async function currentSharedNumber(env: Db): Promise<SharedNumberRow | null> {
  return env.DB.prepare('SELECT phone_number_id, waba_id, display_phone FROM shared_numbers ORDER BY created_at, rowid LIMIT 1').first<SharedNumberRow>();
}

export async function isActiveMember(env: Db, workspaceId: string, phoneNumberId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM shared_number_members WHERE workspace_id = ? AND phone_number_id = ? AND status = 'active'").bind(workspaceId, phoneNumberId).first());
}

/**
 * Operator setup. The number and its funding are written in ONE batch and the funding is named here, never defaulted: the platform number is
 * paid by the wallet (`platform_line`). Re-running re-asserts both. A number a store already owns is refused.
 */
export async function registerPlatformNumber(env: Env, a: { phoneNumberId: string; wabaId: string; displayPhone?: string; actor: string; reason: string }, now = Date.now()): Promise<'ok' | 'conflict'> {
  if (await env.DB.prepare('SELECT 1 FROM phone_numbers WHERE phone_number_id = ?').bind(a.phoneNumberId).first()) return 'conflict';
  const before = await sharedNumberById(env, a.phoneNumberId);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO shared_numbers (phone_number_id, waba_id, display_phone, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(phone_number_id) DO UPDATE SET waba_id = excluded.waba_id, display_phone = coalesce(excluded.display_phone, display_phone)`,
    ).bind(a.phoneNumberId, a.wabaId, a.displayPhone ?? null, now),
    fundingStatement(env.DB, a.phoneNumberId, 'platform_line', now),
    env.DB.prepare('INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) VALUES (?, ?, ?, NULL, ?, ?, ?)')
      .bind(now, a.actor, 'shared_number_registered', before ? JSON.stringify({ wabaId: before.waba_id }) : null, JSON.stringify({ phoneNumberId: a.phoneNumberId, wabaId: a.wabaId, funding: 'platform_line' }), a.reason),
  ]);
  return 'ok';
}

export type SharedStatus = { available: boolean; member: boolean; displayName: string | null; displayPhone: string | null; /** True when the store is not a member and its plan does not include the shared number (joining would be refused 402). */ packageRequired: boolean };

export async function sharedStatus(env: Env, workspaceId: string): Promise<SharedStatus> {
  const num = await currentSharedNumber(env);
  if (!num) return { available: false, member: false, displayName: null, displayPhone: null, packageRequired: false };
  const m = await env.DB.prepare("SELECT display_name FROM shared_number_members WHERE workspace_id = ? AND phone_number_id = ? AND status = 'active'").bind(workspaceId, num.phone_number_id).first<{ display_name: string }>();
  return { available: true, member: !!m, displayName: m?.display_name ?? null, displayPhone: num.display_phone, packageRequired: !m && !(await sharedPackageAllowed(env, workspaceId)) };
}

// Every entry maps straight to its final letter (i → l, so і/ї/ι → l too): one pass is the whole skeleton.
// Letters from other scripts that render like a Latin or Arabic letter, and characters that read as one another (a TR39-style skeleton, kept small).
const LOOKALIKE: Record<string, string> = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'l', 'ї': 'l', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w',
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'l', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ς': 's',
  '0': 'o', '1': 'l', 'i': 'l',
  'ی': 'ي', 'ې': 'ي', 'ک': 'ك', 'ڪ': 'ك', 'ہ': 'ه', 'ۀ': 'ه', 'ۃ': 'ه', 'ھ': 'ه',
};

/**
 * The comparison key for a display name, taken over what a customer actually sees (the list row clips long names): Unicode compatibility
 * forms folded (full-width letters), case folded, Arabic diacritics and tatweel removed, alef/yaa/kaf/haa/taa-marbuta variants unified,
 * Arabic-Indic and Persian digits made ASCII, look-alike letters mapped to one skeleton, all spacing and punctuation dropped.
 * Two names with one key look the same to a customer.
 */
export function displayNameKey(name: string): string {
  const folded = clip(canonicalDisplayName(name), ROW_TITLE_MAX).normalize('NFKC').toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
  return Array.from(folded, (ch) => LOOKALIKE[ch] ?? ch).join('').replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The package gate: the workspace's plan must be active or trialing, not past its period, and its package must include the shared number
 * (`packages.shared_number = 1`). The plan is the workspace's own copy (event-pushed, never-stale for status); a package the control plane
 * does not know, or no plan on record, is refused (fail closed).
 */
export async function sharedPackageAllowed(env: Env, workspaceId: string, now = Date.now()): Promise<boolean> {
  const e = await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId)).getEntitlement();
  if (!e || (e.status !== 'active' && e.status !== 'trialing') || e.periodEnd <= now) return false;
  const p = await env.DB.prepare('SELECT shared_number FROM packages WHERE id = ?').bind(e.packageId).first<{ shared_number: number }>();
  return p?.shared_number === 1;
}

export async function joinShared(env: Env, workspaceId: string, displayName?: string, now = Date.now()): Promise<SharedStatus | null | 'name_taken' | 'package_required'> {
  const num = await currentSharedNumber(env);
  if (!num) return null;
  const raw = displayName ?? (await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(workspaceId).first<{ name: string }>())?.name;
  const name = raw === undefined ? undefined : canonicalDisplayName(raw);
  if (!name) return null;
  if (!(await sharedPackageAllowed(env, workspaceId, now))) return 'package_required';
  try {
    await env.DB.prepare(
      `INSERT INTO shared_number_members (workspace_id, phone_number_id, display_name, name_key, status, joined_at) VALUES (?, ?, ?, ?, 'active', ?)
       ON CONFLICT(workspace_id, phone_number_id) DO UPDATE SET display_name = excluded.display_name, name_key = excluded.name_key,
         joined_at = CASE WHEN status = 'active' THEN joined_at ELSE excluded.joined_at END, status = 'active'`,
    ).bind(workspaceId, num.phone_number_id, name, displayNameKey(name), now).run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) return 'name_taken';
    throw err;
  }
  // The store's copy of the funding map is refreshed at once, so the number is usable now rather than after the next pull.
  await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId)).refreshPricing();
  return sharedStatus(env, workspaceId);
}

export async function leaveShared(env: Env, workspaceId: string): Promise<SharedStatus> {
  await env.DB.batch([
    env.DB.prepare("UPDATE shared_number_members SET status = 'left' WHERE workspace_id = ? AND status = 'active'").bind(workspaceId),
    env.DB.prepare('DELETE FROM shared_routes WHERE workspace_id = ?').bind(workspaceId),
  ]);
  await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId)).refreshPricing();
  return sharedStatus(env, workspaceId);
}

/**
 * The number a store sends from: its own active number, else (switch on, member) the platform number. `shared` marks the latter: the
 * platform WABA's templates and catalog are not the store's to manage.
 */
export async function senderNumberFor(env: Env, workspaceId: string): Promise<{ phoneNumberId: string; wabaId: string; shared: boolean } | null> {
  const own = await env.DB.prepare("SELECT phone_number_id, waba_id FROM phone_numbers WHERE workspace_id = ? AND status = 'active' ORDER BY rowid LIMIT 1").bind(workspaceId).first<{ phone_number_id: string; waba_id: string }>();
  if (own) return { phoneNumberId: own.phone_number_id, wabaId: own.waba_id, shared: false };
  if (!sharedEnabled(env)) return null;
  const sh = await env.DB.prepare(
    "SELECT n.phone_number_id, n.waba_id FROM shared_number_members m JOIN shared_numbers n ON n.phone_number_id = m.phone_number_id WHERE m.workspace_id = ? AND m.status = 'active' ORDER BY n.created_at LIMIT 1",
  ).bind(workspaceId).first<{ phone_number_id: string; waba_id: string }>();
  return sh ? { phoneNumberId: sh.phone_number_id, wabaId: sh.waba_id, shared: true } : null;
}

// ---- outbound bookkeeping ----------------------------------------------------------------------------------------------------

/**
 * Before a send through a platform-token number. 'not_shared' = an ordinary number; 'refused' = it is the shared number but the switch is off,
 * the store is not an active member, or the message carries the platform's own "which store?" ids (a store could otherwise forge the
 * customer's choice); 'shared' = the caller sends and then calls `afterSharedSend` with Meta's message id.
 */
export async function beforeSharedSend(env: Env, job: Pick<SendJob, 'workspaceId' | 'phoneNumberId' | 'to' | 'list' | 'interactive' | 'kind'>): Promise<'not_shared' | 'refused' | 'lapsed' | 'shared'> {
  if (!(await sharedNumberById(env, job.phoneNumberId))) return 'not_shared';
  if (!sharedEnabled(env) || !(await isActiveMember(env, job.workspaceId, job.phoneNumberId))) return 'refused';
  const ids = [...(job.list?.rows ?? []).map((r) => r.id), ...(job.interactive?.buttons ?? []).map((b) => b.id)];
  if (ids.some((id) => id.startsWith(PICK_PREFIX))) {
    alert('shared_pick_id_refused', { workspace: job.workspaceId });
    return 'refused';
  }
  // A member whose plan lapsed (or never included the number) keeps receiving and may answer, but cannot START a conversation: a template is
  // how a conversation is started outside the 24 h window, so it is refused. Free-form replies stay allowed (marketing is gated elsewhere).
  if ((job.kind ?? 'text') === 'template' && !(await sharedPackageAllowed(env, job.workspaceId))) return 'lapsed';
  return 'shared';
}

/**
 * After Meta ACCEPTED a send from the platform number: only now does the store hold a route to this customer (a refused send claims
 * nothing), and Meta's statuses for `wamid` can reach that store. A failure is an alert, never a retry of an accepted send.
 */
export async function afterSharedSend(env: Env, job: Pick<SendJob, 'workspaceId' | 'phoneNumberId' | 'to' | 'orderRef'>, wamid: string, now = Date.now()): Promise<void> {
  // The send is accepted and must never be repeated, so the record is retried (a few immediate attempts) before it is given up as an alert.
  for (let attempt = 1; attempt <= AFTER_SEND_ATTEMPTS; attempt++) {
    try {
      const key = await customerKey(env, job.to);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO shared_routes (phone_number_id, customer_key, workspace_id, last_at, order_ref) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(phone_number_id, customer_key, workspace_id) DO UPDATE SET last_at = max(last_at, excluded.last_at), order_ref = coalesce(excluded.order_ref, order_ref)`,
        ).bind(job.phoneNumberId, key, job.workspaceId, now, job.orderRef ?? null),
        env.DB.prepare('INSERT OR IGNORE INTO shared_sent (wamid, workspace_id, customer_key, at) VALUES (?, ?, ?, ?)').bind(wamid, job.workspaceId, key, now),
      ]);
      return;
    } catch (err) {
      if (attempt < AFTER_SEND_ATTEMPTS) continue;
      alert('shared_sent_not_recorded', { workspace: job.workspaceId, attempts: attempt, error: err instanceof Error ? err.name : 'error' });
    }
  }
}
const AFTER_SEND_ATTEMPTS = 3;

/**
 * Erasure of one contact in one store: its routes and sent-message map go (other stores' rows stay). Dropping this store's routes also
 * removes it from the customer's candidate / pick list, so the customer can never be routed back to it. The sender's parked messages in R2
 * (`shared-parked/<number>/<customer_key>/`, raw text) are shared by every candidate store, so they are deleted ONLY for a number where this
 * store is the sole candidate; where another store is still a candidate they stay for it. The parked keys are handed to `owe` BEFORE anything
 * is deleted (the caller records them in its r2_pending_deletes, which retries until R2 confirms).
 */
export async function eraseSharedFor(env: Env, workspaceId: string, waId: string, owe: (keys: string[]) => void = () => {}): Promise<void> {
  const key = await customerKey(env, waId);
  const numbers = await env.DB.prepare(
    `SELECT DISTINCT r.phone_number_id FROM shared_routes r WHERE r.customer_key = ? AND r.workspace_id = ?
       AND NOT EXISTS (SELECT 1 FROM shared_routes o WHERE o.phone_number_id = r.phone_number_id AND o.customer_key = r.customer_key AND o.workspace_id <> r.workspace_id)`,
  ).bind(key, workspaceId).all<{ phone_number_id: string }>();
  const keys: string[] = [];
  for (const { phone_number_id: pn } of numbers.results) {
    let cursor: string | undefined;
    do {
      const page = await env.MEDIA.list({ prefix: parkedPrefix(pn, key), ...(cursor ? { cursor } : {}) });
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  if (keys.length) owe(keys);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shared_routes WHERE workspace_id = ? AND customer_key = ?').bind(workspaceId, key),
    env.DB.prepare('DELETE FROM shared_sent WHERE workspace_id = ? AND customer_key = ?').bind(workspaceId, key),
  ]);
}

// ---- routing decision -----------------------------------------------------------------------------------------------------

export type Candidate = { workspace_id: string; last_at: number; chosen_at: number | null; display_name: string };
export type Decision = { kind: 'route'; workspaceId: string } | { kind: 'ambiguous'; candidates: Candidate[] } | { kind: 'none' };

/** Active members that wrote to this customer from this number, newest first. */
async function candidatesFor(env: Db, phoneNumberId: string, key: string): Promise<Candidate[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.workspace_id, r.last_at, r.chosen_at, m.display_name FROM shared_routes r
       JOIN shared_number_members m ON m.workspace_id = r.workspace_id AND m.phone_number_id = r.phone_number_id AND m.status = 'active'
      WHERE r.phone_number_id = ? AND r.customer_key = ? ORDER BY r.last_at DESC, r.workspace_id`,
  ).bind(phoneNumberId, key).all<Candidate>();
  return results;
}

/**
 * Pure. A store's route counts for ROUTE_MEMORY_MS. The customer's choice (`chosen_at`) settles replies until ANOTHER store writes after
 * it; then, as whenever more than one store wrote within the memory, the customer chooses again. The newest writer never takes over a
 * customer another store is still dealing with: a route claimed by messaging someone only ever earns a place on the list.
 */
export function decide(cands: Candidate[], now: number): Decision {
  if (!cands.length) return { kind: 'none' };
  const since = now - ROUTE_MEMORY_MS;
  const at = (c: Candidate) => Math.max(c.last_at, c.chosen_at ?? 0);
  const recent = cands.filter((c) => at(c) > since);
  if (!recent.length) return { kind: 'route', workspaceId: cands[0]!.workspace_id }; // only stale contacts: the latest one
  const pin = recent.filter((c) => c.chosen_at !== null).sort((x, y) => y.chosen_at! - x.chosen_at!)[0];
  if (pin) {
    const challengers = recent.filter((c) => c.workspace_id !== pin.workspace_id && c.last_at > pin.chosen_at!);
    return challengers.length ? { kind: 'ambiguous', candidates: [pin, ...challengers] } : { kind: 'route', workspaceId: pin.workspace_id };
  }
  return recent.length > 1 ? { kind: 'ambiguous', candidates: recent } : { kind: 'route', workspaceId: recent[0]!.workspace_id };
}

// ---- R2 markers and parked messages -----------------------------------------------------------------------------------------------

/** Creates `key` only if absent (or older than `ttl`); true = this caller owns the marker. */
async function claimMarker(bucket: R2Bucket, key: string, ttl: number, now: number): Promise<boolean> {
  const put = () => bucket.put(key, '1', { onlyIf: { etagDoesNotMatch: '*' } });
  if (await put()) return true;
  const head = await bucket.head(key);
  if (head && head.uploaded.getTime() > now - ttl) return false;
  await bucket.delete(key);
  return (await put()) !== null;
}

const parkedMessage = z.object({
  wamid: z.string().min(1), from: z.string().min(1), ts: z.number(), type: z.string().min(1),
  text: z.string().optional(), caption: z.string().optional(), profileName: z.string().optional(),
  media: z.object({ id: z.string(), mime: z.string(), filename: z.string().optional() }).optional(),
  reply: z.object({ kind: z.enum(['button', 'list']), id: z.string(), title: z.string() }).optional(),
  order: z.unknown().optional(),
}).loose();

const parkedPrefix = (pn: string, key: string) => `shared-parked/${pn}/${key}/`;
const listMarkerKey = (pn: string, key: string) => `shared-list/${pn}/${key}`;
const noRouteKey = (pn: string, key: string) => `shared-noroute/${pn}/${key}`;

async function park(env: Env, pn: string, key: string, m: InboundMessage): Promise<void> {
  await env.MEDIA.put(`${parkedPrefix(pn, key)}${String(m.ts).padStart(12, '0')}-${encodeURIComponent(m.wamid)}`, JSON.stringify(m));
}

async function parkedFor(env: Env, pn: string, key: string): Promise<{ keys: string[]; messages: InboundMessage[] }> {
  const keys: string[] = [];
  const messages: InboundMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix: parkedPrefix(pn, key), ...(cursor ? { cursor } : {}) });
    for (const o of page.objects) {
      keys.push(o.key);
      const body = await env.MEDIA.get(o.key);
      const parsed = parkedMessage.safeParse(body ? await body.json().catch(() => null) : null);
      if (parsed.success) messages.push(parsed.data as unknown as InboundMessage);
      else console.warn(JSON.stringify({ warn: 'shared_parked_unreadable' }));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { keys, messages };
}

// ---- the webhook side -------------------------------------------------------------------------------------------------------------

export type SharedContext = { receivedAt: number; copy: SharedNumberCopy; config: WorkspaceConfig };

const clip = (s: string, n: number): string => (Array.from(s).length > n ? `${Array.from(s).slice(0, n - 1).join('')}…` : s);

/** One platform-sent message (list or reply). Retryable failures throw so Meta redelivers the webhook; permanent ones are logged and dropped. */
async function sendPlatform(env: Env, run: (o: { token: string; graphVersion: string; phoneNumberId: string; to: string }) => ReturnType<typeof sendText>, pn: string, to: string): Promise<boolean> {
  const r = await run({ token: env.META_SYSTEM_TOKEN, graphVersion: env.META_GRAPH_VERSION, phoneNumberId: pn, to });
  if (r.ok) return true;
  if (r.retryable) throw new Error('shared_platform_send_retryable');
  console.warn(JSON.stringify({ warn: 'shared_platform_send_failed', code: r.code }));
  return false;
}

/**
 * Handles every event Meta delivered for the platform number: statuses go to the store that sent each message, inbound messages are
 * routed (or parked, or answered generically). Returns the auto-reply jobs the stores' ingests asked for. Throws (so the webhook answers 5xx
 * and Meta redelivers) when a store's ingest or a platform send fails: every step is idempotent on the message id.
 */
export async function handleSharedEvent(env: Env, ev: WebhookEvents, ctx: SharedContext, now = Date.now()): Promise<SendJob[]> {
  const pn = ev.phoneNumberId;
  const replies: SendJob[] = [];
  const stubOf = (ws: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws));

  // statuses → the sender (by the message id it recorded; never by guessing)
  if (ev.statuses.length) {
    const byWs = new Map<string, StatusEvent[]>();
    for (let i = 0; i < ev.statuses.length; i += 50) {
      const chunk = ev.statuses.slice(i, i + 50);
      const { results } = await env.DB.prepare(`SELECT wamid, workspace_id FROM shared_sent WHERE wamid IN (${chunk.map(() => '?').join(',')})`).bind(...chunk.map((s) => s.wamid)).all<{ wamid: string; workspace_id: string }>();
      const owner = new Map(results.map((r) => [r.wamid, r.workspace_id]));
      for (const s of chunk) {
        const ws = owner.get(s.wamid);
        if (!ws) console.warn(JSON.stringify({ warn: 'shared_status_unknown_message' }));
        else byWs.set(ws, [...(byWs.get(ws) ?? []), s]);
      }
    }
    for (const [ws, statuses] of byWs) await stubOf(ws).ingest({ phoneNumberId: pn, inbound: [], statuses, receivedAt: ctx.receivedAt }, ctx.config);
  }

  // inbound
  const buckets = new Map<string, InboundMessage[]>();
  const put = (ws: string, ms: InboundMessage[]) => buckets.set(ws, [...(buckets.get(ws) ?? []), ...ms]);
  const afterIngest: (() => Promise<void>)[] = [];
  for (const m of ev.inbound) {
    const key = await customerKey(env, m.from);
    const cands = await candidatesFor(env, pn, key);
    const stop = detectOptOutMessage(m);

    // a tap on the "which store?" list
    if (m.reply?.kind === 'list' && m.reply.id.startsWith(PICK_PREFIX)) {
      const chosen = cands.find((c) => c.workspace_id === m.reply!.id.slice(PICK_PREFIX.length));
      if (chosen) {
        await env.DB.prepare('UPDATE shared_routes SET chosen_at = ? WHERE phone_number_id = ? AND customer_key = ? AND workspace_id = ?').bind(now, pn, key, chosen.workspace_id).run();
        const parked = await parkedFor(env, pn, key);
        put(chosen.workspace_id, parked.messages);
        afterIngest.push(async () => { await Promise.all([...parked.keys, listMarkerKey(pn, key)].map((k) => env.MEDIA.delete(k))); });
        continue; // the tap itself is the platform's, not a store's message
      }
      // a store the customer never heard from (or that left): not a choice; fall through as an ordinary message
    }

    const d = decide(cands, now);
    if (d.kind === 'route') {
      put(d.workspaceId, [m]);
    } else if (d.kind === 'ambiguous') {
      if (stop) for (const c of cands) put(c.workspace_id, [m]); // safe direction: every store that wrote to them
      else {
        await park(env, pn, key, m);
        if (await claimMarker(env.MEDIA, listMarkerKey(pn, key), MARKER_TTL_MS, now)) {
          try {
            const rows = d.candidates.slice(0, MAX_ROWS).map((c) => ({ id: `${PICK_PREFIX}${c.workspace_id}`, title: clip(c.display_name, ROW_TITLE_MAX) }));
            await sendPlatform(env, (o) => sendList({ ...o, body: ctx.copy.pickBody, button: ctx.copy.pickButton, footer: ctx.copy.pickFooter, rows }), pn, m.from);
          } catch (err) {
            await env.MEDIA.delete(listMarkerKey(pn, key)); // so the redelivery sends it
            throw err;
          }
        }
      }
    } else if (!stop) {
      if (await claimMarker(env.MEDIA, noRouteKey(pn, key), MARKER_TTL_MS, now)) {
        try {
          await sendPlatform(env, (o) => sendText({ ...o, text: ctx.copy.noRoute }), pn, m.from);
        } catch (err) {
          await env.MEDIA.delete(noRouteKey(pn, key));
          throw err;
        }
      }
    }
  }
  for (const [ws, ms] of buckets) {
    if (!ms.length) continue;
    const res = await stubOf(ws).ingest({ phoneNumberId: pn, inbound: [...ms].sort((a, b) => a.ts - b.ts), statuses: [], receivedAt: ctx.receivedAt }, ctx.config);
    replies.push(...res.replies);
  }
  for (const f of afterIngest) await f();
  return replies;
}

// ---- daily housekeeping ---------------------------------------------------------------------------------------------------------------

/** Drops parked messages and markers past their time, and the sent-message map past retention. Called from the daily pass. */
export async function sweepShared(env: Env, now = Date.now()): Promise<{ r2: number; sent: number }> {
  let r2 = 0;
  for (const [prefix, ttl] of [['shared-parked/', PARKED_TTL_MS], ['shared-list/', MARKER_TTL_MS], ['shared-noroute/', MARKER_TTL_MS]] as const) {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await env.MEDIA.list({ prefix, ...(cursor ? { cursor } : {}) });
      const old = page.objects.filter((o) => o.uploaded.getTime() < now - ttl).map((o) => o.key);
      if (old.length) await env.MEDIA.delete(old);
      r2 += old.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && ++pages < 20);
  }
  const res = await env.DB.prepare('DELETE FROM shared_sent WHERE at < ?').bind(now - SENT_RETENTION_MS).run();
  return { r2, sent: res.meta.changes ?? 0 };
}
