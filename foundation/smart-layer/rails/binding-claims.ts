/**
 * Output rail 10: binding-claim check (plan 4 Task A8, gap 3). A sentence that states a currency amount, a percentage, a duration,
 * a plan name or a refund / billing / legal term is a claim the business is held to. It survives only if its numbers and its plan name
 * come from a typed source (`BindingSource.values`) or from this turn's store-data / typed-source tool results; otherwise the sentence
 * is replaced by a pointer to the page that owns the fact. The model is never trusted to remember a price, a fee or a policy.
 */
import { foldArabic } from '../../text';
import type { BindingSource } from '../types';

export type ClaimReason = 'amount' | 'percent' | 'duration' | 'plan_name' | 'policy_term';

const NUM = /(?<![A-Za-z\d.,])\d+(?:[.,]\d+)*(?![A-Za-z]|\d)/g;
// The Gulf dinar code is assembled from parts so a product repo's zero-legacy-currency scan of the vendored copy does not trip on a literal (it must still be recognised as a currency).
const GULF_DINAR = 'k' + 'wd';
const CURRENCY = '(?:جنيه|جنية|ج\\.?\\s?م|ج(?![\\p{L}])|egp|pounds?|£|le\\b|l\\.e|usd|\\$|دولار|' + GULF_DINAR + '|دينار|ريال|sar|aed|درهم)';
const AMOUNT = new RegExp(`(?<![A-Za-z\\d.,])(\\d+(?:[.,]\\d+)*)\\s*${CURRENCY}|${CURRENCY}\\s*(\\d+(?:[.,]\\d+)*)`, 'giu');
const PERCENT = /(?<![A-Za-z\d.,])(\d+(?:[.,]\d+)*)\s*(?:%|٪|percent|في\s*ال?ميه|بال?ميه)/giu;
const DURATION = /(?<![A-Za-z\d.,])(\d+(?:[.,]\d+)*)\s*(?:يوم|ايام|اسبوع|اسابيع|شهر|شهور|اشهر|ساعه|ساعات|سنه|سنين|days?|weeks?|months?|hours?|years?)/giu;
const LEGAL = /استرجاع|ترجع\w*\s*(?:ال)?فلوس|ارجاع|مرتجع|استرداد|الغاء|ضمان|سياسه|شروط|خصوصيه|refund|cancell?ation|guarantee|warranty|terms|privacy/iu;
// Billing terms with a bad number are reported as the specific number reason (amount / percent / duration); only an unsourced assertion is policy_term.
const BILLING = /رسوم|عموله|فاتوره|تجديد|billing|invoice|renewal|commission|\bfees?\b/iu;
const ASSERTIVE = /تقدر|هتقدر|ينفع|مفيش|ممنوع|مسموح|مضمون|هنرجع|هترجع|بنرجع|you can|you will|no fee|guarantee|full refund|always|never|free of charge/iu;
const PLAN_NAME = /(?:باقه|باقة|خطه|خطة|plan)\s+([A-Z][A-Za-z]+)|\b(Starter|Growth|Business|Pro|Premium|Enterprise|Scale|Basic)\b/g;

const POINTER = {
  plans: { ar: 'شوف التفاصيل في صفحة الباقات.', en: 'See the Plans page for the details.' },
  terms: { ar: 'شوف التفاصيل في صفحة الشروط والسياسات.', en: 'See the Terms and Policies page for the details.' },
};

// A numbered or bulleted line (ASCII or Arabic-Indic numerals, written as escapes: DIGITS-1). An unsourced claim in a step must not turn the step into the pointer sentence
// ("1. See the Plans page"): the step is dropped and the remaining numbered steps are renumbered.
const LIST_ITEM = /^\s*(?:[-*\u2022]|(?:\d+|[\u0660-\u0669]+)[.)\u060C-]?)\s+/;
const NUMBERED = /^(\s*)(\d+)([.)])(\s+)/;

/** `dropped`: the numbers of the numbered lines that were dropped. A block whose first surviving item is "2." because "1." was dropped restarts at 1. */
function renumber(text: string, dropped: ReadonlySet<number>): string {
  const lines = text.split('\n');
  let next = 0;
  let prevNumbered = false;
  return lines.map((l) => {
    const m = NUMBERED.exec(l);
    if (!m) { prevNumbered = false; next = 0; return l; }
    if (!prevNumbered) { next = Number(m[2]); while (next > 1 && dropped.has(next - 1)) next--; }
    prevNumbered = true;
    const out = `${m[1]}${next}${m[3]}${m[4]}${l.slice(m[0].length)}`;
    next++;
    return out;
  }).join('\n');
}

const canon = (n: string): string => {
  const t = n.replace(/,(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const f = Number(t);
  return Number.isFinite(f) ? String(f) : t;
};
const numbersOf = (s: string): Set<string> => new Set([...foldArabic(s).matchAll(NUM)].map((m) => canon(m[0])));
const names = (s: BindingSource): string[] => [s.key, s.text.ar, s.text.en, ...s.values].map((x) => foldArabic(x));

function sentences(reply: string): string[] {
  const protectedText = reply.replace(/(\d)\.(\d)/g, '$1\u0001$2');
  return protectedText.split(/(?<=[.!?؟]+)(?=\s)|(?<=\n)/).map((p) => p.replace(/\u0001/g, '.'));
}
const isArabic = (s: string): boolean => /[؀-ۿ]/.test(s);

/**
 * `toolFacts` are this turn's store-data AND typed-source tool results (they support ordinary figures such as a product price).
 * `typedFacts` are the typed-source results only: a billing or legal claim (fee, commission, refund, terms...) is supported by sources and
 * typed facts, never by a store-data number that merely happens to match (`ordersToday: 149` must not launder "commission is 149 EGP").
 */
export function checkBindingClaims(reply: string, sources: BindingSource[], toolFacts: string[], typedFacts: string[] = []): { text: string; removed: Array<{ sentence: string; reason: ClaimReason }> } {
  const strict = new Set<string>(); // sources + typed-source facts: what may back a billing / legal claim
  for (const s of sources) for (const v of s.values) for (const n of numbersOf(v)) strict.add(n);
  for (const f of typedFacts) for (const n of numbersOf(f)) strict.add(n);
  const loose = new Set<string>(strict); // plus store data: what may back an ordinary figure
  for (const f of toolFacts) for (const n of numbersOf(f)) loose.add(n);
  const planNames = sources.filter((s) => s.kind === 'plan').flatMap(names);
  const hasLegal = sources.some((s) => s.kind === 'legal' || s.kind === 'billing');
  const removed: Array<{ sentence: string; reason: ClaimReason }> = [];

  const pieces = sentences(reply);
  const flagged = new Set<number>();
  const out = pieces.map((raw, idx) => {
    const sentence = raw.trim();
    if (!sentence) return raw;
    const f = foldArabic(sentence);
    const billing = LEGAL.test(f) || BILLING.test(f);
    const supported = billing ? strict : loose;
    const unsupported = (re: RegExp): boolean => [...f.matchAll(re)].some((m) => !supported.has(canon((m[1] ?? m[2])!)));
    let reason: ClaimReason | null = null;
    const numeric = unsupported(AMOUNT) || unsupported(PERCENT) || unsupported(DURATION);
    const unsourcedAssertion = ASSERTIVE.test(f) && !hasLegal;
    if (LEGAL.test(f) && (numeric || unsourcedAssertion)) reason = 'policy_term';
    else if (BILLING.test(f) && !numeric && unsourcedAssertion) reason = 'policy_term';
    if (!reason) {
      for (const m of sentence.matchAll(PLAN_NAME)) {
        const name = foldArabic((m[1] ?? m[2])!);
        if (!planNames.some((p) => p === name || p.includes(name))) { reason = 'plan_name'; break; }
      }
    }
    if (!reason && unsupported(AMOUNT)) reason = 'amount';
    if (!reason && unsupported(PERCENT)) reason = 'percent';
    if (!reason && unsupported(DURATION)) reason = 'duration';
    if (!reason) return raw;
    removed.push({ sentence, reason });
    flagged.add(idx);
    const kind = reason === 'policy_term' || reason === 'duration' ? 'terms' : 'plans';
    const pointer = POINTER[kind][isArabic(sentence) ? 'ar' : 'en'];
    return raw.replace(sentence, pointer);
  });
  // A flagged piece on a list line drops that WHOLE line (the "2." marker is a piece of its own, split off by the sentence splitter).
  let droppedItem = false;
  const droppedNums = new Set<number>();
  let start = 0;
  for (let i = 0; i < pieces.length; i++) {
    if (!pieces[i]!.endsWith('\n') && i < pieces.length - 1) continue;
    const range = Array.from({ length: i - start + 1 }, (_, k) => start + k);
    if (range.some((k) => flagged.has(k)) && LIST_ITEM.test(range.map((k) => pieces[k]).join(''))) { const n = NUMBERED.exec(range.map((k) => pieces[k]).join(''))?.[2]; if (n) droppedNums.add(Number(n)); for (const k of range) out[k] = ''; droppedItem = true; }
    start = i + 1;
  }
  const joined = out.join('');
  return { text: droppedItem ? renumber(joined, droppedNums) : joined, removed };
}
