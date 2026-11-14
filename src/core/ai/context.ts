/**
 * What the agent knows besides the conversation (Ruling CHAT-AGENT-1/2): the merchant's declared store facts, the small FAQ inline, and the person
 * it is talking to. Everything here is data from the Store (never from the customer or the model) and is rendered as plain text for the prompt; the
 * same text is added to what the reply guard trusts, so a quoted fee or window passes only if it is in these lines, and a fee that is not
 * declared cannot be quoted at all (the guard refuses an amount nobody vouched for).
 *
 * Staleness (cache-invalidate rule): store facts are read on EVERY turn (shipping, COD and returns are money-adjacent: no cache, one RPC). The customer
 * profile is cached per conversation for PROFILE_TTL_MS in memory (BOUNDED-stale: first name, locale and the saved address change only when the customer or staff
 * edit them; residual window 15 min), and the cache is dropped on every write path that changes it (`dropProfile`: address saved, order placed, contact erased). Order
 * STATUS is never taken from the profile: it comes from the `order_status` tool.
 */
import { alert, errClass } from '../observability';
import { isE164 } from '../phone';
import type { CustomerProfile, StoreBridge, StorePolicies } from '../store-bridge';
import type { LinkHost } from '../store-link/host';
import { maskForModel } from './mask';
import { getAgentState, putAgentState, type AgentSettings } from './settings';

/** A FAQ up to this size goes straight into the prompt (about 750 tokens of Arabic); a larger one stays in the vector index. */
export const FAQ_INLINE_MAX_CHARS = 3072;
export const PROFILE_TTL_MS = 15 * 60_000;

export const faqInline = (s: Pick<AgentSettings, 'faqText'>): string | null => {
  const t = s.faqText.trim();
  return t && t.length <= FAQ_INLINE_MAX_CHARS ? t : null;
};

const money = (minor: number, cur: string): string => `${Number.isInteger(minor / 100) ? minor / 100 : (minor / 100).toFixed(2)} ${cur}`;
const both = (en: string, ar: string | null): string => (ar && ar !== en ? `${en} (${ar})` : en);
const METHOD: Record<string, string> = { cod: 'cash on delivery', link: 'online payment link', instapay: 'InstaPay' };

/** The merchant's declared facts as prompt lines. A field the merchant never filled in says so, so the model says it will check instead of guessing. */
export function renderPolicies(p: StorePolicies): string {
  const L: string[] = [];
  L.push(`Store name: ${both(p.name, p.nameAr)}`);
  L.push(`Currency: ${p.currency}`);
  L.push(`Payment methods: ${p.paymentMethods.length ? p.paymentMethods.map((m) => METHOD[m] ?? m).join(', ') : 'not declared'}`);
  if (p.cod.available) {
    const fee = [p.cod.fixedFeeMinor ? money(p.cod.fixedFeeMinor, p.currency) : '', p.cod.percentBps ? `${p.cod.percentBps / 100}%` : ''].filter(Boolean).join(' + ');
    L.push(`Cash on delivery: available${fee ? `, fee ${fee}` : ', no fee declared'}`);
  } else L.push('Cash on delivery: not available');
  const zones = p.shipping.zones;
  const govs = p.shipping.governorates;
  if (!zones.length && !govs.length) L.push('Shipping fees: NOT DECLARED. Never state or estimate a shipping fee or delivery time; say you will check.');
  else {
    for (const z of zones) {
      const eta = z.etaDaysMin !== null || z.etaDaysMax !== null ? `, delivery ${[z.etaDaysMin, z.etaDaysMax].filter((x) => x !== null).filter((x, i, a) => a.indexOf(x) === i).join('-')} days` : '';
      L.push(`Shipping zone ${both(z.name, z.nameAr)}${z.areas.length ? ` [${z.areas.slice(0, 12).join(', ')}]` : ''}: ${money(z.feeMinor, p.currency)}${z.freeOverMinor !== null ? `, free over ${money(z.freeOverMinor, p.currency)}` : ''}${eta}`);
    }
    for (const g of govs) L.push(`Shipping to ${both(g.governorate, g.governorateAr)}: ${g.feeMaxMinor > g.feeMinor ? `${money(g.feeMinor, p.currency)} to ${money(g.feeMaxMinor, p.currency)} depending on the area` : money(g.feeMinor, p.currency)}${g.freeOverMinor !== null ? `, free over ${money(g.freeOverMinor, p.currency)}` : ''}`);
    L.push('Any other area or governorate: NOT DECLARED, say you will check.');
  }
  if (p.returns.windowDays === null) L.push('Returns: NOT DECLARED. Never state a return window; say you will check.');
  else if (p.returns.windowDays === 0) L.push('Returns: the store does not accept returns');
  else L.push(`Returns: ${p.returns.windowDays} days${p.returns.feesPaidBy ? `, return shipping paid by the ${p.returns.feesPaidBy}` : ''}`);
  L.push(`Opening hours: ${p.hours ?? 'NOT DECLARED'}`);
  if (p.location) L.push(`Location: ${[p.location.address, p.location.addressAr, p.location.mapsUrl].filter(Boolean).join(' | ')}`);
  return L.join('\n');
}

/** Facts could not be loaded this turn: the model must not fill the gap from memory. */
export const POLICIES_UNAVAILABLE = 'The store facts (shipping, returns, hours, payment details) could not be loaded this turn. Do not state any shipping fee, delivery time, return window or opening hours; say you will check.';

/** The same alert at most once per UTC day per workspace (a Store that is down would otherwise page on every turn); the marker is a day string, no customer data. */
function alertOncePerDay(host: LinkHost, key: string, name: string, data: Record<string, unknown>): void {
  const day = new Date().toISOString().slice(0, 10);
  if (getAgentState(host.sql, key) === day) return;
  putAgentState(host.sql, key, day);
  alert(name, { workspace: host.workspaceId, ...data });
}

export async function loadPolicies(host: LinkHost, bridge: StoreBridge | null): Promise<StorePolicies | null> {
  if (!bridge) return null;
  const r = await bridge.getStorePolicies(host.workspaceId);
  if (!r.ok) {
    alertOncePerDay(host, 'policies_alert', 'agent_policies_unavailable', { reason: r.reason });
    return null;
  }
  return r.value;
}

// ---- the customer ---------------------------------------------------------------------------------------------------

type Cached = { at: number; profile: CustomerProfile | null };
/**
 * In MEMORY only, never in `agent_state` (that table is backed up and not swept per contact): a first name and an address must not sit at rest
 * outside the Store. Lost when the Durable Object is evicted (the next turn asks again); bounded; dropped on erasure (`eraseContact`).
 */
const PROFILE_CACHE_MAX = 200;
const profiles = new Map<string, Cached>();
const cacheKey = (ws: string, waId: string) => `${ws}:${waId}`;
/** Drop the cached profile of one customer: call on every write that changes what it holds (address saved, order placed) and on erasure. */
export function dropProfile(host: Pick<LinkHost, 'workspaceId'>, waId: string): void {
  profiles.delete(cacheKey(host.workspaceId, waId));
}

/** Is a profile for this customer held in memory? (erasure and invalidation tests) */
export const profileCached = (host: Pick<LinkHost, 'workspaceId'>, waId: string): boolean => profiles.has(cacheKey(host.workspaceId, waId));

/** The customer's profile for this conversation: cached for PROFILE_TTL_MS; a failure answers null (the agent then simply knows nothing about them). */
export async function loadProfile(host: LinkHost, bridge: StoreBridge | null, waId: string, now: number): Promise<CustomerProfile | null> {
  const phone = `+${waId}`;
  if (!bridge || !isE164(phone)) return null;
  const key = cacheKey(host.workspaceId, waId);
  const hit = profiles.get(key);
  if (hit && now >= hit.at && now - hit.at < PROFILE_TTL_MS) return hit.profile;
  try {
    const r = await bridge.getCustomerProfile(host.workspaceId, phone);
    if (!r.ok) {
      if (r.reason !== 'not_found') alertOncePerDay(host, 'profile_alert', 'agent_profile_unavailable', { reason: r.reason });
      return null; // not cached: the next turn asks again
    }
    if (profiles.size >= PROFILE_CACHE_MAX) profiles.delete(profiles.keys().next().value as string);
    profiles.set(key, { at: now, profile: r.value });
    return r.value;
  } catch (err) {
    alertOncePerDay(host, 'profile_alert', 'agent_profile_unavailable', { error: errClass(err) });
    return null;
  }
}

/**
 * Text the SHOPPER typed (name, address fields, notes) is untrusted data, however it reached the Store: a link, an amount or an instruction planted there must neither
 * steer the model nor be vouched for in the reply guard (review I1). Links, e-mail-like tokens and amounts next to a currency are removed, angle brackets and control
 * characters dropped, whitespace collapsed, length capped. A first name is letters only (no digits at all).
 */
const URLISH = /\S*(?:https?:|www\.|ftp:|[\p{L}\p{N}-]\.[a-z]{2,}\b|@)\S*/giu;
const AMOUNT = /(?:\d[\d.,]*\s*(?:egp|e\.?g\.?p|l\.?e\b|usd|kwd|sar|aed|جنيه|جنية|جنيهات|ج\.?م|جم|ريال|دينار|درهم|دولار|\$)|(?:egp|usd|\$|ج\.?م)\s*\d[\d.,]*)/giu;
export function safeTyped(raw: string | null | undefined, max: number): string {
  const t = (raw ?? '').replace(/[\u0000-\u001f\u007f<>\u202a-\u202e\u2066-\u2069]/g, ' ').replace(URLISH, ' ').replace(AMOUNT, ' ').replace(/\s+/g, ' ').trim();
  return maskForModel(Array.from(t).slice(0, max).join('')).trim();
}
const safeName = (raw: string | null | undefined): string => safeTyped(safeTyped(raw, 80).replace(/[^\p{L}\p{M}'\u2019 -]/gu, ' '), 30);

/** The fence core wraps around shopper-typed profile fields; the boundary text in `agent.ts` names it. */
export const PROFILE_OPEN = '<customer_profile>';
export const PROFILE_CLOSE = '</customer_profile>';

/**
 * What the model may know about the person: first name, language, saved address, recent orders (names and amounts, never a phone). The fields the shopper typed
 * (name, address) sit inside a `<customer_profile>` fence as untrusted data; they are NEVER added to what the reply guard trusts (only order totals are, see
 * `profilePrices`). Masked like any text going to a model.
 */
export function renderCustomer(c: CustomerProfile, conversationStart: boolean): string {
  const L: string[] = [`Conversation start: ${conversationStart ? 'yes (greet them by first name once, if known)' : 'no (do not greet again)'}`];
  if (c.preferredLocale) L.push(`Preferred language: ${c.preferredLocale === 'ar' ? 'Arabic' : 'English'}`);
  const typed: string[] = [];
  const name = safeName(c.firstName);
  if (name) typed.push(`First name: ${name}`);
  const a = c.defaultAddress;
  if (a) {
    const addr = [safeTyped(a.label, 30), safeTyped(a.street, 100), safeTyped(a.area, 60), safeTyped(a.governorate, 40), a.buildingNumber ? `building ${safeTyped(a.buildingNumber, 12)}` : null, safeTyped(a.notes, 80)].filter(Boolean).join(', ');
    if (addr) typed.push(`Saved address: ${addr}`);
  }
  if (typed.length) L.push(`${PROFILE_OPEN}\n${typed.join('\n')}\n${PROFILE_CLOSE}`);
  for (const o of c.recentOrders.slice(0, 3)) {
    L.push(`Past order ${safeTyped(o.orderNumber, 24)}: ${o.items.slice(0, 5).map((i) => `${safeTyped(i.name, 60)} x${i.quantity}`).join(', ') || 'items not listed'}; ${o.status}; ${money(o.totalMinor, o.currency)}`);
  }
  return L.join('\n');
}

/** The only part of the profile the reply guard may vouch for: the amounts of the Store's own past orders (structured, not typed by the shopper). */
export const profilePrices = (c: CustomerProfile | null): number[] => (c ? c.recentOrders.slice(0, 3).map((o) => o.totalMinor / 100) : []);

/** Store knowledge empty while a FAQ too big to inline is waiting for its index: the merchant is told (once a day) through an alert and the Agent screen warns. */
export function faqIndexAlert(host: LinkHost, s: AgentSettings, knowledgeReady: boolean, now: number): void {
  if (faqInline(s) !== null || !s.faqText.trim() || knowledgeReady) return;
  const day = new Date(now).toISOString().slice(0, 10);
  if (getAgentState(host.sql, 'faq_index_alert') === day) return;
  putAgentState(host.sql, 'faq_index_alert', day);
  alert('agent_faq_not_indexed', { workspace: host.workspaceId });
}
