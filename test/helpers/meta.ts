export const TEST_APP_SECRET = 'test-secret';

export async function sign(raw: string, secret = TEST_APP_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  return 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function postWebhook(fetcher: Fetcher, raw: string, signature?: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const sig = signature === undefined ? await sign(raw) : signature;
  if (sig !== null) headers['x-hub-signature-256'] = sig;
  return fetcher.fetch('https://x/meta/webhook', { method: 'POST', headers, body: raw });
}
