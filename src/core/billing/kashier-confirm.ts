/**
 * Server-to-server confirmation of a Kashier webhook (the same rule the Store applies).
 *
 * The webhook signature covers the `data` keys listed in `signatureKeys`, but NOT the top-level `event` label (pay / refund /
 * partial_refund / reversal). A captured genuine delivery can be relabelled and still verify. So the label is never applied: before any
 * money or entitlement effect we ask Kashier for ITS record of the signed transaction id
 *
 *   GET {api}/v2/aggregator/transactions/:transactionId     Authorization: <Kashier SECRET key> (raw, no Bearer)
 *
 * and act on the kind and status Kashier reports. Documented: path, auth header, `{ body: {...} }`, `body.status` (SUCCESS | FAILURE |
 * PENDING), `body.transactionId`, `body.trxType`, `body.merchantOrderId`, `body.transactions[]` (`operation`, `status`, `transactionId`).
 * NOT VERIFIED live: the operation value of a refund transaction (we accept refund / partial_refund / void / reversal and nothing else),
 * whether a refund's details carry merchantOrderId (checked when present), and whether a transaction can be queried the instant its
 * webhook arrives (a 404 is "not confirmable yet", retried like an outage). Anything unclear is NOT a confirmation: the caller answers
 * 5xx so Kashier retries, and nothing is applied.
 */
export const kashierTransactionDetailsPath = (transactionId: string): string => `/v2/aggregator/transactions/${encodeURIComponent(transactionId)}`;

export type KashierTxnKind = 'payment' | 'authorize' | 'refund';
export type KashierTxnStatus = 'SUCCESS' | 'FAILURE' | 'PENDING';
export type KashierConfirmedTxn = { kind: KashierTxnKind; status: KashierTxnStatus; operation: string };

export class KashierUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KashierUnconfirmedError';
  }
}

const REFUND_OPS = new Set(['refund', 'partial_refund', 'void', 'reversal']);
const PAYMENT_OPS = new Set(['pay', 'payment', 'capture']);
const AUTHORIZE_OPS = new Set(['authorize', 'authorization']);
const STATUS_FOLD: Record<string, KashierTxnStatus> = {
  SUCCESS: 'SUCCESS', FAILURE: 'FAILURE', PENDING: 'PENDING',
  INITIATED: 'PENDING', UNKNOWN: 'PENDING', // neither paid nor failed yet
  EXPIRED: 'FAILURE', CANCEL: 'FAILURE', REVOKED: 'FAILURE', // terminal non-success
};
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/** Reads a `getTransactionDetails` answer. Throws `KashierUnconfirmedError` unless it is a clear record of THIS transaction (and order, when stated). */
export function classifyKashierTransaction(response: unknown, expect: { transactionId: string; merchantOrderId: string | null }): KashierConfirmedTxn {
  const body = response && typeof response === 'object' ? (response as { body?: unknown }).body : undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new KashierUnconfirmedError('transaction details carried no body');
  const b = body as Record<string, unknown>;
  if (str(b.transactionId) !== expect.transactionId) throw new KashierUnconfirmedError('transaction details are for a different transaction');
  const order = str(b.merchantOrderId);
  if (order && expect.merchantOrderId && order !== expect.merchantOrderId) throw new KashierUnconfirmedError('transaction belongs to a different order');
  const entries = Array.isArray(b.transactions) ? b.transactions : [];
  const entry = entries.find((t): t is Record<string, unknown> => !!t && typeof t === 'object' && str((t as Record<string, unknown>).transactionId) === expect.transactionId);
  const operation = (str(entry?.operation) || str(b.trxType)).toLowerCase();
  let kind: KashierTxnKind;
  if (REFUND_OPS.has(operation)) kind = 'refund';
  else if (AUTHORIZE_OPS.has(operation)) kind = 'authorize';
  else if (PAYMENT_OPS.has(operation)) kind = 'payment';
  else throw new KashierUnconfirmedError(`unknown transaction operation "${operation}"`);
  const rawStatus = (str(entry?.status) || str(b.status)).toUpperCase();
  const status = STATUS_FOLD[rawStatus];
  if (!status) throw new KashierUnconfirmedError(`unknown transaction status "${rawStatus}"`);
  return { kind, status, operation };
}
