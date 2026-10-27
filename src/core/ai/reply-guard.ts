/**
 * The last check before a model's reply reaches a customer (iceberg F2, M-069). A reply is refused (the turn becomes a handoff to a
 * person) when it contains (1) a link whose host the merchant never wrote or the Store never returned, (2) a price that is not in the
 * catalogue result of this turn or in the merchant's own texts, (3) a refund / discount / free-shipping / guarantee promise of a
 * class the merchant's own texts never mention, or (4) a recital of the rules.
 *
 * What is TRUSTED, structurally: the merchant's persona, FAQ and knowledge chunks (text they wrote), the domains of their configured connectors,
 * and the JSON numbers / link fields of the platform's own Store tools. Never trusted: anything the customer typed, and anything a connector
 * returns (it can echo what a customer typed at any point of the conversation). A link that only exists after normalisation (invisible
 * characters, an encoded dot, full-width forms) is refused. Known cost: a reply that restates a sum the model computed itself (2 x 110) is refused too; totals come from the
 * ordering flow. A sentence whose period has no space after it ("تمام.شكرا") reads as a host and is refused too: a person answers it.
 */
import { findUrls, hostUnder } from '../url-extract';
import { normaliseText } from '../text-normalise';

export type GuardVerdict = { ok: true } | { ok: false; reason: 'url' | 'price' | 'promise' | 'leak' };

const asciiDigits = (s: string): string => s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x6f0));

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
const hostsOf = (text: string): string[] => findUrls(asciiDigits(text)).flatMap((u) => (u.host && !u.ip && !u.obscured ? [u.host] : []));

/** What the reply is checked against. */
export class Trusted {
  readonly text: string[] = [];
  readonly numbers = new Set<number>();
  readonly hosts = new Set<string>();
  /** Free text the merchant wrote (persona, FAQ, knowledge): numbers, link hosts and promise classes in it are all vouched for. */
  addText(...t: string[]): void { this.text.push(...t); }
  /** Hosts the merchant configured (a connector's own base domain). */
  addHosts(hosts: string[]): void { for (const h of hosts) this.hosts.add(h.toLowerCase()); }
  /**
   * A result of the platform's OWN tools (the Store's catalogue and orders): its JSON numbers and its link / url string fields.
   * Never a connector's result: a connector can echo what a customer typed, at any point of the conversation, so connector output
   * vouches for nothing (Ruling WA-GUARD-CONNECTOR-1). The structural rule replaces any "does the customer's text contain it" heuristic.
   */
  addStoreResult(content: string): void {
    let data: unknown;
    try { data = JSON.parse(content); } catch { return; }
    const walk = (v: unknown, key: string, depth: number): void => {
      if (depth > 6 || v === null) return;
      if (typeof v === 'number' && Number.isFinite(v)) { this.numbers.add(v); return; }
      if (typeof v === 'string') { if (/^(?:link|url|href)$/i.test(key)) for (const h of hostsOf(v)) this.hosts.add(h); return; }
      if (Array.isArray(v)) { for (const x of v.slice(0, 50)) walk(x, key, depth + 1); return; }
      if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 50)) walk(x, k, depth + 1);
    };
    walk(data, '', 0);
  }
}

// Normalised forms (`normaliseText`): alef/yaa/taa-marbuta folded, no punctuation.
const PROMISES: Record<string, RegExp> = {
  refund: /\brefund|money back|reimburs|استرجاع|استرداد|ارجاع (?:الفلوس|المبلغ|فلوس)|(?:هرجع|هرد|هنرجع|هنرد|ارجع|رجع)(?:لك|لكم|ك|لك)? (?:الفلوس|فلوس|المبلغ)|رجوع الفلوس/u,
  discount: /\bdiscount|% ?off\b|percent off|\bcoupon|promo code|voucher|خصم|تخفيض|كوبون|عرض خاص|كود خصم/u,
  free: /free (?:shipping|delivery|gift|of charge)|شحن مجاني|توصيل مجاني|شحن ببلاش|هديه مجانيه|مجانا|مجاني/u,
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
  const allowedHosts = new Set([...hostsOf(trustedText), ...trusted.hosts]);
  for (const u of findUrls(asciiDigits(reply))) {
    if (u.host === null || u.ip || u.obscured || ![...allowedHosts].some((a) => hostUnder(u.host, a))) return { ok: false, reason: 'url' };
  }
  // 2. prices
  const known = new Set([...numbersOf(trustedText), ...trusted.numbers]);
  const text = asciiDigits(reply);
  for (const re of [PRICE_AFTER, PRICE_BEFORE]) for (const m of text.matchAll(re)) if (!known.has(num(m[1]!))) return { ok: false, reason: 'price' };
  // 3. promises: only the merchant's own texts can configure one
  const said = normaliseText(reply);
  const configured = normaliseText(trustedText);
  for (const re of Object.values(PROMISES)) if (re.test(said) && !re.test(configured)) return { ok: false, reason: 'promise' };
  return { ok: true };
}
