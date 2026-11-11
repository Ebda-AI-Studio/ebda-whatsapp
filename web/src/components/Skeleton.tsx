import type { Strings } from '../i18n';

/** The one loading state for a region: grey rows that hold the final height, so nothing jumps when the data lands (MOTION-1). */
export function Skeleton({ t, rows = 3, label, screen = false }: { t: Strings; rows?: number; label?: string; screen?: boolean }) {
  const body = (
    <div className="skeleton" role="status" aria-label={label ?? t.loadingRegion}>
      {Array.from({ length: rows }, (_, i) => <span key={i} className="skeleton-row" />)}
    </div>
  );
  return screen ? <main className="screen">{body}</main> : body;
}
