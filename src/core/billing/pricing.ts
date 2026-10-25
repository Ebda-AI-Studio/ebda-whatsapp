/**
 * Price inputs, as the workspace sees them. The control plane (D1) holds immutable effective-dated versions; the workspace keeps a
 * copy it can read WITHOUT awaiting anything, because a balance write must be one synchronous transaction with the rate data already
 * in hand. The copy is refreshed lazily (`refreshPricing`, at most every PRICING_MAX_AGE_MS while the workspace is active), so:
 *  - rate cards and FX versions are published at least 24 h ahead, settings and per-workspace overrides at least 1 h ahead;
 *  - both are far longer than the refresh age, so a version is always in the copy before it takes effect (staleness class
 *    BOUNDED, residual window = 0 for dated changes);
 *  - a charge is priced by the version in effect at DELIVERY time, never by the version in effect when the copy was pulled.
 */
import type { Env } from '../../env';
import { DEFAULT_COUNTRY, priceMinor, vatOf } from './money';

type Sql = DurableObjectStorage['sql'];

export const PRICING_MAX_AGE_MS = 30 * 60_000;
export const RATE_LEAD_MS = 24 * 3_600_000;
export const SETTINGS_LEAD_MS = 3_600_000;
export const DEFAULT_SETTINGS = { ver: 0, marginBps: 0, creditLimitMinor: 5000, fxBufferBps: 0, vatBps: 0 } as const;

export type Funding = 'merchant_card' | 'platform_line';
export type Settings = { ver: number; marginBps: number; creditLimitMinor: number; fxBufferBps: number; vatBps: number; override: number | null };
export type Priced = { netMinor: number; vatMinor: number; amountMinor: number; usdMicros: number; rateVer: number; fxVer: number; pricingVer: number; note: string | null };

/** Meta's category names, folded to the keys a rate card uses. */
export function normaliseCategory(c: string | null | undefined): string {
  const v = (c ?? '').trim().toLowerCase();
  if (v === 'authentication_international') return v;
  if (v.startsWith('marketing')) return 'marketing';
  if (v === 'utility' || v === 'authentication' || v === 'service') return v;
  return v || 'service';
}

export type FundingState = Funding | 'unknown';

/** Who pays Meta for this number. A number with no row is 'unknown' and cannot send: a miss must never read as "free". */
export function fundingOf(sql: Sql, phoneNumberId: string | null | undefined): FundingState {
  if (!phoneNumberId) return 'unknown';
  const r = sql.exec<{ funding: Funding }>('SELECT funding FROM number_funding WHERE phone_number_id = ?', phoneNumberId).toArray()[0];
  return r?.funding ?? 'unknown';
}

/** True once a pull of the price inputs has succeeded at least once: before that the copy is empty and no wallet decision may be taken on it. */
export function pricingReady(sql: Sql): boolean {
  return sql.exec("SELECT 1 FROM store_state WHERE key = 'pricing.pulled_at'").toArray().length > 0;
}

export function settingsAt(sql: Sql, t: number): Settings {
  const s = sql.exec<{ ver: number; margin_bps: number; credit_limit_minor: number; fx_buffer_bps: number; vat_bps: number }>(
    'SELECT ver, margin_bps, credit_limit_minor, fx_buffer_bps, vat_bps FROM pricing_settings WHERE effective_from <= ? ORDER BY effective_from DESC, ver DESC LIMIT 1', t,
  ).toArray()[0];
  const base = s
    ? { ver: s.ver, marginBps: s.margin_bps, creditLimitMinor: s.credit_limit_minor, fxBufferBps: s.fx_buffer_bps, vatBps: s.vat_bps }
    : { ...DEFAULT_SETTINGS };
  const o = sql.exec<{ ver: number; margin_bps: number }>('SELECT ver, margin_bps FROM pricing_overrides WHERE effective_from <= ? ORDER BY effective_from DESC, ver DESC LIMIT 1', t).toArray()[0];
  return { ...base, ...(o ? { marginBps: o.margin_bps } : {}), override: o?.ver ?? null };
}

type RateRow = { ver: number; usd_micros: number };
/** The rate in effect at `t` for a market and category; falls back to the rest-of-world row of the same card. */
export function rateAt(sql: Sql, country: string, category: string, t: number, later = false): RateRow | null {
  const q = 'SELECT ver, usd_micros FROM pricing_rates WHERE country = ? AND category = ? AND effective_from <= ? ORDER BY effective_from DESC, ver DESC LIMIT 1';
  // `later`: nothing was in effect at t (a delivery that predates the first published version): the EARLIEST version after t.
  const after = 'SELECT ver, usd_micros FROM pricing_rates WHERE country = ? AND category = ? AND effective_from > ? ORDER BY effective_from ASC, ver ASC LIMIT 1';
  const fallbacks = category === 'authentication_international' ? ['authentication_international', 'authentication'] : [category];
  for (const c of fallbacks) {
    const hit = sql.exec<RateRow>(q, country, c, t).toArray()[0] ?? (country === 'ROW' ? undefined : sql.exec<RateRow>(q, 'ROW', c, t).toArray()[0]);
    if (hit) return hit;
  }
  if (later) {
    for (const c of fallbacks) {
      const hit = sql.exec<RateRow>(after, country, c, t).toArray()[0] ?? (country === 'ROW' ? undefined : sql.exec<RateRow>(after, 'ROW', c, t).toArray()[0]);
      if (hit) return hit;
    }
  }
  return null;
}

export function fxAt(sql: Sql, t: number, later = false): { ver: number; micros: number; bufferBps: number } | null {
  const r = sql.exec<{ ver: number; egp_per_usd_micros: number; buffer_bps: number }>('SELECT ver, egp_per_usd_micros, buffer_bps FROM pricing_fx WHERE effective_from <= ? ORDER BY effective_from DESC, ver DESC LIMIT 1', t).toArray()[0]
    ?? (later ? sql.exec<{ ver: number; egp_per_usd_micros: number; buffer_bps: number }>('SELECT ver, egp_per_usd_micros, buffer_bps FROM pricing_fx WHERE effective_from > ? ORDER BY effective_from ASC, ver ASC LIMIT 1', t).toArray()[0] : undefined);
  return r ? { ver: r.ver, micros: r.egp_per_usd_micros, bufferBps: r.buffer_bps } : null;
}

/** Price of one message at time `t`, or null when the rate card or FX has nothing in effect (the caller alerts; it never guesses). */
export function priceAt(sql: Sql, a: { country: string; category: string; t: number; later?: boolean }): Priced | null {
  const category = normaliseCategory(a.category);
  const rate = rateAt(sql, a.country, category, a.t, a.later);
  const fx = fxAt(sql, a.t, a.later);
  if (!rate || !fx) return null;
  const st = settingsAt(sql, a.t);
  const net = priceMinor({ usdMicros: rate.usd_micros, fxMicros: fx.micros, marginBps: st.marginBps, fxBufferBps: st.fxBufferBps + fx.bufferBps });
  const vat = vatOf(net, st.vatBps);
  return { netMinor: net, vatMinor: vat, amountMinor: net + vat, usdMicros: rate.usd_micros, rateVer: rate.ver, fxVer: fx.ver, pricingVer: st.ver, note: st.override !== null ? `override:${st.override}` : null };
}

export const estimateCountry = (country: string | null | undefined): string => country || DEFAULT_COUNTRY;

// ---- the copy -------------------------------------------------------------------------------------------------------

export type PricingSnapshot = {
  rates: { id: number; ver: number; effective_from: number; country: string; category: string; usd_micros: number }[];
  fx: { id: number; ver: number; effective_from: number; egp_per_usd_micros: number; buffer_bps: number }[];
  settings: { id: number; ver: number; effective_from: number; margin_bps: number; credit_limit_minor: number; fx_buffer_bps: number; vat_bps: number }[];
  overrides: { id: number; ver: number; effective_from: number; margin_bps: number }[];
  funding: { phone_number_id: string; funding: Funding | null }[];
};

export const copyCursor = (sql: Sql) => ({
  rates: sql.exec<{ m: number | null }>('SELECT max(src_id) AS m FROM pricing_rates').one().m ?? 0,
  fx: sql.exec<{ m: number | null }>('SELECT max(src_id) AS m FROM pricing_fx').one().m ?? 0,
  settings: sql.exec<{ m: number | null }>('SELECT max(src_id) AS m FROM pricing_settings').one().m ?? 0,
  overrides: sql.exec<{ m: number | null }>('SELECT max(src_id) AS m FROM pricing_overrides').one().m ?? 0,
});

/** Reads what is new in D1 since the copy's cursors, plus this workspace's number funding. */
export async function pullPricing(env: Env, workspaceId: string, cur: ReturnType<typeof copyCursor>): Promise<PricingSnapshot> {
  const [rates, fx, settings, overrides, funding] = await env.DB.batch([
    env.DB.prepare('SELECT id, ver, effective_from, country, category, usd_micros FROM rate_cards WHERE id > ? ORDER BY id').bind(cur.rates),
    env.DB.prepare('SELECT id, ver, effective_from, egp_per_usd_micros, buffer_bps FROM fx_rates WHERE id > ? ORDER BY id').bind(cur.fx),
    env.DB.prepare('SELECT id, ver, effective_from, margin_bps, credit_limit_minor, fx_buffer_bps, vat_bps FROM pricing_settings WHERE id > ? ORDER BY id').bind(cur.settings),
    env.DB.prepare('SELECT id, ver, effective_from, margin_bps FROM workspace_pricing_overrides WHERE workspace_id = ? AND id > ? ORDER BY id').bind(workspaceId, cur.overrides),
    // Own numbers plus the shared platform number while the workspace is an active member; a number without a funding row stays unknown.
    env.DB.prepare("SELECT x.phone_number_id AS phone_number_id, nf.funding AS funding FROM (SELECT phone_number_id FROM phone_numbers WHERE workspace_id = ?1 UNION SELECT phone_number_id FROM shared_number_members WHERE workspace_id = ?1 AND status = 'active') x LEFT JOIN number_funding nf ON nf.phone_number_id = x.phone_number_id").bind(workspaceId),
  ]);
  return {
    rates: rates!.results as PricingSnapshot['rates'], fx: fx!.results as PricingSnapshot['fx'], settings: settings!.results as PricingSnapshot['settings'],
    overrides: overrides!.results as PricingSnapshot['overrides'], funding: funding!.results as PricingSnapshot['funding'],
  };
}

/** Copies a snapshot in (synchronous; call inside a transaction). Versions are immutable, so a repeat is ignored. */
export function applyPricing(sql: Sql, s: PricingSnapshot): void {
  for (const r of s.rates) sql.exec('INSERT OR IGNORE INTO pricing_rates (src_id, ver, effective_from, country, category, usd_micros) VALUES (?, ?, ?, ?, ?, ?)', r.id, r.ver, r.effective_from, r.country, r.category, r.usd_micros);
  for (const r of s.fx) sql.exec('INSERT OR IGNORE INTO pricing_fx (src_id, ver, effective_from, egp_per_usd_micros, buffer_bps) VALUES (?, ?, ?, ?, ?)', r.id, r.ver, r.effective_from, r.egp_per_usd_micros, r.buffer_bps);
  for (const r of s.settings) sql.exec('INSERT OR IGNORE INTO pricing_settings (src_id, ver, effective_from, margin_bps, credit_limit_minor, fx_buffer_bps, vat_bps) VALUES (?, ?, ?, ?, ?, ?, ?)', r.id, r.ver, r.effective_from, r.margin_bps, r.credit_limit_minor, r.fx_buffer_bps, r.vat_bps);
  for (const r of s.overrides) sql.exec('INSERT OR IGNORE INTO pricing_overrides (src_id, ver, effective_from, margin_bps) VALUES (?, ?, ?, ?)', r.id, r.ver, r.effective_from, r.margin_bps);
  sql.exec('DELETE FROM number_funding');
  for (const f of s.funding) if (f.funding) sql.exec('INSERT INTO number_funding (phone_number_id, funding) VALUES (?, ?)', f.phone_number_id, f.funding); // a number without a row stays unknown
  sql.exec("INSERT INTO store_state (key, value) VALUES ('pricing.pulled_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(Date.now()));
}
