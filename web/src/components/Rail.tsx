import { MessagesSquare, Sparkles } from 'lucide-react';
import type { Strings } from '../i18n';

// Only sections that exist are listed: templates, campaigns and settings join the rail when their screens ship.
export type View = 'inbox' | 'agent';

export function Rail({ t, view, onNavigate, showAgent }: { t: Strings; view: View; onNavigate: (v: View) => void; showAgent: boolean }) {
  return (
    <nav className="rail" aria-label={t.nav}>
      <img className="rail-mark" src="/brand/symbol-gold.svg" alt="Ebda AI Studio" width={30} height={36} />
      <a href="#inbox" aria-current={view === 'inbox' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); onNavigate('inbox'); }}><MessagesSquare size={20} aria-hidden /><span>{t.inbox}</span></a>
      {showAgent && <a href="#agent" aria-current={view === 'agent' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); onNavigate('agent'); }}><Sparkles size={20} aria-hidden /><span>{t.agent}</span></a>}
    </nav>
  );
}
