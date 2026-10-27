/**
 * F5: the simple content guard every campaign passes at creation. It looks at everything the merchant controls that ends up in the message
 * (the rendered text, every free-text parameter and fallback, the tracked link's destination) and refuses what gets numbers banned or customers
 * scammed: link shorteners (a shortener's host OR any subdomain of it), IP-address hosts in any spelling (the URL parser resolves integer, hex
 * and octal forms), look-alike (punycode / IDN) hosts, plain-http links, and a short list of scam / unregulated-finance phrases. It is a floor,
 * not a moderation system: Meta's own template review and the number-health guard sit behind it.
 */
import { findUrls, hostUnder } from '../url-extract';

export type ContentProblem = 'link_shortener' | 'link_ip' | 'link_not_https' | 'link_punycode' | 'link_invalid' | 'pattern';

const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'cutt.ly', 'rb.gy', 'is.gd', 'ow.ly', 'shorturl.at', 't.ly', 'tiny.cc', 'buff.ly', 'rebrand.ly', 'lnkd.in', 'v.gd', 'bl.ink'];
const PATTERNS = [
  /\bforex\b|binary options|crypto (?:signals?|investment)|\bbitcoin\b.{0,20}(?:profit|invest)|guaranteed (?:profit|returns?)|double your money|casino|betting/i,
  /فوركس|ضاعف (?:أموالك|اموالك|فلوسك)|ربح مضمون|أرباح مضمونة|ارباح مضمونه|كازينو|مراهنات|عملات رقمية.{0,20}(?:ربح|استثمار)/,
];

export function contentProblem(texts: string[]): ContentProblem | null {
  for (const t of texts) {
    for (const u of findUrls(t)) {
      if (u.host === null || u.obscured) return 'link_invalid';
      if (u.ip) return 'link_ip';
      if (SHORTENERS.some((s) => hostUnder(u.host, s))) return 'link_shortener';
      if (u.host.split('.').some((l) => l.startsWith('xn--'))) return 'link_punycode';
      if (u.scheme === 'http') return 'link_not_https';
    }
    if (PATTERNS.some((re) => re.test(t))) return 'pattern';
  }
  return null;
}
