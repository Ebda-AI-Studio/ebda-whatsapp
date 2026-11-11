import type { ReactNode } from 'react';

/** The one empty state: an icon, what is missing in a few words, then one sentence that says what to do next. */
export function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="state" role="status">
      <span className="state-icon" aria-hidden>{icon}</span>
      <p className="state-title">{title}</p>
      <p className="state-body">{body}</p>
    </div>
  );
}
