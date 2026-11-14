import { FileText, LogOut, Megaphone, MessagesSquare, Bot, Phone, ShieldCheck, Sparkles, Users, UsersRound, Wallet } from 'lucide-react';
import { BRAND } from '@brand';
import type { ReactNode } from 'react';
import type { Strings } from '../i18n';

// Only sections that exist are listed: settings join the rail when their screen ships.
export type View = 'inbox' | 'campaigns' | 'templates' | 'contacts' | 'agent' | 'bot' | 'numbers' | 'wallet' | 'team' | 'operator';

export function Rail({ t, view, onNavigate, show, onSignOut }: { t: Strings; view: View; onNavigate: (v: View) => void; show: Record<Exclude<View, 'inbox'>, boolean>; onSignOut?: (() => void) | undefined }) {
  const item = (v: View, icon: ReactNode, label: string) => (
    <a href={`#${v}`} aria-current={view === v ? 'page' : undefined} onClick={(e) => { e.preventDefault(); onNavigate(v); }}>{icon}<span>{label}</span></a>
  );
  return (
    <nav className="rail" aria-label={t.nav}>
      <img className="rail-mark" src={BRAND.mark.src} alt={BRAND.mark.alt} width={BRAND.mark.width} height={BRAND.mark.height} />
      {item('inbox', <MessagesSquare size={20} aria-hidden />, t.inbox)}
      {show.templates && item('templates', <FileText size={20} aria-hidden />, t.tplNav)}
      {show.campaigns && item('campaigns', <Megaphone size={20} aria-hidden />, t.campaigns)}
      {show.contacts && item('contacts', <Users size={20} aria-hidden />, t.contacts)}
      {show.agent && item('agent', <Sparkles size={20} aria-hidden />, t.agent)}
      {show.bot && item('bot', <Bot size={20} aria-hidden />, t.botNav)}
      {show.numbers && item('numbers', <Phone size={20} aria-hidden />, t.numbersNav)}
      {show.wallet && item('wallet', <Wallet size={20} aria-hidden />, t.walletNav)}
      {show.team && item('team', <UsersRound size={20} aria-hidden />, t.teamNav)}
      {show.operator && item('operator', <ShieldCheck size={20} aria-hidden />, t.opNav)}
      {onSignOut && <button type="button" className="rail-signout" onClick={onSignOut}><LogOut size={20} aria-hidden /><span>{t.signOut}</span></button>}
    </nav>
  );
}
