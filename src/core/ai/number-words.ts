/**
 * Prices written in WORDS ("fifty pounds", "مية وخمسين جنيه", "ألفين وخمسمية جنيه"), up to the thousands, in English and Arabic (Egyptian forms included).
 * The reply guard compares them with the prices it trusts, so a model cannot slip a made-up price past a digits-only check. Input is `normaliseText`-ed
 * first (case, alef/yaa/taa-marbuta folded, punctuation and hyphens become spaces).
 */
import { normaliseText } from '../text-normalise';

const EN_UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const AR_UNITS: Record<string, number> = {
  واحد: 1, اتنين: 2, اثنين: 2, ثنين: 2, تلاته: 3, ثلاثه: 3, تلات: 3, ثلاث: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5, سته: 6, ست: 6, سبعه: 7, سبع: 7, تمانيه: 8, ثمانيه: 8, تمان: 8, ثمان: 8, تسعه: 9, تسع: 9, عشره: 10, عشر: 10,
  احداشر: 11, حداشر: 11, اطناشر: 12, اثناعشر: 12, تلتاشر: 13, تلاتاشر: 13, اربعتاشر: 14, خمستاشر: 15, ستاشر: 16, سبعتاشر: 17, تمنتاشر: 18, تسعتاشر: 19,
  عشرين: 20, ثلاثين: 30, تلاتين: 30, اربعين: 40, خمسين: 50, ستين: 60, سبعين: 70, ثمانين: 80, تمانين: 80, تسعين: 90,
};
const AR_HUNDREDS: Record<string, number> = {
  ميه: 100, مايه: 100, مئه: 100, مائه: 100, ميتين: 200, مئتين: 200, مائتين: 200,
  ثلاثميه: 300, تلتميه: 300, تلاتميه: 300, ثلاثمائه: 300, اربعميه: 400, ربعميه: 400, اربعمائه: 400, خمسميه: 500, خمسمائه: 500, ستميه: 600, ستمائه: 600, سبعميه: 700, سبعمائه: 700,
  ثمانميه: 800, تمنميه: 800, تمانميه: 800, ثمانمائه: 800, تسعميه: 900, تسعمائه: 900,
};
const AR_THOUSAND_COUNT = new Set(['الاف', 'تلاف', 'الف']); // "3 thousands": a count before it multiplies; "الف" alone is 1000
const AR_THOUSANDS: Record<string, number> = { الفين: 2000, الفان: 2000 };
const CURRENCY = new Set(['egp', 'pound', 'pounds', 'le', 'usd', 'dollar', 'dollars', 'kwd', 'sar', 'aed', 'dinar', 'dinars', 'riyal', 'riyals', 'dirham', 'dirhams', 'جنيه', 'جنيها', 'جنيهات', 'جم', 'ريال', 'دينار', 'درهم', 'دولار']);

/** Value of one token inside a number phrase, or null when the token is not part of one. */
type Step = { add?: number; times?: number; thousands?: true; connector?: true };
function stepOf(tok: string): Step | null {
  if (tok === 'and' || tok === 'و') return { connector: true };
  if (tok in EN_UNITS) return { add: EN_UNITS[tok]! };
  if (tok === 'hundred') return { times: 100 };
  if (tok === 'thousand') return { thousands: true };
  if (tok in AR_UNITS) return { add: AR_UNITS[tok]! };
  if (tok in AR_HUNDREDS) return { add: AR_HUNDREDS[tok]! };
  if (tok in AR_THOUSANDS) return { add: AR_THOUSANDS[tok]! * 1 };
  if (AR_THOUSAND_COUNT.has(tok)) return { thousands: true };
  if (tok.length > 2 && tok.startsWith('و')) { const rest = stepOf(tok.slice(1)); if (rest && !rest.connector) return rest; } // "وخمسين"
  return null;
}

/** The value of the phrase, or null when it has no number in it. */
function valueOf(steps: Step[]): number | null {
  let total = 0;
  let cur = 0;
  let any = false;
  for (const st of steps) {
    if (st.connector) continue;
    any = true;
    if (st.add !== undefined) cur += st.add;
    else if (st.times) cur = (cur || 1) * st.times;
    else if (st.thousands) { total += (cur || 1) * 1000; cur = 0; }
  }
  return any ? total + cur : null;
}

/** Every amount written in words that is directly followed by a currency word. */
export function wordPrices(text: string): number[] {
  const toks = normaliseText(text).split(' ').filter(Boolean);
  const out: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (!CURRENCY.has(toks[i]!)) continue;
    let j = i - 1;
    const steps: Step[] = [];
    while (j >= 0) {
      const st = stepOf(toks[j]!);
      if (!st) break;
      steps.unshift(st);
      j--;
    }
    while (steps[0]?.connector) steps.shift(); // a leading "and" belongs to the sentence
    const v = valueOf(steps);
    if (v !== null) out.push(v);
  }
  return out;
}
