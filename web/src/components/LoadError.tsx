import type { Strings } from '../i18n';

/** What every screen shows when a load failed: the failure in words and a way to try again (never the "nothing here yet" copy). */
export function LoadError({ t, onRetry, text }: { t: Strings; onRetry: () => void; text?: string }) {
  return <p role="alert" className="error-text">{text ?? t.dataLoadError} <button type="button" className="btn ghost" onClick={onRetry}>{t.retry}</button></p>;
}
