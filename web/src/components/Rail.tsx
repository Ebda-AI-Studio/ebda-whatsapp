import { Megaphone, MessagesSquare, Sparkles, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Strings } from '../i18n';

// Only sections that exist are listed: templates and settings join the rail when their screens ship.
export type View = 'inbox' | 'campaigns' | 'contacts' | 'agent';

export function Rail({ t, view, onNavigate, show }: { t: Strings; view: View; onNavigate: (v: View) => void; show: Record<Exclude<View, 'inbox'>, boolean> }) {
  const item = (v: View, icon: ReactNode, label: string) => (
    <a href={`#${v}`} aria-current={view === v ? 'page' : undefined} onClick={(e) => { e.preventDefault(); onNavigate(v); }}>{icon}<span>{label}</span></a>
  );
  return (
    <nav className="rail" aria-label={t.nav}>
      <img className="rail-mark" src="/brand/symbol-gold.svg" alt="Ebda AI Studio" width={30} height={36} />
      {item('inbox', <MessagesSquare size={20} aria-hidden />, t.inbox)}
      {show.campaigns && item('campaigns', <Megaphone size={20} aria-hidden />, t.campaigns)}
      {show.contacts && item('contacts', <Users size={20} aria-hidden />, t.contacts)}
      {show.agent && item('agent', <Sparkles size={20} aria-hidden />, t.agent)}
    </nav>
  );
}
