// InstaPay digest text, Telegram tap codec and the product<->brain bridge signature (money path). Web Crypto only, so it runs in Workers and Node.
export type DigestItem = { product: 'store' | 'chat'; id: string; ownerLabel: string; amountMinor: number; kind: string; confirmedAt: number };
type DigestButton = { text: string; data: string };
const MAX_DIGEST_ITEMS = 20;
export const BRIDGE_WINDOW_MS = 5 * 60_000;
export const MIN_BRIDGE_SECRET_LENGTH = 16;

const ID_RE = /^[\w-]{1,48}$/;

/** 120050 -> "EGP 1,200.50" (integer piastres in, no float) */
// pq-allow(unused-export): pure money formatter, pinned by its unit test (EGP 1,200.50 from piastres)
export function formatEgp(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return 'EGP ?';
  const pounds = Math.floor(amountMinor / 100);
  const piastres = String(amountMinor % 100).padStart(2, '0');
  return `EGP ${String(pounds).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${piastres}`;
}

/** merchant-supplied text goes into a plain Telegram message: strip control characters and newlines, clip */
const clean = (s: string, n = 40) => String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, n);

export function encodeTap(product: 'store' | 'chat', id: string): string {
  if (!ID_RE.test(id)) throw new Error('invalid id');
  const data = `ip:${product === 'store' ? 's' : 'c'}:${id}`;
  if (new TextEncoder().encode(data).length > 64) throw new Error('callback data over 64 bytes');
  return data;
}
export function decodeTap(data: string): { product: 'store' | 'chat'; id: string } | null {
  const m = /^ip:([sc]):([\w-]{1,48})$/.exec(String(data));
  return m ? { product: m[1] === 's' ? 'store' : 'chat', id: m[2]! } : null;
}

export function isEmptyDigest(items: DigestItem[]): boolean {
  return items.length === 0;
}

type DigestPage = { text: string; buttons: DigestButton[][] };

/** EVERY item gets a tap button: pages of at most MAX_DIGEST_ITEMS (a Telegram message holds 100 buttons, but a short message stays readable).
 *  The caller sends the pages in order as one digest. 0 items -> 0 pages. */
export function formatDigestPages(items: DigestItem[], now: number): DigestPage[] {
  const pages: DigestPage[] = [];
  const n = Math.ceil(items.length / MAX_DIGEST_ITEMS);
  for (let p = 0; p < n; p++) {
    const shown = items.slice(p * MAX_DIGEST_ITEMS, (p + 1) * MAX_DIGEST_ITEMS);
    const lines = [`InstaPay auto-confirmed payments (${new Date(now).toISOString().slice(0, 10)}): ${items.length}${n > 1 ? ` (page ${p + 1}/${n})` : ''}`, ''];
    for (const it of shown) lines.push(`- ${it.product} ${clean(it.ownerLabel)}: ${formatEgp(it.amountMinor)} (${clean(it.kind, 24)})`);
    lines.push('', 'Tap "not received" if the money did not arrive; the payment goes back to unpaid with a 48 h grace.');
    pages.push({
      text: lines.join('\n'),
      buttons: shown.map((it) => [{ text: `Not received: ${formatEgp(it.amountMinor)} ${clean(it.ownerLabel, 20)}`, data: encodeTap(it.product, it.id) }]),
    });
  }
  return pages;
}

/** The first page only (single-message callers). Use formatDigestPages to reach every payment. */
// pq-allow(unused-export): single-message API kept for callers that send one page; covered by the digest tests
export function formatDigest(items: DigestItem[], now: number): DigestPage {
  return formatDigestPages(items, now)[0] ?? { text: '', buttons: [] };
}

export function formatWaiting(item: DigestItem & { reasons: string[] }): { text: string; buttons: [] } {
  const reasons = item.reasons.map((r) => clean(r, 40)).join(', ') || 'unknown';
  return { text: `InstaPay payment waiting for you: ${item.product} ${clean(item.ownerLabel)} ${formatEgp(item.amountMinor)} (${clean(item.kind, 24)}). Reasons: ${reasons}`, buttons: [] };
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export type BridgeDirection = 'notify' | 'revert';
const isDirection = (d: unknown): d is BridgeDirection => d === 'notify' || d === 'revert';

/** HMAC-SHA256 hex over `${direction}.${ts}.${rawBody}` (ts = epoch ms). The direction label (`notify` product->brain, `revert` brain->product)
 *  keeps one secret from being reused to sign the other direction: a captured notify signature never verifies as a revert. */
export async function signBridge(secret: string, body: string, ts: number, direction: BridgeDirection): Promise<string> {
  if (typeof secret !== 'string' || secret.length < MIN_BRIDGE_SECRET_LENGTH) throw new Error('bridge secret too short');
  if (!isDirection(direction)) throw new Error('bridge direction must be notify or revert');
  return hmac(secret, `${direction}.${ts}.${body}`);
}
export async function verifyBridge(secret: string, body: string, ts: number, sig: string, now: number, direction: BridgeDirection): Promise<boolean> {
  if (typeof secret !== 'string' || secret.length < MIN_BRIDGE_SECRET_LENGTH) return false;
  if (!isDirection(direction)) return false;
  if (!Number.isFinite(ts) || !Number.isFinite(now) || Math.abs(now - ts) > BRIDGE_WINDOW_MS) return false;
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return safeEqual(await hmac(secret, `${direction}.${ts}.${body}`), sig);
}
