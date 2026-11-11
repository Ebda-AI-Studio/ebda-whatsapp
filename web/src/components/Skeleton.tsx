import type { Strings } from '../i18n';

/** Which loaded row a skeleton row stands in for. Heights are measured from the loaded screens (sample build) and pinned in styles.css + test/web-motion.test.ts. */
export type SkeletonKind = 'row' | 'setting' | 'team' | 'contact' | 'campaign' | 'number' | 'package' | 'funnel' | 'wallet';

/** The one loading state for a region: grey rows that hold the loaded row height, so nothing jumps when the data lands (MOTION-1). A `screen` also holds the page header. */
export function Skeleton({ t, rows = 3, kind = 'row', label, screen = false }: { t: Strings; rows?: number; kind?: SkeletonKind; label?: string; screen?: boolean }) {
  const list = (
    <div className="skeleton" {...(screen ? {} : { role: 'status', 'aria-label': label ?? t.loadingRegion })}>
      {Array.from({ length: rows }, (_, i) => <span key={i} className="skeleton-row" data-k={kind} />)}
    </div>
  );
  return screen
    ? <main className="screen" role="status" aria-label={label ?? t.loadingRegion}><span className="skeleton-head" />{list}</main>
    : list;
}
