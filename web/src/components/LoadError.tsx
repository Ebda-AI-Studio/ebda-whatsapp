import { CircleAlert } from 'lucide-react';
import type { Strings } from '../i18n';

/** What every screen shows when a load failed: the failure in words and a way to try again (never the "nothing here yet" copy). */
export function LoadError({ t, onRetry, text }: { t: Strings; onRetry: () => void; text?: string }) {
  return (
    <div role="alert" className="state state-error">
      <CircleAlert size={20} aria-hidden />
      <p>{text ?? t.dataLoadError}</p>
      <button type="button" className="btn ghost" onClick={onRetry}>{t.retry}</button>
    </div>
  );
}
