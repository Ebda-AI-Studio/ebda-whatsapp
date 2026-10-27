/**
 * The card provider behind wallet top-ups, as an interface so the money logic never depends on one vendor's shapes.
 *
 * Kashier webhook verification follows the official documentation (https://developers.kashier.io/docs/webhooks, payloads at
 * https://developers.kashier.io/docs/webhooks/payloads): header `x-kashier-signature`; take `data.signatureKeys`, sort them
 * alphabetically, build `key=encodeURIComponent(value)` pairs joined with `&` from `data`, HMAC-SHA256 with the Payment API Key,
 * hex digest, compared case-insensitively; `data.status` (not `event`) says success; `data.hash` is ignored.
 *
 * NOT VERIFIED against a live account: the hosted checkout link (`createSession`), the inquiry and the refund calls. They are behind
 * the interface; `KashierProvider` implements the checkout link from Kashier's published payment-hash scheme. Inquiry is built on the
 * documented transaction list (`GET /v2/aggregator/transactions?search=<our order id>&type=payment`, https://developers.kashier.io/openapi.yaml,
 * `listTransactions`) and then confirmed with the transaction-details call the webhook path uses. The refund call is added behind
 * `KASHIER_REFUNDS_ENABLED` (see `refund` below).
 */
import type { Env } from '../../env';
import { KashierUnconfirmedError, TRANSACTION_ID, classifyKashierTransaction, kashierTransactionDetailsPath } from './kashier-confirm';
import { alert } from '../observability';

export type ProviderEvent = 'pay' | 'refund' | 'other';
export type ParsedWebhook = { event: ProviderEvent; status: 'SUCCESS' | 'FAILURE' | 'PENDING'; orderId: string; transactionId: string; amountMinor: number; currency: string; /** A chargeback (Kashier's `reversal` operation). Only ever set by `confirm`, from Kashier's own record. */ chargeback?: true; /** Kashier's own operation for the transaction (refund, partial_refund, void, reversal, pay...), set only by `confirm`. */ operation?: string; /** `kashier:<transactionId>:<status>`: built from SIGNED values only, never from the unsigned `event` label. */ eventKey?: string };
export type Inquiry = { status: 'SUCCESS' | 'FAILURE' | 'PENDING'; transactionId: string | null; amountMinor: number | null; currency: string | null };
/**
 * `ok` = Kashier took the refund (`status` SUCCESS, default; PENDING = initiated, the processor has not answered).
 * `unsupported` / `unavailable` / `rejected` = Kashier definitely did NOT refund (nothing was sent, or it answered a clear refusal).
 * `uncertain` = the request may have been processed (timeout, 5xx, an answer we cannot read): never retried, reconciled instead.
 */
export type RefundResult = { ok: true; refundId: string; status?: 'SUCCESS' | 'PENDING' } | { ok: false; reason: 'unsupported' | 'rejected' | 'unavailable' | 'uncertain' };
/** The ONE definition of "a card refund of a payment" (Kashier operations `refund` / `partial_refund`). A reversal (chargeback) or void is not one. Every path that decides whether an event or a listed transaction can settle one of our refunds uses this. */
export const isCardRefundOperation = (operation: string | undefined): boolean => operation === 'refund' || operation === 'partial_refund';
export type ProviderRefund = { refundId: string; status: 'SUCCESS' | 'FAILURE' | 'PENDING'; amountMinor: number | null; /** Kashier's operation for it: only `refund` / `partial_refund` is a card refund; `reversal` / `void` are not. */ operation: string };

export interface PaymentProvider {
  readonly name: string;
  createSession(a: { orderId: string; totalMinor: number; currency: string; returnUrl?: string }): Promise<{ checkoutUrl: string }>;
  /** Null when the signature or the structure is not valid. Never throws on hostile input. */
  verifyWebhook(rawBody: string, signatureHeader: string | null): Promise<ParsedWebhook | null>;
  /**
   * The webhook's `event` label is unsigned, so it is never applied. This asks the provider for ITS record of the signed transaction and
   * returns the event with the kind and status the provider reports. Throws when the provider cannot be asked or its answer does not
   * match the signed body (the caller answers 5xx and nothing is applied).
   */
  confirm(ev: ParsedWebhook): Promise<ParsedWebhook>;
  /** False when webhooks for this provider could not be confirmed (no secret key): checkout must not open, or customers would pay while every webhook is refused. */
  confirmationReady(): boolean;
  inquire(orderId: string): Promise<Inquiry | 'unsupported' | 'unavailable'>;
  /** `reason` carries our refund request id (Kashier documents no idempotency key). Never called twice for one recorded refund. */
  refund(a: { transactionId: string; amountMinor: number; reason?: string }): Promise<RefundResult>;
  /** Kashier's own record of one refund transaction (reconciliation of a pending or uncertain refund). */
  refundStatus?(refundId: string): Promise<'SUCCESS' | 'FAILURE' | 'PENDING' | 'unavailable'>;
  /** Refund transactions Kashier lists for our order id (reconciliation of a refund whose answer we never saw). */
  listRefunds?(orderId: string): Promise<ProviderRefund[] | 'unavailable'>;
}

let factory: (env: Env) => PaymentProvider | null = (env) => (env.KASHIER_MERCHANT_ID && env.KASHIER_API_KEY ? new KashierProvider(env.KASHIER_MERCHANT_ID, env.KASHIER_API_KEY, env.KASHIER_CHECKOUT_URL, { ...(env.KASHIER_SECRET_KEY ? { secretKey: env.KASHIER_SECRET_KEY } : {}), ...(env.KASHIER_API_URL ? { apiBase: env.KASHIER_API_URL } : {}) }) : null);
/** Tests install a fake here. */
export const configurePayments = (f: (env: Env) => PaymentProvider | null): void => { factory = f; };
export const paymentProvider = (env: Env): PaymentProvider | null => factory(env);
export const topupsEnabled = (env: Env): boolean => env.TOPUPS_ENABLED === 'true';
export const packagesEnabled = (env: Env): boolean => env.PACKAGE_CHECKOUT_ENABLED === 'true';
/** Card refunds through the provider's API. Default off: every refund is then a manual payout, exactly as before. */
export const refundsEnabled = (env: Env): boolean => env.KASHIER_REFUNDS_ENABLED === 'true';

const enc = new TextEncoder();
async function hmacHex(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function sameHex(a: string, b: string): boolean {
  const x = enc.encode(a.toLowerCase());
  const y = enc.encode(b.toLowerCase());
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

/** "12.34" or 12.34 (EGP) to 1234 piasters without a float; null for anything else. */
export function egpToMinor(v: unknown): number | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s.trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0) : null;
}
export const minorToEgp = (minor: number): string => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

/** Fields a webhook must have signed, or an attacker could simply leave them out of signatureKeys. */
const MUST_BE_SIGNED = ['amount', 'currency', 'merchantOrderId', 'status', 'transactionId'] as const;

export class KashierProvider implements PaymentProvider {
  readonly name = 'kashier';
  private readonly secretKey: string | undefined;
  private readonly apiBase: string;
  private readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  constructor(private readonly merchantId: string, private readonly apiKey: string, private readonly checkoutOrigin = 'https://checkout.kashier.io', opts: { secretKey?: string; apiBase?: string; fetch?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
    this.secretKey = opts.secretKey;
    this.apiBase = (opts.apiBase ?? 'https://api.kashier.io').replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  confirmationReady(): boolean {
    return this.ready();
  }

  async confirm(ev: ParsedWebhook): Promise<ParsedWebhook> {
    if (!this.secretKey) throw new KashierUnconfirmedError('the Kashier secret key is not configured');
    if (!KashierProvider.pinned(this.apiBase)) throw new KashierUnconfirmedError('the Kashier API origin is not https on kashier.io');
    let answer: unknown;
    try {
      const res = await this.fetchImpl(`${this.apiBase}${kashierTransactionDetailsPath(ev.transactionId)}`, { method: 'GET', headers: { Authorization: this.secretKey, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new KashierUnconfirmedError(`details answered ${res.status}`); // a 404 is "not there YET", retried like an outage
      answer = await res.json();
    } catch (err) {
      throw err instanceof KashierUnconfirmedError ? err : new KashierUnconfirmedError('the Kashier details API could not be reached');
    }
    const txn = classifyKashierTransaction(answer, { transactionId: ev.transactionId, merchantOrderId: ev.orderId });
    if (txn.status !== ev.status) throw new KashierUnconfirmedError('Kashier reports a different status than the signed body');
    const { chargeback: _drop, ...rest } = ev;
    return { ...rest, event: txn.kind === 'refund' ? 'refund' : txn.kind === 'payment' ? 'pay' : 'other', operation: txn.operation, ...(txn.operation === 'reversal' ? { chargeback: true as const } : {}) };
  }

  async createSession(a: { orderId: string; totalMinor: number; currency: string; returnUrl?: string }): Promise<{ checkoutUrl: string }> {
    const amount = minorToEgp(a.totalMinor);
    const hash = await hmacHex(this.apiKey, `/?payment=${this.merchantId}.${a.orderId}.${amount}.${a.currency}`);
    const q = new URLSearchParams({ merchantId: this.merchantId, orderId: a.orderId, amount, currency: a.currency, hash, mode: 'live', allowedMethods: 'card', ...(a.returnUrl ? { merchantRedirect: a.returnUrl } : {}) });
    return { checkoutUrl: `${this.checkoutOrigin}/?${q.toString()}` };
  }

  async verifyWebhook(rawBody: string, signatureHeader: string | null): Promise<ParsedWebhook | null> {
    if (!signatureHeader) return null;
    let body: unknown;
    try { body = JSON.parse(rawBody); } catch { return null; }
    const root = body as { event?: unknown; data?: Record<string, unknown> };
    const data = root?.data;
    if (!data || typeof data !== 'object' || !Array.isArray(data.signatureKeys) || !data.signatureKeys.every((k) => typeof k === 'string')) return null;
    const keys = [...(data.signatureKeys as string[])].sort();
    if (!MUST_BE_SIGNED.every((k) => keys.includes(k))) return null;
    if (keys.some((k) => data[k] === undefined || data[k] === null || typeof data[k] === 'object')) return null;
    const signed = keys.map((k) => `${k}=${encodeURIComponent(String(data[k]))}`).join('&');
    if (!sameHex(await hmacHex(this.apiKey, signed), signatureHeader.trim())) return null;
    const status = data.status === 'SUCCESS' || data.status === 'FAILURE' || data.status === 'PENDING' ? data.status : null;
    const amountMinor = egpToMinor(data.amount);
    if (!status || amountMinor === null || typeof data.merchantOrderId !== 'string' || typeof data.transactionId !== 'string' || typeof data.currency !== 'string') return null;
    const ev = root.event === 'pay' ? 'pay' : root.event === 'refund' || root.event === 'partial_refund' || root.event === 'reversal' ? 'refund' : 'other';
    return { event: ev, status, orderId: data.merchantOrderId, transactionId: data.transactionId, amountMinor, currency: data.currency, eventKey: `kashier:${data.transactionId}:${data.status}` };
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.fetchImpl(url, { method: 'GET', headers: { Authorization: this.secretKey!, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new KashierUnconfirmedError(`answered ${res.status}`);
    return res.json();
  }
  /**
   * The secret key is only ever sent to Kashier: the API origin must be https on kashier.io or a subdomain of it (api., test-api.), whatever
   * KASHIER_API_URL says. Anything else is refused before a request is made.
   */
  private ready(): boolean {
    return !!this.secretKey && KashierProvider.pinned(this.apiBase);
  }
  static pinned(base: string): boolean {
    try {
      const u = new URL(base);
      return u.protocol === 'https:' && !u.username && !u.password && (u.hostname === 'kashier.io' || u.hostname.endsWith('.kashier.io'));
    } catch {
      return false;
    }
  }

  /** Rows of the documented list call whose `merchantOrderId` is exactly ours, over up to 5 pages. Throws when the answer cannot be trusted. */
  private async listCandidates(orderId: string, type: 'payment' | 'refund'): Promise<Map<string, { amountMinor: number | null; currency: string | null }>> {
    const candidates = new Map<string, { amountMinor: number | null; currency: string | null }>();
    const PAGE = 20;
    for (let page = 1; ; page++) {
      const listed = await this.getJson(`${this.apiBase}/v2/aggregator/transactions?search=${encodeURIComponent(orderId)}&type=${type}&limit=${PAGE}&page=${page}`);
      const rows = listed && typeof listed === 'object' ? (listed as { body?: unknown }).body : undefined;
      if (!Array.isArray(rows)) throw new KashierUnconfirmedError('the list carried no rows');
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const row = r as Record<string, unknown>;
        if (row.merchantOrderId !== orderId || typeof row.transactionId !== 'string' || (typeof row.type === 'string' && row.type.toUpperCase() !== type.toUpperCase())) continue;
        if (!candidates.has(row.transactionId)) candidates.set(row.transactionId, { amountMinor: egpToMinor(row.amount ?? row.totalAuthorizedAmount), currency: typeof row.currency === 'string' ? row.currency : null });
      }
      if (rows.length < PAGE) return candidates;
      if (page >= 5) throw new KashierUnconfirmedError('too many rows to read safely'); // an order with 100+ rows is not guessed at
    }
  }

  /**
   * Our order id is the `merchantOrderId` Kashier knows. The documented list call has a `search` filter ("keyword for trxId or merchant
   * orderId"); only rows whose `merchantOrderId` equals our id exactly are candidates, and EVERY candidate is then confirmed with the
   * transaction-details call the webhook path uses (status, kind and order come from that record, never from the list). The amount and
   * currency come from the list row (details carry no amount in the documented example); a wrong guess there only ever fails closed
   * (the caller sees a mismatch). Anything unclear is `unavailable`, retried on the next pass; several successful payments for one
   * order are not guessed between (alert). NOT VERIFIED live: the list row's amount field (`amount` or `totalAuthorizedAmount`).
   */
  async inquire(orderId: string): Promise<Inquiry | 'unsupported' | 'unavailable'> {
    if (!this.ready() || !TRANSACTION_ID.test(orderId)) return 'unavailable';
    try {
      const candidates = await this.listCandidates(orderId, 'payment');
      const confirmed: { transactionId: string; status: Inquiry['status']; amountMinor: number | null; currency: string | null }[] = [];
      for (const [transactionId, listedRow] of candidates) {
        const txn = classifyKashierTransaction(await this.getJson(`${this.apiBase}${kashierTransactionDetailsPath(transactionId)}`), { transactionId, merchantOrderId: orderId });
        if (txn.kind === 'payment') confirmed.push({ transactionId, status: txn.status, ...listedRow });
      }
      const paid = confirmed.filter((c) => c.status === 'SUCCESS');
      if (paid.length > 1) {
        alert('inquiry_multiple_success', { orderId, count: paid.length });
        return 'unavailable';
      }
      if (paid.length === 1) return { status: 'SUCCESS', transactionId: paid[0]!.transactionId, amountMinor: paid[0]!.amountMinor, currency: paid[0]!.currency };
      if (confirmed.length > 0 && confirmed.every((c) => c.status === 'FAILURE')) return { status: 'FAILURE', transactionId: null, amountMinor: null, currency: null };
      return { status: 'PENDING', transactionId: null, amountMinor: null, currency: null };
    } catch {
      return 'unavailable';
    }
  }

  async refundStatus(refundId: string): Promise<'SUCCESS' | 'FAILURE' | 'PENDING' | 'unavailable'> {
    if (!this.ready() || !TRANSACTION_ID.test(refundId)) return 'unavailable';
    try {
      const txn = classifyKashierTransaction(await this.getJson(`${this.apiBase}${kashierTransactionDetailsPath(refundId)}`), { transactionId: refundId, merchantOrderId: null });
      return txn.kind === 'refund' ? txn.status : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  /** NOT VERIFIED live: that a refund row carries the ORIGINAL order's merchantOrderId (the webhook handling already assumes it). */
  async listRefunds(orderId: string): Promise<ProviderRefund[] | 'unavailable'> {
    if (!this.ready() || !TRANSACTION_ID.test(orderId)) return 'unavailable';
    try {
      const out: ProviderRefund[] = [];
      for (const [refundId, row] of await this.listCandidates(orderId, 'refund')) {
        const txn = classifyKashierTransaction(await this.getJson(`${this.apiBase}${kashierTransactionDetailsPath(refundId)}`), { transactionId: refundId, merchantOrderId: orderId });
        if (txn.kind === 'refund' && isCardRefundOperation(txn.operation)) out.push({ refundId, status: txn.status, amountMinor: row.amountMinor, operation: txn.operation });
      }
      return out;
    } catch {
      return 'unavailable';
    }
  }

  /**
   * Card refund through Kashier's documented refund operation: `PUT {api}/v3/payment/refund/{kashier order id}` (the same operation as
   * `PUT fep.kashier.io/v3/orders/{id}` with `apiOperation: REFUND`; this route avoids a second host and a forwarding hop), body
   * `{apiOperation: 'REFUND', reason, transaction: {amount}}` (EGP, https://developers.kashier.io/openapi.yaml `refundOrder`).
   * The path id is "Kashier's order id": it is read from the paid transaction's details (`body.order.orderId`), never guessed from ours; if
   * the details do not carry it nothing is sent (`unsupported`). Kashier documents NO idempotency key, so this method is called at most once
   * per recorded refund (the caller writes the row first) and any answer that might mean "processed" is `uncertain`, never a retry.
   * Success needs top-level `status` SUCCESS, `response.status` SUCCESS|PENDING, `response.operation` refund, a plain `response.transactionId`
   * and the amount we asked for; anything else that came back 200 is `uncertain`. 400/401/403/404/422 and an explicit FAILURE are `rejected`.
   * NOT VERIFIED live: the response shape, that the path accepts this id, and PENDING behaviour.
   */
  async refund(a: { transactionId: string; amountMinor: number; reason?: string }): Promise<RefundResult> {
    if (!this.ready() || !TRANSACTION_ID.test(a.transactionId) || !Number.isSafeInteger(a.amountMinor) || a.amountMinor <= 0) return { ok: false, reason: 'unsupported' };
    let kashierOrderId = '';
    try {
      const details = await this.getJson(`${this.apiBase}${kashierTransactionDetailsPath(a.transactionId)}`);
      const txn = classifyKashierTransaction(details, { transactionId: a.transactionId, merchantOrderId: null });
      const order = ((details as { body?: { order?: { orderId?: unknown } } }).body?.order ?? {}).orderId;
      if (txn.kind !== 'payment' || txn.status !== 'SUCCESS' || typeof order !== 'string' || !TRANSACTION_ID.test(order)) return { ok: false, reason: 'unsupported' };
      kashierOrderId = order;
    } catch (err) {
      return { ok: false, reason: err instanceof KashierUnconfirmedError && /answered (4\d\d)/.test(err.message) ? 'unsupported' : 'unavailable' }; // nothing was sent yet
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}/v3/payment/refund/${kashierOrderId}`, {
        method: 'PUT',
        headers: { Authorization: this.secretKey!, 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiOperation: 'REFUND', ...(a.reason ? { reason: a.reason } : {}), transaction: { amount: Number(minorToEgp(a.amountMinor)) } }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return { ok: false, reason: 'uncertain' }; // the request may have reached Kashier
    }
    if ([400, 401, 403, 404, 422].includes(res.status)) return { ok: false, reason: 'rejected' };
    if (!res.ok) return { ok: false, reason: 'uncertain' };
    let body: unknown;
    try { body = await res.json(); } catch { return { ok: false, reason: 'uncertain' }; }
    const top = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const inner = top.response && typeof top.response === 'object' ? (top.response as Record<string, unknown>) : {};
    const refundId = typeof inner.transactionId === 'string' ? inner.transactionId : typeof top.transactionId === 'string' ? top.transactionId : '';
    const innerStatus = typeof inner.status === 'string' ? inner.status.toUpperCase() : '';
    if (innerStatus === 'FAILURE' || top.status === 'FAILURE') return { ok: false, reason: 'rejected' };
    const asked = egpToMinor(inner.amount);
    if (top.status === 'SUCCESS' && (innerStatus === 'SUCCESS' || innerStatus === 'PENDING') && isCardRefundOperation(String(inner.operation).toLowerCase()) && TRANSACTION_ID.test(refundId) && asked === a.amountMinor) {
      return { ok: true, refundId, status: innerStatus };
    }
    return { ok: false, reason: 'uncertain' };
  }
}
