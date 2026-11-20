import { dateTime } from '../lib/datetime';
import type { Lang, Strings } from '../i18n';

/**
 * Under a datetime-local input: the moment the browser's wall-clock value means, in Cairo time and the page's language (CHAT-QA-6).
 * The input itself is drawn by the browser in the browser's locale and cannot be restyled, so the line below it is the one reading to trust.
 */
export function CairoWhen({ t, lang, value }: { t: Strings; lang: Lang; value: string }) {
  const ms = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(ms)) return null;
  return <small className="muted cairo-when" role="status">{t.cairoWhen(dateTime(ms, lang))}</small>;
}
