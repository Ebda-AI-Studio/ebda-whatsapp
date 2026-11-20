import type { Lang } from '../i18n';

/**
 * The ONE date/time formatter per locale (CHAT-QA-6). Always Cairo time, always with the year, always a 12-hour clock with am/pm
 * (ص/م in Arabic), Latin digits in both languages. Screens must not build their own Intl.DateTimeFormat for a moment in time.
 * A missing moment (null, 0, NaN) renders a dash, never "1 Jan 1970".
 */
const ZONE = 'Africa/Cairo';
const locale = (lang: Lang) => (lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');
const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(lang: Lang, kind: 'full' | 'date'): Intl.DateTimeFormat {
  const key = `${lang}:${kind}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale(lang), kind === 'full'
      ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: ZONE }
      : { day: 'numeric', month: 'short', year: 'numeric', timeZone: ZONE });
    cache.set(key, f);
  }
  return f;
}
const valid = (at: number | null | undefined): at is number => typeof at === 'number' && Number.isFinite(at) && at > 0;

/** A moment: "Thu 1 Jan 2027, 2:00 am" / "الخميس 1 يناير 2027، 2:00 ص" (Cairo). */
export function dateTime(at: number | null | undefined, lang: Lang): string {
  return valid(at) ? fmt(lang, 'full').format(at) : '—';
}

/** A calendar day: "1 Jan 2027" / "1 يناير 2027" (Cairo). */
export function dateOnly(at: number | null | undefined, lang: Lang): string {
  return valid(at) ? fmt(lang, 'date').format(at) : '—';
}
