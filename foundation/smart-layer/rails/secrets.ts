/**
 * Input rail 1: secrets detector (plan 4 Task A2, spec 6.9 gap 19). The assistant never accepts a password, MFA secret, card number,
 * API key or one-time token: each is replaced by `[secret]` BEFORE anything else sees the text (masking, the model, storage).
 * Detection is by shape (known token prefixes, JWT, PEM, Luhn-valid card runs) and by keyword-led capture in Arabic, Franco and English.
 */
export type SecretKind = 'meta_token' | 'cf_token' | 'api_key' | 'password' | 'jwt' | 'card' | 'private_key';
const ORDER: SecretKind[] = ['meta_token', 'cf_token', 'api_key', 'password', 'jwt', 'card', 'private_key'];
type Range = { s: number; e: number; kind: SecretKind };

const SHAPES: Array<{ kind: SecretKind; re: RegExp }> = [
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { kind: 'meta_token', re: /\bEAA[A-Za-z0-9]{20,}/g },
  { kind: 'cf_token', re: /\bcf(?:ut|at|k)_[A-Za-z0-9_-]{20,}/g },
  { kind: 'api_key', re: /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9_-]{16,}|\bAIza[0-9A-Za-z_-]{30,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
];
// "cloudflare api token: <40 chars>": the value alone has no shape worth matching.
const CF_LED = /(?:cloudflare|\bcf\b)[^\n]{0,24}?token\s*[:=]\s*([A-Za-z0-9_-]{30,})/gi;

const NB = '(?<![\\p{L}\\p{N}])';
const NA = '(?![\\p{L}\\p{N}])';
// Latin keywords need a word boundary on the left; Arabic ones do not (و / ب / ل / ال attach to the word: "والباسورد", "بالباسورد").
const PASSWORD_KW = `(?:${NB}(?:password|passwd|passcode|pass|pwd|el\\s*password|el\\s*pass)|كلمة\\s*(?:ال)?(?:سر|مرور)|كلمه\\s*(?:ال)?(?:سر|مرور)|(?:ال)?باسو(?:و)?رد|الرقم\\s*السري)`;
const OTP_KW = `(?:${NB}(?:otp|verification\\s*code|el\\s*code)|كود\\s*(?:ال)?تحقق|كود\\s*التفعيل)`;
const API_KW = `(?:${NB}(?:api[\\s_-]*key|apikey|secret|token)|مفتاح\\s*(?:ال)?\\p{L}*|(?:ال)?توكن)`;
const KEYWORD = new RegExp(`(?:(?<pw>${PASSWORD_KW})|(?<otp>${OTP_KW})|(?<api>${API_KW}))${NA}`, 'giu');

/** Words that sit between a keyword and its value ("كلمة السر بتاعتي X", "password is X", "el password beta3y X"). */
const FILLER = new Set(['بتاعتي', 'بتاعي', 'بتاعتى', 'هي', 'هو', 'هيا', 'ده', 'دي', 'الجديدة', 'الجديده', 'الحالية', 'اللي', 'وصلني', 'وصلتني', 'is', 'was', 'are', 'my', 'new', 'beta3y', 'beta3ty', 'el', 'اللى', 'هى', '=', ':', 'هيه']);
const PURE_ARABIC = /^[؀-ۿ]+$/;

function passwordLike(t: string): boolean {
  if (t.length < 4 || /^[؀-ۿ]+$/.test(t)) return false;
  const digit = /[0-9٠-٩]/.test(t);
  const symbol = /[^\p{L}\p{N}]/u.test(t);
  const mixed = /[a-z]/.test(t) && /[A-Z]/.test(t);
  return digit || symbol || mixed;
}

const digitsOf = (s: string): string => s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/\D/g, '');
function luhn(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

const CARD_RUN = /(?<![0-9٠-٩])[0-9٠-٩](?:[ -]?[0-9٠-٩]){12,18}(?![0-9٠-٩])/gu;

function keywordRanges(text: string, out: Range[]): void {
  for (const m of text.matchAll(KEYWORD)) {
    const g = m.groups!;
    const kind: SecretKind = g.api ? 'api_key' : 'password';
    let i = m.index! + m[0].length;
    let sep = false;
    for (let hop = 0; hop < 5; hop++) {
      const rest = text.slice(i);
      const lead = /^[ \t]*([:=])?[ \t]*/.exec(rest)!;
      if (lead[1]) sep = true;
      i += lead[0].length;
      const tok = /^\S+/.exec(text.slice(i));
      if (!tok) break;
      const raw = tok[0];
      const t = raw.replace(/[.,،؛]+$/, '');
      if (/[:=]$/.test(t) && FILLER.has(t.slice(0, -1).toLowerCase())) { sep = true; i += raw.length; continue; } // "ده:"
      if (FILLER.has(t.toLowerCase())) { i += raw.length; continue; }
      let ok: boolean;
      if (g.otp) ok = /^[0-9٠-٩]{4,8}$/u.test(t);
      else ok = sep ? t.length >= 4 && !PURE_ARABIC.test(t) : passwordLike(t);
      if (ok) out.push({ s: i, e: i + t.length, kind: g.otp ? 'password' : kind });
      break;
    }
  }
}

export function detectSecrets(text: string): { text: string; found: SecretKind[] } {
  const ranges: Range[] = [];
  for (const { kind, re } of SHAPES) for (const m of text.matchAll(re)) ranges.push({ s: m.index!, e: m.index! + m[0].length, kind });
  for (const m of text.matchAll(CF_LED)) { const s = m.index! + m[0].length - m[1]!.length; ranges.push({ s, e: s + m[1]!.length, kind: 'cf_token' }); }
  for (const m of text.matchAll(CARD_RUN)) {
    const d = digitsOf(m[0]);
    if (d.length >= 13 && d.length <= 19 && luhn(d)) ranges.push({ s: m.index!, e: m.index! + m[0].length, kind: 'card' });
  }
  keywordRanges(text, ranges);
  if (!ranges.length) return { text, found: [] };
  ranges.sort((a, b) => a.s - b.s || b.e - a.e);
  let out = '';
  let pos = 0;
  const kinds = new Set<SecretKind>();
  for (const r of ranges) {
    if (r.s < pos) { if (r.e > pos) pos = r.e; continue; } // overlap: the earlier, wider range already covers it
    out += text.slice(pos, r.s) + '[secret]';
    pos = r.e;
    kinds.add(r.kind);
  }
  out += text.slice(pos);
  return { text: out, found: ORDER.filter((k) => kinds.has(k)) };
}
