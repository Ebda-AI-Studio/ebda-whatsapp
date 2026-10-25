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

export type ProviderEvent = 'pay' | 'refund' | 'other';
export type ParsedWebhook = { event: ProviderEvent; status: 'SUCCESS' | 'FAILURE' | 'PENDING'; orderId: string; transactionId: string; amountMinor: number; currency: string; /** A chargeback (Kashier's `reversal` operation). Only ever set by `confirm`, from Kashier's own record. */ chargeback?: true; /** `kashier:<transactionId>:<status>`: built from SIGNED values only, never from the unsigned `event` label. */ eventKey?: string };
export type Inquiry = { status: 'SUCCESS' | 'FAILURE' | 'PENDING'; transactionId: string | null; amountMinor: number | null; currency: string | null };
export type RefundResult = { ok: true; refundId: string } | { ok: false; reason: 'unsupported' | 'rejected' | 'unavailable' };

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
  refund(a: { transactionId: string; amountMinor: number }): Promise<RefundResult>;
}

let factory: (env: Env) => PaymentProvider | null = (env) => (env.KASHIER_MERCHANT_ID && env.KASHIER_API_KEY ? new KashierProvider(env.KASHIER_MERCHANT_ID, env.KASHIER_API_KEY, env.KASHIER_CHECKOUT_URL, { ...(env.KASHIER_SECRET_KEY ? { secretKey: env.KASHIER_SECRET_KEY } : {}), ...(env.KASHIER_API_URL ? { apiBase: env.KASHIER_API_URL } : {}) }) : null);
/** Tests install a fake here. */
export const configurePayments = (f: (env: Env) => PaymentProvider | null): void => { factory = f; };
export const paymentProvider = (env: Env): PaymentProvider | null => factory(env);
export const topupsEnabled = (env: Env): boolean => env.TOPUPS_ENABLED === 'true';
export const packagesEnabled = (env: Env): boolean => env.PACKAGE_CHECKOUT_ENABLED === 'true';

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
    return !!this.secretKey;
  }

  async confirm(ev: ParsedWebhook): Promise<ParsedWebhook> {
    if (!this.secretKey) throw new KashierUnconfirmedError('the Kashier secret key is not configured');
    if (!/^https:\/\//i.test(this.apiBase)) throw new KashierUnconfirmedError('the Kashier API origin is not https');
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
    return { ...rest, event: txn.kind === 'refund' ? 'refund' : txn.kind === 'payment' ? 'pay' : 'other', ...(txn.operation === 'reversal' ? { chargeback: true as const } : {}) };
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

  /**
   * Our order id is the `merchantOrderId` Kashier knows. The documented list call has a `search` filter ("keyword for trxId or merchant
   * orderId"); only rows whose `merchantOrderId` equals our id exactly are candidates, and EVERY candidate is then confirmed with the
   * transaction-details call the webhook path uses (status, kind and order come from that record, never from the list). The amount and
   * currency come from the list row (details carry no amount in the documented example); a wrong guess there only ever fails closed
   * (the caller sees a mismatch). Anything unclear is `unavailable`, retried on the next pass; several successful payments for one
   * order are not guessed between (alert). NOT VERIFIED live: the list row's amount field (`amount` or `totalAuthorizedAmount`).
   */
  async inquire(orderId: string): Promise<Inquiry | 'unsupported' | 'unavailable'> {
    if (!this.secretKey || !/^https:\/\//i.test(this.apiBase) || !TRANSACTION_ID.test(orderId)) return 'unavailable';
    const get = async (url: string): Promise<unknown> => {
      const res = await this.fetchImpl(url, { method: 'GET', headers: { Authorization: this.secretKey!, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new KashierUnconfirmedError(`answered ${res.status}`);
      return res.json();
    };
    try {
      const candidates = new Map<string, { amountMinor: number | null; currency: string | null }>();
      const PAGE = 20;
      for (let page = 1; ; page++) {
        const listed = await get(`${this.apiBase}/v2/aggregator/transactions?search=${encodeURIComponent(orderId)}&type=payment&limit=${PAGE}&page=${page}`);
        const rows = listed && typeof listed === 'object' ? (listed as { body?: unknown }).body : undefined;
        if (!Array.isArray(rows)) return 'unavailable';
        for (const r of rows) {
          if (!r || typeof r !== 'object') continue;
          const row = r as Record<string, unknown>;
          if (row.merchantOrderId !== orderId || typeof row.transactionId !== 'string' || (typeof row.type === 'string' && row.type.toUpperCase() !== 'PAYMENT')) continue;
          if (!candidates.has(row.transactionId)) candidates.set(row.transactionId, { amountMinor: egpToMinor(row.amount ?? row.totalAuthorizedAmount), currency: typeof row.currency === 'string' ? row.currency : null });
        }
        if (rows.length < PAGE) break;
        if (page >= 5) return 'unavailable'; // an order with 100+ payment rows is not guessed at
      }
      const confirmed: { transactionId: string; status: Inquiry['status']; amountMinor: number | null; currency: string | null }[] = [];
      for (const [transactionId, listedRow] of candidates) {
        const txn = classifyKashierTransaction(await get(`${this.apiBase}${kashierTransactionDetailsPath(transactionId)}`), { transactionId, merchantOrderId: orderId });
        if (txn.kind === 'payment') confirmed.push({ transactionId, status: txn.status, ...listedRow });
      }
      const paid = confirmed.filter((c) => c.status === 'SUCCESS');
      if (paid.length > 1) {
        console.error(JSON.stringify({ alert: 'inquiry_multiple_success', orderId, count: paid.length }));
        return 'unavailable';
      }
      if (paid.length === 1) return { status: 'SUCCESS', transactionId: paid[0]!.transactionId, amountMinor: paid[0]!.amountMinor, currency: paid[0]!.currency };
      if (confirmed.length > 0 && confirmed.every((c) => c.status === 'FAILURE')) return { status: 'FAILURE', transactionId: null, amountMinor: null, currency: null };
      return { status: 'PENDING', transactionId: null, amountMinor: null, currency: null };
    } catch {
      return 'unavailable';
    }
  }

  async refund(): Promise<RefundResult> {
    return { ok: false, reason: 'unsupported' };
  }
}
