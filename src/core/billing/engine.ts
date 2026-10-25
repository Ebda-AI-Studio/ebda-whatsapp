/**
 * The wallet, inside one workspace Durable Object (Phase 7.2 / 7.3). Invariants (each has a test):
 *  1. The ledger is append-only: UPDATE and DELETE are refused by triggers. Every row has a unique `ref`, so a retried write is a no-op.
 *  2. Every balance write reads `balance_after` and writes the new row in ONE synchronous transaction with no await between (rate data is
 *     passed in, never fetched): two concurrent writers cannot both read the same balance.
 *  3. available = balance - held. A hold is checked and written in the same synchronous step, so concurrent sends cannot overdraw.
 *  4. One charge per Meta message id: the ref `meta:<wamid>` is unique, so duplicate and out-of-order webhooks charge once.
 *  5. Every terminal message state settles its hold (released, charged or expired); holds and billable_sends are never deleted.
 *  6. Only `platform_line` numbers are ever debited. A `merchant_card` number records Meta's cost for display and never touches the balance.
 *  7. No phone number, name or message text enters a money table (the `to` number is reduced to a market code before it is stored).
 */
import type { SendJob } from '../send-queue';
import type { StatusPricing } from '../meta/webhook-schema';
import { addTask } from '../scheduler';
import { countryOf } from './country';
import { ensureTrueupTask } from './trueup';
import { DEFAULT_SETTINGS, fundingOf, normaliseCategory, priceAt, pricingReady, settingsAt, type Funding } from './pricing';

type Sql = DurableObjectStorage['sql'];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Utility and service sends that cannot be paid wait at most this long (WA-OVERDRAFT-1). */
export const WAIT_MAX_MS = 48 * HOUR;
/** A message with no status this long after the send is presumed lost: Meta's retry horizon (30 d) plus a day. */
export const HOLD_TTL_MS = 31 * DAY;
export const AUTH_HOLD_TTL_MS = 2 * DAY;
/** A billable delivery that still has no rate this long after delivery is charged at its held estimate (and alerted): never free. */
export const PENDING_RATE_MAX_MS = 7 * DAY;
export const PARENT_HOLD_TTL_MS = 60 * DAY;
export const LOW_BALANCE_MINOR = 2000;
const DRAIN_DELAY_MS = 1000;

export type WalletKind = 'topup' | 'meta_charge' | 'meta_adjust' | 'ai_charge' | 'refund' | 'chargeback' | 'adjustment' | 'grant' | 'expire';
export type PostArgs = {
  kind: WalletKind; netMinor: number; vatMinor?: number; ref: string; now: number;
  wamid?: string; category?: string; usdMicros?: number; rateVer?: number; fxVer?: number; pricingVer?: number; actor?: string; note?: string;
};
export type WalletPosted = { ok: true; balance: number; amountMinor: number } | { ok: false; reason: 'duplicate' | 'invalid' };

export type ClaimBill =
  | { kind: 'ok' }
  | { kind: 'empty'; reason: 'wallet_empty' | 'wallet_empty_expired' | 'funding_unknown' | 'rate_unavailable' }
  | { kind: 'wait'; waitUntil: number }
  /** The price inputs were never pulled: nothing may be decided on an empty copy. Try again soon. */
  | { kind: 'defer' };

export type BillingStatus = { wamid: string; status: 'sent' | 'delivered' | 'read' | 'failed'; ts: number; pricing?: StatusPricing };

type HoldRow = { ref: string; parent_ref: string | null; amount_minor: number; category_est: string | null; state: 'held' | 'charged' | 'released' | 'expired'; wait_until: number | null; expires_at: number; number_id: string | null; country: string | null; funding: Funding | null };
type SendRow = {
  wamid: string; hold_ref: string | null; number_id: string | null; country: string | null; category_est: string | null; category_meta: string | null; pricing_model: string | null;
  billable: number | null; funding: Funding; delivered_at: number | null; charged_ref: string | null; charged_category: string | null; charged_minor: number | null; unpriced: number; pending_rate: number;
};

const alert = (what: string, extra: Record<string, unknown> = {}) => console.error(JSON.stringify({ alert: what, ...extra }));

export class Billing {
  /** `touch` tells the Durable Object a scheduler row was added, so it re-arms its alarm after the transaction. */
  constructor(private readonly sql: Sql, private readonly workspaceIdOf: () => string, private readonly touch: () => void) {}

  private get workspaceId(): string {
    return this.workspaceIdOf();
  }

  // ---- balance ------------------------------------------------------------------------------------------------------

  balance(): number {
    return this.sql.exec<{ b: number }>('SELECT coalesce((SELECT balance_after FROM wallet_ledger ORDER BY id DESC LIMIT 1), 0) AS b').one().b;
  }

  /**
   * What the open holds reserve. A campaign page holds ONE parent reservation that its per-message holds draw from, so a page is never
   * reserved twice: the parent counts its amount less what its messages already charged (the ledger carries that now), or the sum
   * of its live message holds if that is larger. A message hold whose parent is gone reserves for itself.
   */
  held(): number {
    return this.sql.exec<{ h: number }>(
      `SELECT coalesce(sum(x), 0) AS h FROM (
         SELECT max(
                  p.amount_minor - coalesce((SELECT sum(c.amount_minor) FROM wallet_holds c WHERE c.parent_ref = p.ref AND c.state = 'charged'), 0),
                  coalesce((SELECT sum(c.amount_minor) FROM wallet_holds c WHERE c.parent_ref = p.ref AND c.state = 'held'), 0)
                ) AS x
           FROM wallet_holds p WHERE p.parent_ref IS NULL AND p.state = 'held'
         UNION ALL
         SELECT c.amount_minor AS x FROM wallet_holds c
          WHERE c.parent_ref IS NOT NULL AND c.state = 'held' AND NOT EXISTS (SELECT 1 FROM wallet_holds p WHERE p.ref = c.parent_ref AND p.state = 'held')
       )`,
    ).one().h;
  }

  available(): number {
    return this.balance() - this.held();
  }

  creditLimit(now: number): number {
    return settingsAt(this.sql, now).creditLimitMinor;
  }

  /** Appends one ledger row and queues its copy for D1. Call inside a transaction; nothing here awaits. */
  post(a: PostArgs): WalletPosted {
    const vat = a.vatMinor ?? 0;
    const amount = a.netMinor + vat;
    if (!Number.isSafeInteger(a.netMinor) || !Number.isSafeInteger(vat) || amount === 0 || !a.ref) return { ok: false, reason: 'invalid' };
    if (this.sql.exec('SELECT 1 FROM wallet_ledger WHERE ref = ?', a.ref).toArray().length) return { ok: false, reason: 'duplicate' };
    const balance = this.balance() + amount;
    this.sql.exec(
      `INSERT INTO wallet_ledger (at, kind, net_minor, vat_minor, amount_minor, balance_after, ref, wamid, category, usd_micros, rate_ver, fx_ver, pricing_ver, actor, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.now, a.kind, a.netMinor, vat, amount, balance, a.ref, a.wamid ?? null, a.category ?? null, a.usdMicros ?? null, a.rateVer ?? null, a.fxVer ?? null, a.pricingVer ?? null, a.actor ?? null, a.note ?? null,
    );
    this.sql.exec(
      "INSERT INTO ledger_outbox (ledger, ref, row_json) VALUES ('wallet', ?, ?)",
      a.ref, JSON.stringify({ at: a.now, kind: a.kind, amount, balance_after: balance }),
    );
    addTask(this.sql, 'ledger_drain', a.now + DRAIN_DELAY_MS);
    this.touch();
    this.lowBalanceAlert(a.now, balance);
    return { ok: true, balance, amountMinor: amount };
  }

  /** Once per day while the available balance is under the threshold: a log alert the alert bridge turns into a notice. */
  private lowBalanceAlert(now: number, balance: number): void {
    if (balance - this.held() >= LOW_BALANCE_MINOR) return;
    const last = Number(this.sql.exec<{ value: string }>("SELECT value FROM store_state WHERE key = 'wallet.low_alert_at'").toArray()[0]?.value ?? 0);
    if (now - last < DAY) return;
    this.sql.exec("INSERT INTO store_state (key, value) VALUES ('wallet.low_alert_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(now));
    alert('wallet_low_balance', { workspace: this.workspaceId });
  }

  // ---- estimates ----------------------------------------------------------------------------------------------------

  /** Category of a send in the rate card's terms: a template's own category, everything else is a service message. */
  jobCategory(job: Pick<SendJob, 'kind' | 'template'>): string {
    if ((job.kind ?? 'text') !== 'template' || !job.template) return 'service';
    const c = this.sql.exec<{ category: string }>('SELECT category FROM templates WHERE name = ? AND language = ?', job.template.name, job.template.language).toArray()[0]?.category;
    return normaliseCategory(c ?? 'UTILITY');
  }

  /** Estimated price of one message to `to` (any phone form; only the market is kept). 0 when the rate card has nothing: alerted, never guessed. */
  estimateMinor(to: string, category: string, now: number): { minor: number; priced: boolean; country: string } {
    const country = countryOf(to);
    const p = priceAt(this.sql, { country, category, t: now });
    if (!p) {
      alert('rate_unavailable', { workspace: this.workspaceId, country, category: normaliseCategory(category) });
      return { minor: 0, priced: false, country };
    }
    return { minor: p.amountMinor, priced: true, country };
  }

  // ---- holds --------------------------------------------------------------------------------------------------------

  private hold(ref: string): HoldRow | undefined {
    return this.sql.exec<HoldRow>('SELECT ref, parent_ref, amount_minor, category_est, state, wait_until, expires_at, number_id, country, funding FROM wallet_holds WHERE ref = ?', ref).toArray()[0];
  }

  /** How much of a campaign page's reservation its messages have not yet used. */
  parentRoom(parentRef: string): number {
    const p = this.hold(parentRef);
    if (!p || p.state !== 'held') return 0;
    const used = this.sql.exec<{ u: number }>("SELECT coalesce(sum(amount_minor), 0) AS u FROM wallet_holds WHERE parent_ref = ? AND state IN ('held', 'charged')", parentRef).one().u;
    return p.amount_minor - used;
  }

  /**
   * The pre-send decision for one message, taken at claim time inside the claim's transaction, and the hold it creates. Idempotent per
   * message key. Rules (WA-OVERDRAFT-1): marketing needs available >= estimate and no debt; utility and service may use the overdraft
   * down to -credit_limit, and wait (<= 48 h, <= the 24 h window) when even that is not enough; authentication that cannot be paid fails
   * at once (the Store falls back to email). A number paid by the merchant's card is never held against.
   */
  onClaim(job: SendJob, a: { now: number; createdAt: number; windowEndsAt: number | null; parentRef?: string | null; atQueue?: boolean }): ClaimBill {
    const ref = `msg:${job.idempotencyKey}`;
    const have = this.hold(ref);
    if (have && (have.state === 'held' || have.state === 'charged')) return { kind: 'ok' };
    if (!pricingReady(this.sql)) return { kind: 'defer' };
    const funding = fundingOf(this.sql, job.phoneNumberId);
    if (funding === 'unknown') {
      alert('funding_unknown', { workspace: this.workspaceId });
      return { kind: 'empty', reason: 'funding_unknown' };
    }
    const category = this.jobCategory(job);
    const country = countryOf(job.to);
    // The rate card matters only for a number the wallet pays for; a merchant-card number never looks a price up here.
    const est = funding === 'platform_line' ? this.estimateMinor(job.to, category, a.now) : { minor: 0, priced: true, country };
    // A platform-paid send with no price in effect is refused, never held at 0 (it would go out and be delivered for free).
    if (!est.priced) return { kind: 'empty', reason: 'rate_unavailable' };
    const ttl = category === 'authentication' ? AUTH_HOLD_TTL_MS : HOLD_TTL_MS;
    const write = (amount: number, parent: string | null) => {
      this.sql.exec(
        `INSERT INTO wallet_holds (ref, parent_ref, amount_minor, category_est, state, wait_until, expires_at, created_at, number_id, country, funding)
         VALUES (?, ?, ?, ?, 'held', NULL, ?, ?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET parent_ref = excluded.parent_ref, amount_minor = excluded.amount_minor, category_est = excluded.category_est, state = 'held', settled_at = NULL,
           release_reason = NULL, expires_at = excluded.expires_at, number_id = excluded.number_id, country = excluded.country, funding = excluded.funding`,
        ref, parent, amount, category, a.now + ttl, a.now, job.phoneNumberId, est.country, funding,
      );
      // Only a hold that reserves the wallet's money needs a sweep; a merchant-card hold (0) carries no money.
      if (funding === 'platform_line') {
        addTask(this.sql, 'wallet_sweep', a.now + ttl);
        this.touch();
      }
    };
    if (funding !== 'platform_line') {
      write(0, null);
      return { kind: 'ok' };
    }
    const parent = a.parentRef && this.parentRoom(a.parentRef) >= est.minor ? a.parentRef : null;
    if (parent) {
      write(est.minor, parent);
      return { kind: 'ok' };
    }
    const limit = this.creditLimit(a.now);
    const balance = this.balance();
    const avail = balance - this.held();
    if (category === 'marketing') {
      if (balance < 0 || avail < est.minor) return { kind: 'empty', reason: 'wallet_empty' };
    } else if (est.minor > 0 && avail - est.minor < -limit) {
      if (category === 'authentication') return { kind: 'empty', reason: 'wallet_empty' };
      // At queue time an unpayable utility or service send is still accepted: it waits at claim, where the wait is recorded.
      if (a.atQueue) return { kind: 'ok' };
      const waitUntil = this.waitDeadline(job.idempotencyKey, a.createdAt, a.windowEndsAt, a.now);
      return a.now >= waitUntil ? { kind: 'empty', reason: 'wallet_empty_expired' } : { kind: 'wait', waitUntil };
    }
    write(est.minor, null);
    this.sql.exec('DELETE FROM wallet_waits WHERE key = ?', job.idempotencyKey);
    return { kind: 'ok' };
  }

  /** wait_until = min(created + 48 h, window end); fixed at the FIRST wait so a later retry cannot extend it. */
  private waitDeadline(key: string, createdAt: number, windowEndsAt: number | null, now: number): number {
    const first = this.sql.exec<{ wait_until: number }>('SELECT wait_until FROM wallet_waits WHERE key = ?', key).toArray()[0];
    if (first) return first.wait_until;
    const until = Math.min(createdAt + WAIT_MAX_MS, windowEndsAt ?? Number.MAX_SAFE_INTEGER);
    this.sql.exec('INSERT OR IGNORE INTO wallet_waits (key, wait_until, created_at) VALUES (?, ?, ?)', key, until, now);
    return until;
  }

  /** A campaign page reserves the whole page's estimate once, under a deterministic ref (a retried workflow step finds its own). */
  reserveParent(ref: string, estimateMinor: number, now: number): { ok: true } | { ok: false; reason: 'wallet_empty' } {
    if (this.hold(ref)) return { ok: true };
    if (estimateMinor > 0) {
      const balance = this.balance();
      if (balance < 0 || balance - this.held() < estimateMinor) return { ok: false, reason: 'wallet_empty' };
    }
    this.sql.exec("INSERT INTO wallet_holds (ref, amount_minor, category_est, state, expires_at, created_at) VALUES (?, ?, 'campaign', 'held', ?, ?)", ref, estimateMinor, now + PARENT_HOLD_TTL_MS, now);
    addTask(this.sql, 'wallet_sweep', now + PARENT_HOLD_TTL_MS);
    this.touch();
    return { ok: true };
  }

  /** The only way a hold leaves 'held'. A message hold that settles may be the last thing keeping its campaign page's reservation open. */
  private close(ref: string, state: 'charged' | 'released' | 'expired', reason: string | null, now: number): void {
    const r = this.sql.exec<{ parent_ref: string | null }>(
      "UPDATE wallet_holds SET state = ?, settled_at = ?, release_reason = ? WHERE ref = ? AND state = 'held' RETURNING parent_ref", state, now, reason, ref,
    ).toArray()[0];
    if (r?.parent_ref) this.tryClosePage(r.parent_ref, now);
  }

  /**
   * A campaign is done adding messages to a page, or abandoned it. The page's reservation is released only once none of its messages is
   * still waiting to be sent (until then funds must stay reserved for them); the last message to settle closes it. Idempotent.
   */
  settleParent(ref: string, reason: string, now: number): void {
    this.sql.exec("UPDATE wallet_holds SET closing = 1, release_reason = coalesce(release_reason, ?) WHERE ref = ? AND state = 'held'", reason, ref);
    this.tryClosePage(ref, now);
  }

  private tryClosePage(ref: string, now: number): void {
    const h = this.sql.exec<{ closing: number; release_reason: string | null }>("SELECT closing, release_reason FROM wallet_holds WHERE ref = ? AND state = 'held'", ref).toArray()[0];
    if (!h || !h.closing) return;
    const m = /^camp:(.+):p(\d+)$/.exec(ref);
    const pending = m
      ? this.sql.exec<{ n: number }>(
        "SELECT count(*) AS n FROM campaign_recipients r JOIN messages x ON x.idempotency_key = r.idem WHERE r.campaign_id = ? AND r.page = ? AND x.status IN ('queued', 'claimed', 'retry')", m[1]!, Number(m[2]),
      ).one().n
      : 0;
    if (pending === 0) this.close(ref, 'released', h.release_reason ?? 'page_done', now);
    else addTask(this.sql, 'wallet_sweep', now + 6 * HOUR); // a message erased or dropped without a hold would otherwise leave it open
  }

  /**
   * Settles a message's hold when the message reached a terminal state without a charge (failed, dropped, erased, opted out, cancelled,
   * not billable). Idempotent; a charged hold is left alone. Also forgets a wait.
   */
  settleHold(key: string, outcome: 'failed' | 'dropped' | 'erased' | 'opted_out' | 'cancelled' | 'not_billable' | 'enqueue_failed' | 'rate_limited', now: number): void {
    this.close(`msg:${key}`, 'released', outcome, now);
    this.sql.exec('DELETE FROM wallet_waits WHERE key = ?', key);
  }

  /** A cancelled campaign: every message hold of its recipients that is still open is released. */
  settleCampaignMessages(campaignId: string, outcome: string, now: number): void {
    for (const r of this.sql.exec<{ idem: string }>("SELECT idem FROM campaign_recipients WHERE campaign_id = ?", campaignId).toArray()) this.close(`msg:${r.idem}`, 'released', outcome, now);
  }

  /** Expires holds nobody settled (no status within the horizon). Returns the next time a hold will expire, or null. */
  sweep(now: number): number | null {
    for (const h of this.sql.exec<{ ref: string }>("SELECT ref FROM wallet_holds WHERE state = 'held' AND expires_at <= ? ORDER BY parent_ref IS NULL, ref", now).toArray()) this.close(h.ref, 'expired', 'ttl', now);
    for (const h of this.sql.exec<{ ref: string }>("SELECT ref FROM wallet_holds WHERE state = 'held' AND closing = 1").toArray()) this.tryClosePage(h.ref, now);
    const stillPending = this.retryPendingRates(now);
    const next = this.sql.exec<{ n: number | null }>("SELECT min(expires_at) AS n FROM wallet_holds WHERE state = 'held'").one().n;
    const closing = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM wallet_holds WHERE state = 'held' AND closing = 1").one().n;
    const retry = stillPending ? now + HOUR : Number.MAX_SAFE_INTEGER;
    const both = Math.min(closing ? now + 6 * HOUR : Number.MAX_SAFE_INTEGER, retry, next ?? Number.MAX_SAFE_INTEGER);
    return both === Number.MAX_SAFE_INTEGER ? null : both;
  }

  // ---- after the send -----------------------------------------------------------------------------------------------

  /** Meta accepted the message: from now on the wamid is what money hangs on. Idempotent. */
  onAccepted(key: string, wamid: string, now: number): void {
    const h = this.hold(`msg:${key}`);
    if (!h) return;
    this.sql.exec(
      'INSERT OR IGNORE INTO billable_sends (wamid, hold_ref, number_id, country, category_est, funding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      wamid, h.ref, h.number_id, h.country, h.category_est, h.funding ?? 'merchant_card', now,
    );
  }

  private send(wamid: string): SendRow | undefined {
    return this.sql.exec<SendRow>(
      `SELECT wamid, hold_ref, number_id, country, category_est, category_meta, pricing_model, billable, funding, delivered_at, charged_ref, charged_category, charged_minor, unpriced, pending_rate
         FROM billable_sends WHERE wamid = ?`, wamid,
    ).toArray()[0];
  }

  /** Applies one Meta status (with its `pricing` object, if any) to the money side of that message. Safe in any order and any number of times. */
  onStatus(e: BillingStatus, now: number): void {
    const bs = this.send(e.wamid);
    if (!bs) return;
    if (e.pricing) {
      this.sql.exec(
        'UPDATE billable_sends SET billable = coalesce(?, billable), pricing_model = coalesce(?, pricing_model), category_meta = coalesce(?, category_meta), type = coalesce(?, type) WHERE wamid = ?',
        e.pricing.billable === null ? null : e.pricing.billable ? 1 : 0, e.pricing.pricingModel, e.pricing.category ? normaliseCategory(e.pricing.category) : null, e.pricing.type, e.wamid,
      );
    }
    if (e.status === 'failed') {
      if (!bs.charged_ref && bs.hold_ref) this.close(bs.hold_ref, 'released', 'failed', now);
      return;
    }
    if (e.status === 'delivered' || e.status === 'read') {
      this.sql.exec('UPDATE billable_sends SET delivered_at = coalesce(delivered_at, ?) WHERE wamid = ?', e.ts * 1000, e.wamid);
    }
    if (e.status === 'sent' && e.pricing) this.reEstimate(e.wamid, now);
    this.settleDelivered(e.wamid, now);
    this.adjustIfCategoryChanged(e.wamid);
  }

  /** `sent` + pricing: Meta says which category it will bill, so the hold follows that, not our guess. */
  private reEstimate(wamid: string, now: number): void {
    const bs = this.send(wamid);
    if (!bs || bs.funding !== 'platform_line' || !bs.hold_ref || !bs.category_meta || bs.category_meta === bs.category_est) return;
    const h = this.hold(bs.hold_ref);
    if (!h || h.state !== 'held') return;
    const p = priceAt(this.sql, { country: bs.country ?? 'ROW', category: bs.category_meta, t: now });
    if (p) this.sql.exec('UPDATE wallet_holds SET amount_minor = ?, category_est = ? WHERE ref = ? AND state = \'held\'', p.amountMinor, bs.category_meta, bs.hold_ref);
  }

  /**
   * Charges on the FIRST delivered or read with a billable flag, at the rate version in effect at delivery. Not billable: the hold is
   * released. A late billable event still charges even if the hold expired (the charge never needs the hold). Service messages on an
   * `platform_line` number are charged at the normal service rate whatever Meta billed (WA-SHARED-FREE-1; trued up at month close).
   */
  private settleDelivered(wamid: string, now: number, late = false): void {
    const bs = this.send(wamid);
    if (!bs || bs.charged_ref || bs.delivered_at === null || bs.unpriced) return;
    const category = bs.category_meta ?? bs.category_est ?? 'service';
    const service = category === 'service';
    if (bs.billable === null && !service) return; // Meta has not said yet; the pricing object may arrive on a later status
    const releaseHold = (reason: string) => { if (bs.hold_ref) this.close(bs.hold_ref, 'released', reason, now); };
    const spent = () => { if (bs.hold_ref) this.close(bs.hold_ref, 'charged', null, now); };
    if (bs.billable === 0 && !service) {
      releaseHold('not_billable');
      return;
    }
    if (bs.pricing_model && bs.pricing_model.toUpperCase() !== 'PMP') {
      this.sql.exec('UPDATE billable_sends SET unpriced = 1 WHERE wamid = ?', wamid);
      releaseHold('unpriced');
      alert('billing_unpriced_model', { workspace: this.workspaceId, model: bs.pricing_model.slice(0, 16) });
      return;
    }
    const price = priceAt(this.sql, { country: bs.country ?? 'ROW', category, t: bs.delivered_at, ...(late ? { later: true } : {}) });
    if (!price) {
      if (bs.funding === 'platform_line') {
        // Meta billed us and we cannot price it yet: never free. Kept as pending_rate and charged when a rate appears (retryPendingRates).
        // The hold STAYS (the money stays reserved) until a rate prices it or the estimate is charged in the end.
        this.sql.exec('UPDATE billable_sends SET pending_rate = 1 WHERE wamid = ?', wamid);
        alert('rate_missing_pending', { workspace: this.workspaceId, country: bs.country, category });
        addTask(this.sql, 'wallet_sweep', now + HOUR);
        this.touch();
      } else {
        this.sql.exec('UPDATE billable_sends SET unpriced = 1 WHERE wamid = ?', wamid);
        releaseHold('unpriced');
      }
      return;
    }
    if (bs.funding !== 'platform_line') {
      // The merchant's card pays Meta: keep the cost for the statement, never debit.
      this.sql.exec('UPDATE billable_sends SET cost_usd_micros = ?, charged_category = ? WHERE wamid = ?', price.usdMicros, category, wamid);
      spent();
      return;
    }
    if (price.amountMinor > 0) {
      this.post({
        kind: 'meta_charge', netMinor: -price.netMinor, vatMinor: -price.vatMinor, ref: `meta:${wamid}`, now, wamid, category,
        usdMicros: price.usdMicros, rateVer: price.rateVer, fxVer: price.fxVer, pricingVer: price.pricingVer, ...(price.note ? { note: price.note } : {}),
      });
    }
    this.sql.exec('UPDATE billable_sends SET charged_ref = ?, charged_category = ?, charged_minor = ?, cost_usd_micros = ? WHERE wamid = ?', `meta:${wamid}`, category, price.amountMinor, price.usdMicros, wamid);
    if (service) {
      ensureTrueupTask(this.sql, now);
      this.touch();
    }
    spent();
  }

  /** A rate (or FX) version arrived: every billable delivery that waited for one is priced now. Idempotent (the charge ref is meta:<wamid>). Returns how many are still waiting. */
  retryPendingRates(now: number): number {
    for (const r of this.sql.exec<{ wamid: string; delivered_at: number }>('SELECT wamid, delivered_at FROM billable_sends WHERE pending_rate = 1 ORDER BY delivered_at').toArray()) {
      this.sql.exec('UPDATE billable_sends SET pending_rate = 0 WHERE wamid = ?', r.wamid);
      // The version in effect at delivery, else the earliest one published after it (versions are published ahead, so none may "predate" a past delivery).
      this.settleDelivered(r.wamid, now, true);
      const still = this.send(r.wamid);
      if (still?.pending_rate && now - r.delivered_at >= PENDING_RATE_MAX_MS) this.chargeEstimate(r.wamid, now);
    }
    return this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM billable_sends WHERE pending_rate = 1').one().n;
  }

  /** No rate ever arrived: the held estimate is charged so a billed message is not free, with an alert for the operator to publish the rate and reconcile. */
  private chargeEstimate(wamid: string, now: number): void {
    const bs = this.send(wamid);
    const h = bs?.hold_ref ? this.hold(bs.hold_ref) : undefined;
    if (!bs || !h || h.amount_minor <= 0) {
      alert('rate_missing_no_estimate', { workspace: this.workspaceId, country: bs?.country });
      return;
    }
    this.post({ kind: 'meta_charge', netMinor: -h.amount_minor, ref: `meta:${wamid}`, now, wamid, category: bs.category_meta ?? bs.category_est ?? 'service', note: 'estimate: no rate published' });
    this.sql.exec('UPDATE billable_sends SET pending_rate = 0, charged_ref = ?, charged_category = ?, charged_minor = ? WHERE wamid = ?', `meta:${wamid}`, bs.category_meta ?? bs.category_est, h.amount_minor, wamid);
    if (bs.hold_ref) this.close(bs.hold_ref, 'charged', null, now);
    alert('rate_missing_estimate_charged', { workspace: this.workspaceId, country: bs.country });
  }

  /** Meta's billed category wins: a later status that names another category than the one we charged posts the difference as meta_adjust. */
  private adjustIfCategoryChanged(wamid: string): void {
    const bs = this.send(wamid);
    if (!bs || bs.funding !== 'platform_line' || !bs.charged_ref || !bs.category_meta || bs.delivered_at === null) return;
    if (bs.category_meta === bs.charged_category) return;
    const price = priceAt(this.sql, { country: bs.country ?? 'ROW', category: bs.category_meta, t: bs.delivered_at });
    if (!price) return;
    const oldPrice = priceAt(this.sql, { country: bs.country ?? 'ROW', category: bs.charged_category ?? bs.category_meta, t: bs.delivered_at });
    const diffNet = price.netMinor - (oldPrice?.netMinor ?? 0);
    const diffVat = price.vatMinor - (oldPrice?.vatMinor ?? 0);
    if (diffNet + diffVat !== 0) {
      this.post({
        kind: 'meta_adjust', netMinor: -diffNet, vatMinor: -diffVat, ref: `adj:${wamid}:${bs.category_meta}`, now: bs.delivered_at, wamid, category: bs.category_meta,
        usdMicros: price.usdMicros, rateVer: price.rateVer, fxVer: price.fxVer, pricingVer: price.pricingVer,
      });
    }
    this.sql.exec('UPDATE billable_sends SET charged_category = ?, charged_minor = ? WHERE wamid = ?', bs.category_meta, price.amountMinor, wamid);
  }

  /**
   * Funds arrived: waiting utility and service sends are released in arrival order for as long as the wallet (with its overdraft) can pay
   * for the next one. A released message goes back through the claim, which decides again; this only moves its scheduler row to now.
   */
  releaseWaiters(now: number): number {
    const waits = this.sql.exec<{ id: number; payload: string }>("SELECT id, payload FROM scheduled_tasks WHERE kind = 'wallet_wait' AND lease_until IS NULL ORDER BY id").toArray();
    let room = this.available() + this.creditLimit(now);
    let released = 0;
    for (const w of waits) {
      const job = (JSON.parse(w.payload) as { job: SendJob }).job;
      const est = this.estimateMinor(job.to, this.jobCategory(job), now).minor;
      if (est > room) break; // strict arrival order: nobody jumps the queue
      room -= est;
      this.sql.exec('UPDATE scheduled_tasks SET due_at = ? WHERE id = ? AND due_at > ?', now, w.id, now);
      released++;
    }
    if (released) this.touch();
    return released;
  }

  // ---- views --------------------------------------------------------------------------------------------------------

  view(now: number) {
    const balance = this.balance();
    const held = this.held();
    const st = settingsAt(this.sql, now);
    return {
      balanceMinor: balance, heldMinor: held, availableMinor: balance - held, debtMinor: balance < 0 ? -balance : 0,
      creditLimitMinor: st.creditLimitMinor ?? DEFAULT_SETTINGS.creditLimitMinor, lowBalance: balance - held < LOW_BALANCE_MINOR,
    };
  }
}
