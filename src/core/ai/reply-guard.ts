/**
 * The last check before a model's reply reaches a customer (iceberg F2, M-069). A reply is refused (the turn becomes a handoff to a
 * person) when it contains (1) a link whose host the merchant never wrote or the Store never returned, (2) a price that is not in the
 * catalogue result of this turn or in the merchant's own texts, or (3) a refund / discount / free-shipping / guarantee promise of a
 * class the merchant's own texts never mention. "Trusted" = the persona, the FAQ / knowledge chunks and the tool results of THIS turn:
 * never anything the customer typed. Known cost: a reply that restates a sum the model computed itself (2 x 110) is refused too;
 * totals come from the ordering flow, not from the model.
 */
import { normaliseText } from '../text-normalise';

export type GuardVerdict = { ok: true } | { ok: false; reason: 'url' | 'price' | 'promise' | 'leak' };

const asciiDigits = (s: string): string => s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x6f0));

const TLD = 'com|net|org|io|app|co|me|ly|eg|kw|sa|ae|info|biz|xyz|link|shop|store|online|site|top|ru|cn|tk|ml|click|cc|gl|to|gd|page|dev|ws|vip|club';
const URL_RE = new RegExp(`(?:https?:\\/\\/|www\\.)[^\\s<>"'\\)\\]]+|\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLD})\\b(?:\\/[^\\s<>"'\\)\\]]*)?`, 'giu');

function hostsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of asciiDigits(text).matchAll(URL_RE)) {
    const raw = m[0].replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    const host = raw.split(/[/?#:]/)[0]!.toLowerCase().replace(/[.,;!?]+$/, '');
    if (host) out.push(host);
  }
  return out;
}
const hostAllowed = (host: string, allowed: Set<string>): boolean => [...allowed].some((a) => host === a || host.endsWith(`.${a}`));

const CUR = '(?:egp|e\\.?g\\.?p|l\\.?e\\b|جنيه|جنية|جنيهات|ج\\.?م|جم|usd|kwd|sar|aed|\\$|ريال|دينار|درهم|دولار)';
const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
const PRICE_AFTER = new RegExp(`${NUM}\\s*${CUR}`, 'giu');
const PRICE_BEFORE = new RegExp(`${CUR}\\s*${NUM}`, 'giu');
const num = (s: string): number => Number(s.replace(/,/g, ''));

function numbersOf(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of asciiDigits(text).matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) out.add(num(m[0]));
  return out;
}

// Normalised forms (`normaliseText`): alef/yaa/taa-marbuta folded, no punctuation.
const PROMISES: Record<string, RegExp> = {
  refund: /\brefund|money back|reimburs|استرجاع|استرداد|ارجاع (?:الفلوس|المبلغ|فلوس)|(?:هرجع|هرد|هنرجع|هنرد|ارجع|رجع)(?:لك|لكم|ك|لك)? (?:الفلوس|فلوس|المبلغ)|رجوع الفلوس/u,
  discount: /\bdiscount|% ?off\b|percent off|\bcoupon|promo code|voucher|خصم|تخفيض|كوبون|عرض خاص|كود خصم/u,
  free: /free (?:shipping|delivery|gift|of charge)|شحن مجاني|توصيل مجاني|شحن ببلاش|هديه مجانيه|مجانا|مجاني/u,
  guarantee: /guarantee|warranty|ضمان|مضمون|كفاله/u,
};

/** True when `reply` repeats a run of `LEAK_WORDS` consecutive words of `secret` (the system prompt): the model was talked into reciting its instructions. */
const LEAK_WORDS = 8;
function leaks(reply: string, secret: string): boolean {
  const words = normaliseText(secret).split(' ').filter(Boolean);
  const said = ` ${normaliseText(reply)} `;
  for (let i = 0; i + LEAK_WORDS <= words.length; i++) if (said.includes(` ${words.slice(i, i + LEAK_WORDS).join(' ')} `)) return true;
  return false;
}

export function guardReply(reply: string, trusted: string[], protectedText = ''): GuardVerdict {
  if (protectedText && leaks(reply, protectedText)) return { ok: false, reason: 'leak' };
  const trustedText = trusted.join('\n');
  // 1. links
  const allowedHosts = new Set(hostsOf(trustedText));
  for (const h of hostsOf(reply)) if (!hostAllowed(h, allowedHosts)) return { ok: false, reason: 'url' };
  // 2. prices
  const known = numbersOf(trustedText);
  const text = asciiDigits(reply);
  for (const re of [PRICE_AFTER, PRICE_BEFORE]) for (const m of text.matchAll(re)) if (!known.has(num(m[1]!))) return { ok: false, reason: 'price' };
  // 3. promises
  const said = normaliseText(reply);
  const configured = normaliseText(trustedText);
  for (const re of Object.values(PROMISES)) if (re.test(said) && !re.test(configured)) return { ok: false, reason: 'promise' };
  return { ok: true };
}
