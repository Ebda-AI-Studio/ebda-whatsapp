import { KEY, kashierLedger } from './kashier';

async function hmac(text: string, key = KEY): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** A webhook signed the documented way. `genuine` is what Kashier's own record says the transaction really is (defaults to the label). */
export async function signedWebhook(data: Record<string, string | number>, event = 'pay', genuine?: string) {
  const keys = ['amount', 'channel', 'currency', 'kashierOrderId', 'merchantOrderId', 'method', 'orderReference', 'status', 'transactionId', 'transactionResponseCode'];
  const full = { kashierOrderId: 'ko-1', orderReference: 'ref-1', method: 'card', channel: 'online', transactionResponseCode: '00', currency: 'EGP', status: 'SUCCESS', ...data, signatureKeys: keys };
  const f = full as Record<string, unknown>;
  if (!kashierLedger.has(String(f.transactionId)) || genuine) kashierLedger.set(String(f.transactionId), { operation: genuine ?? event, status: String(f.status), orderId: String(f.merchantOrderId) });
  const str = keys.map((k) => `${k}=${encodeURIComponent(String(f[k]))}`).join('&');
  return { body: JSON.stringify({ event, data: full }), sig: await hmac(str) };
}
