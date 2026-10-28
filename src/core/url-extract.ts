/**
 * Finds every link-looking token in free text and parses it with the platform URL parser, so the verdict is about the host a browser would
 * really open (userinfo, backslashes, full-width dots, IDN, integer / hex IP forms and unknown TLDs all resolve the way the browser resolves them).
 * Shared by the AI reply guard and the campaign content guard.
 */
/** `obscured`: the link only exists after normalisation (invisible characters, an encoded dot, compatibility forms): callers fail closed on it. */
export type FoundUrl = ({ host: string; scheme: string | null; ip: boolean; raw: string } | { host: null; scheme: null; ip: false; raw: string }) & { obscured: boolean };

const DOTS = /[\u3002\uff0e\uff61]/g;
// scheme?, then a run of host-ish characters with at least one dot, then an optional path. Userinfo (@) is part of the run on purpose.
const TOKEN = /(?:[a-z][a-z0-9+.-]*:(?:\/\/|\\\\|\/\\|\\\/))?[\p{L}\p{N}_@%+~:[\]-]+(?:[.\u3002\uff0e\uff61][\p{L}\p{N}_@%+~:[\]-]+)+(?:[/\\?#][^\s<>"'()]*)?|[a-z][a-z0-9+.-]*:(?:\/\/|\\\\)\S+|\[[0-9a-f:]+\]/giu;

const IPV4 = /^\d+(?:\.\d+){3}$/;
const HEXISH = /(?:^|\.)0x[0-9a-f]*(?:\.|$)/i;

/** What a person or a browser reads: NFKC (full-width forms), no format / invisible characters, percent-encoded dots decoded. */
export const normaliseForLinks = (text: string): string =>
  text.normalize('NFKC').replace(/[\p{Cf}\u00ad\u200b-\u200d\u2060\ufeff]/gu, '').replace(/%2e/gi, '.');

type Scanned = { host: string | null; scheme: string | null; ip: boolean; raw: string };

/**
 * The UNION of the links of the raw text and of its normalised form: a client (WhatsApp, a browser) may render either, so every host of
 * either form is returned and the caller checks each. A host that exists in only one form is `obscured` (the guards refuse it).
 */
export function findUrls(text: string): FoundUrl[] {
  const norm = normaliseForLinks(text);
  const raw = scan(text);
  const normed = scan(norm);
  const rawHosts = new Set(raw.map((u) => u.host));
  const normHosts = new Set(normed.map((u) => u.host));
  const seen = new Set<string>();
  const out: FoundUrl[] = [];
  for (const [list, other] of [[raw, normHosts], [normed, rawHosts]] as const) {
    for (const u of list) {
      const key = `${u.host}|${u.scheme}`;
      const differs = u.host === null ? norm !== text : !other.has(u.host);
      if (seen.has(key) && !differs) continue;
      seen.add(key);
      out.push({ ...u, obscured: differs } as FoundUrl);
    }
  }
  return out;
}

function scan(text: string): Scanned[] {
  const out: Scanned[] = [];
  for (const m of text.matchAll(TOKEN)) {
    let raw = m[0].replace(DOTS, '.').replace(/\\/g, '/').replace(/[.,;:!?؟،]+$/u, '');
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
    const scheme = schemeMatch ? schemeMatch[1]!.toLowerCase() : null;
    const rest = scheme ? raw.slice(schemeMatch![0].length) : raw;
    const authority = rest.split(/[/?#]/)[0]!;
    const hostPart = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '');
    const last = hostPart.split('.').at(-1) ?? '';
    // A schemeless token is a link only if it looks like a host: a real TLD-shaped last label, a dotted-quad, or a hex/octal-looking IP part.
    const looksLikeHost = scheme !== null || hostPart.startsWith('[') || IPV4.test(hostPart) || HEXISH.test(hostPart) || /^(?:[\p{L}][\p{L}\p{N}-]+|xn--[a-z0-9-]+)$/u.test(last) || rest.includes('/') && /\p{L}/u.test(hostPart);
    if (!looksLikeHost) continue;
    raw = scheme ? raw : `https://${raw}`;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      out.push({ host, scheme, ip: /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('['), raw: m[0] });
    } catch {
      out.push({ host: null, scheme: null, ip: false, raw: m[0] });
    }
  }
  return out;
}

/** True when `host` is `allowed` or a subdomain of it. */
export const hostUnder = (host: string, allowed: string): boolean => host === allowed || host.endsWith(`.${allowed}`);

/**
 * The parts a trust decision needs: scheme (null when the text had none), host and the path WITHOUT a trailing slash ('' = the site root). Query and fragment
 * are dropped (they never choose the destination page); the path keeps its case (an Apps Script or Drive id is case-sensitive). Null for an unparsable token.
 */
export function linkParts(u: FoundUrl): { scheme: string | null; host: string; path: string } | null {
  if (u.host === null) return null;
  try {
    const raw = u.raw.replace(DOTS, '.').replace(/\\/g, '/').replace(/[.,;:!?؟،]+$/u, '');
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return { scheme: u.scheme, host: parsed.hostname.toLowerCase(), path: parsed.pathname.replace(/\/+$/, '') };
  } catch {
    return null;
  }
}
