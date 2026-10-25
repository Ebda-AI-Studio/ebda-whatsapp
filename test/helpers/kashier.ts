import { KashierProvider } from '../../src/core/billing/payments';

export const KEY = 'test-payment-api-key';
/** What Kashier's own transaction record says each signed transaction really is (the transaction-details API stub reads this). */
export type Genuine = { operation: string; status: string; orderId?: string };
export const kashierLedger = new Map<string, Genuine>();
export const detailsFetch = async (url: string): Promise<Response> => {
  const tx = decodeURIComponent(url.split('/').pop() ?? '');
  const g = kashierLedger.get(tx);
  if (!g) return new Response('not found', { status: 404 });
  return Response.json({ body: { transactionId: tx, trxType: g.operation, status: g.status, ...(g.orderId ? { merchantOrderId: g.orderId } : {}) } });
};
export const testKashier = (fetchImpl: (url: string) => Promise<Response> = detailsFetch) =>
  new KashierProvider('MID-1', KEY, undefined, { secretKey: 'sk-test', fetch: (url) => fetchImpl(url) });
