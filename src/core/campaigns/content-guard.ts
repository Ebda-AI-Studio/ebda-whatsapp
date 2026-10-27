/**
 * F5: the simple content guard every campaign passes at creation. It looks at the text that will be sent (the template filled with the
 * merchant's parameters) and refuses what gets numbers banned or customers scammed: link shorteners (they hide the destination),
 * raw-IP and look-alike (punycode) hosts, plain-http links, and a short list of scam / regulated-finance phrases. It is a floor, not a
 * moderation system: Meta's own template review and the number-health guard sit behind it.
 */
export type ContentProblem = 'link_shortener' | 'link_ip' | 'link_not_https' | 'link_punycode' | 'pattern';

const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'cutt.ly', 'rb.gy', 'is.gd', 'ow.ly', 'shorturl.at', 't.ly', 'tiny.cc', 'buff.ly', 'rebrand.ly', 'lnkd.in', 'v.gd', 'bl.ink']);
const LINK = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?|(?:https?:\/\/)\d{1,3}(?:\.\d{1,3}){3}[^\s]*|\b\d{1,3}(?:\.\d{1,3}){3}(?:\/[^\s]*)?/gi;
const PATTERNS = [
  /\bforex\b|binary options|crypto (?:signals?|investment)|\bbitcoin\b.{0,20}(?:profit|invest)|guaranteed (?:profit|returns?)|double your money|casino|betting/i,
  /فوركس|ضاعف (?:أموالك|اموالك|فلوسك)|ربح مضمون|أرباح مضمونة|ارباح مضمونه|كازينو|مراهنات|عملات رقمية.{0,20}(?:ربح|استثمار)/,
];

export function contentProblem(texts: string[]): ContentProblem | null {
  for (const t of texts) {
    for (const m of t.matchAll(LINK)) {
      const raw = m[0];
      const host = raw.replace(/^https?:\/\//i, '').split(/[/:?#]/)[0]!.toLowerCase();
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return 'link_ip';
      if (SHORTENERS.has(host)) return 'link_shortener';
      if (host.split('.').some((l) => l.startsWith('xn--'))) return 'link_punycode';
      if (/^http:\/\//i.test(raw)) return 'link_not_https';
    }
    if (PATTERNS.some((re) => re.test(t))) return 'pattern';
  }
  return null;
}
