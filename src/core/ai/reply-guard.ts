/**
 * The last check before a model's reply reaches a customer (iceberg F2, M-069). A reply is refused (the turn becomes a handoff to a
 * person) when it contains (1) a link the merchant never wrote or the Store never returned, (2) a price that is not a STRUCTURED price of this turn
 * (catalogue item, order total) or a price the merchant wrote with a currency, in digits or in words, (3) a refund / discount / free-delivery /
 * exchange / guarantee promise the merchant did not switch on, or (4) a recital of the rules.
 *
 * What is TRUSTED, structurally: (1) links: the EXACT URL, or the URL prefix (scheme + host + path prefix), the merchant wrote in their persona, FAQ or
 * knowledge, and the link / url string fields of the platform's own Store tools (as full links, same rule). Trust is never per host for a shared host (wa.me, instagram.com,
 * docs.google.com, script.google.com ...): a bare mention of such a host vouches only for its root. A connector's endpoint host is NEVER trusted for a
 * customer-facing link (Ruling WA-GUARD-LINK-1). (2) prices: the `price` / `total` / `amount` ... fields of the Store's JSON (not stock counts or ids) and
 * amounts the merchant wrote next to a currency. (3) promises: ONLY the policy flags in the agent settings, default off; the FAQ's wording decides nothing,
 * because "no refunds" says the word (Ruling WA-GUARD-PROMISE-1). Never trusted: anything the customer typed, and anything a connector returns (it can echo
 * what a customer typed at any point of the conversation). A link that only exists after normalisation (invisible characters, an encoded dot, full-width
 * forms) is refused. Known cost: a reply that restates a sum the model computed itself (2 x 110) is refused too; totals come from the ordering flow. A
 * sentence whose period has no space after it ("تمام.شكرا") reads as a host and is refused too: a person answers it.
 */
import { findUrls, linkParts } from '../url-extract';
import { normaliseText } from '../text-normalise';
import { wordPrices } from './number-words';

export type GuardVerdict = { ok: true } | { ok: false; reason: 'url' | 'price' | 'promise' | 'leak' };

/** What the merchant allows the agent to promise (agent settings; default all off). */
export type PromisePolicy = { refund: boolean; discount: boolean; freeDelivery: boolean; exchange: boolean; guarantee: boolean };
export const NO_PROMISES: PromisePolicy = { refund: false, discount: false, freeDelivery: false, exchange: false, guarantee: false };

const asciiDigits = (s: string): string => s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x6f0));

const CUR = '(?:egp|e\\.?g\\.?p|l\\.?e\\b|جنيه|جنية|جنيهات|ج\\.?م|جم|usd|kwd|sar|aed|\\$|ريال|دينار|درهم|دولار)';
const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
const PRICE_AFTER = new RegExp(`${NUM}\\s*${CUR}`, 'giu');
const PRICE_BEFORE = new RegExp(`${CUR}\\s*${NUM}`, 'giu');
const num = (s: string): number => Number(s.replace(/,/g, ''));

/** Every amount in `text` that sits next to a currency: digits (either side of the currency) and words. */
function pricesIn(text: string): number[] {
  const digits = asciiDigits(text);
  const out: number[] = [];
  for (const re of [PRICE_AFTER, PRICE_BEFORE]) for (const m of digits.matchAll(re)) out.push(num(m[1]!));
  return [...out, ...wordPrices(digits)];
}

/** Hosts whose pages belong to anybody: mentioning the host proves nothing about a path on it. */
const SHARED_HOSTS = new Set([
  'wa.me', 'api.whatsapp.com', 'chat.whatsapp.com', 'whatsapp.com', 'instagram.com', 'facebook.com', 'fb.com', 'fb.me', 'm.me', 'tiktok.com', 'youtube.com', 'youtu.be', 'x.com', 'twitter.com', 't.me', 'linktr.ee',
  'docs.google.com', 'drive.google.com', 'forms.gle', 'script.google.com', 'sites.google.com', 'maps.app.goo.gl', 'goo.gl', 'github.com', 'notion.site', 'wixsite.com', 'blogspot.com', 'wordpress.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com',
]);
const isShared = (host: string): boolean => [...SHARED_HOSTS].some((h) => host === h || host.endsWith(`.${h}`));

type Link = { scheme: string | null; host: string; path: string };
const linksOf = (text: string): Link[] => findUrls(asciiDigits(text)).flatMap((u) => { if (u.ip || u.obscured) return []; const p = linkParts(u); return p ? [p] : []; });

/** Is `u` (a link of the reply) covered by the trusted link `t`? Exact host; the path of `t` is a prefix at a segment boundary; a bare shared host covers only its root. */
function covers(t: Link, u: Link): boolean {
  if (u.host !== t.host) return false;
  if (u.scheme !== null && u.scheme !== 'https' && u.scheme !== 'http') return false;
  if (u.scheme === 'http' && t.scheme === 'https') return false; // never a downgrade
  if (t.path === '') return !isShared(t.host) || u.path === '';
  return u.path === t.path || u.path.startsWith(`${t.path}/`);
}

const PRICE_KEY = /^(?:price|total|subtotal|amount|shipping|shippingfee|shippingcost|fee|compareatprice|saleprice)$/i;

/** What the reply is checked against. */
export class Trusted {
  readonly text: string[] = [];
  /** Amounts of the Store's own structured price fields (catalogue items, order totals). */
  readonly prices = new Set<number>();
  /** The Store's own link / url fields as full links (scheme, host, path), matched with `covers()` like the merchant's own links (WA-GUARD-LINK-1). */
  readonly storeLinks: Link[] = [];
  policy: PromisePolicy = { ...NO_PROMISES };
  /** Free text the merchant wrote (persona, FAQ, knowledge): the links and the currency-attached amounts in it are vouched for. Promises are NOT (see `policy`). */
  addText(...t: string[]): void { this.text.push(...t); }
  setPolicy(p: PromisePolicy): void { this.policy = { ...p }; }
  /**
   * A result of the platform's OWN tools (the Store's catalogue and orders): its structured price fields and its link / url string fields. Never a
   * connector's result (Ruling WA-GUARD-CONNECTOR-1). Counts, ids and stock numbers vouch for nothing.
   */
  addStoreResult(content: string): void {
    let data: unknown;
    try { data = JSON.parse(content); } catch { return; }
    const walk = (v: unknown, key: string, depth: number): void => {
      if (depth > 6 || v === null) return;
      if (typeof v === 'number' && Number.isFinite(v)) { if (PRICE_KEY.test(key)) this.prices.add(v); return; }
      if (typeof v === 'string') { if (/^(?:link|url|href)$/i.test(key)) this.storeLinks.push(...linksOf(v)); return; }
      if (Array.isArray(v)) { for (const x of v.slice(0, 50)) walk(x, key, depth + 1); return; }
      if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 50)) walk(x, k, depth + 1);
    };
    walk(data, '', 0);
  }
}

// Normalised forms (`normaliseText`): alef/yaa/taa-marbuta folded, no punctuation.
const PROMISES: Record<keyof PromisePolicy, RegExp> = {
  refund: /\brefund|money back|reimburs|استرجاع|استرداد|ارجاع (?:الفلوس|المبلغ|فلوس)|(?:هرجع|هرد|هنرجع|هنرد|ارجع|رجع)(?:لك|لكم|ك|لك)? (?:الفلوس|فلوس|المبلغ)|رجوع الفلوس/u,
  discount: /\bdiscount|% ?off\b|percent off|\bcoupon|promo code|voucher|خصم|تخفيض|كوبون|عرض خاص|كود خصم/u,
  freeDelivery: /free (?:shipping|delivery|gift|of charge)|شحن مجاني|توصيل مجاني|شحن ببلاش|هديه مجانيه|مجانا|مجاني/u,
  exchange: /\bexchange|\bswap\b|replacement|we(?:'ll| will) replace|استبدال|تبديل|هبدل|هنبدل|بدل(?:ه|ها|ك)? ?لك/u,
  guarantee: /guarantee|warranty|ضمان|مضمون|كفاله/u,
};

/** True when `reply` repeats a run of `LEAK_WORDS` consecutive words of `secret` (the rules): the model was talked into reciting its instructions. */
const LEAK_WORDS = 8;
function leaks(reply: string, secret: string): boolean {
  const words = normaliseText(secret).split(' ').filter(Boolean);
  const said = ` ${normaliseText(reply)} `;
  for (let i = 0; i + LEAK_WORDS <= words.length; i++) if (said.includes(` ${words.slice(i, i + LEAK_WORDS).join(' ')} `)) return true;
  return false;
}

export function guardReply(reply: string, trustedIn: Trusted | string[], protectedText = ''): GuardVerdict {
  const trusted = Array.isArray(trustedIn) ? Object.assign(new Trusted(), { text: trustedIn }) : trustedIn;
  if (protectedText && leaks(reply, protectedText)) return { ok: false, reason: 'leak' };
  const trustedText = trusted.text.join('\n');
  // 1. links: every link-looking token, parsed as a browser would; an IP address or an unparsable token is never allowed
  const written = [...linksOf(trustedText), ...trusted.storeLinks];
  for (const u of findUrls(asciiDigits(reply))) {
    const parts = u.host === null || u.ip || u.obscured ? null : linkParts(u);
    if (!parts || !written.some((t) => covers(t, parts))) return { ok: false, reason: 'url' };
  }
  // 2. prices (digits and words)
  const known = new Set([...pricesIn(trustedText), ...trusted.prices]);
  for (const p of pricesIn(reply)) if (!known.has(p)) return { ok: false, reason: 'price' };
  // 3. promises: only a policy flag the merchant switched on allows one; their texts decide nothing
  const said = normaliseText(reply);
  for (const [cls, re] of Object.entries(PROMISES) as [keyof PromisePolicy, RegExp][]) if (re.test(said) && !trusted.policy[cls]) return { ok: false, reason: 'promise' };
  return { ok: true };
}
