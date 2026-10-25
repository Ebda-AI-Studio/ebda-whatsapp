import { KashierProvider } from '../../src/core/billing/payments';

export const KEY = 'test-payment-api-key';
/** What Kashier's own transaction record says each signed transaction really is (the transaction-details API stub reads this). */
export type Genuine = { operation: string; status: string; orderId?: string };
export const kashierLedger = new Map<string, Genuine>();
/** What Kashier's transaction LIST says about each of our order ids (the `search` lookup by merchant order id). */
export type ListedPayment = { transactionId: string; amount: string; currency?: string; type?: string; merchantOrderId?: string };
export const kashierOrders = new Map<string, ListedPayment[]>();
/** The refund rows Kashier lists for an order (`type=refund`). */
export const kashierRefunds = new Map<string, ListedPayment[]>();
export const detailsFetch = async (url: string): Promise<Response> => {
  if (url.includes('/v2/aggregator/transactions?')) {
    const q = new URL(url).searchParams;
    const order = q.get('search') ?? '';
    const limit = Number(q.get('limit') ?? 20);
    const page = Number(q.get('page') ?? 1);
    const isRefund = q.get('type') === 'refund';
    const hits = ((isRefund ? kashierRefunds : kashierOrders).get(order) ?? []).slice((page - 1) * limit, page * limit).map((p) => ({ merchantOrderId: order, type: isRefund ? 'REFUND' : 'PAYMENT', currency: 'EGP', status: 'Approved', ...p, totalAuthorizedAmount: p.amount }));
    return Response.json({ body: hits, message: 'ok' });
  }
  const tx = decodeURIComponent(url.split('/').pop() ?? '');
  const g = kashierLedger.get(tx);
  if (!g) return new Response('not found', { status: 404 });
  return Response.json({ body: { transactionId: tx, trxType: g.operation, status: g.status, ...(g.orderId ? { merchantOrderId: g.orderId } : {}), order: { orderId: `KO-${tx}` } } });
};
export const testKashier = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = detailsFetch) =>
  new KashierProvider('MID-1', KEY, undefined, { secretKey: 'sk-test', fetch: (url, init) => fetchImpl(url, init) });
