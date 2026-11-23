import { CircleHelp, FileText, LogOut, Megaphone, MessagesSquare, Bot, Phone, Plug, ShieldCheck, Sparkles, Users, UsersRound, Wallet } from 'lucide-react';
import { BRAND } from '@brand';
import type { ReactNode } from 'react';
import { num, type Lang, type Strings } from '../i18n';
import type { InboxSource } from '../data/source';
import { StoreMenu } from './StoreMenu';
import { pathFor } from '../lib/route';

// Only sections that exist are listed: settings join the rail when their screen ships.
export type View = 'inbox' | 'campaigns' | 'templates' | 'contacts' | 'agent' | 'bot' | 'numbers' | 'integrations' | 'wallet' | 'team' | 'operator';

export function Rail({ t, view, onNavigate, show, onSignOut, assistant, store, status, inboxUnread = 0, lang }: { lang?: Lang; status?: ReactNode; inboxUnread?: number; t: Strings; view: View; onNavigate: (v: View) => void; show: Record<Exclude<View, 'inbox'>, boolean>; onSignOut?: (() => void) | undefined; assistant?: { open: boolean; onToggle: () => void } | undefined; store?: Pick<InboxSource, 'stores' | 'storeId' | 'switchStore' | 'signOut'> | undefined }) {
  const item = (v: View, icon: ReactNode, label: string, badge = 0) => (
    <a href={pathFor(v)} aria-current={view === v ? 'page' : undefined} aria-describedby={badge > 0 ? 'rail-unread-desc' : undefined} onClick={(e) => { e.preventDefault(); onNavigate(v); }}>{icon}<span>{label}</span>{badge > 0 && <b className="rail-badge" aria-hidden>{badge > 99 ? '99+' : num(badge, lang ?? 'ar')}</b>}</a>
  );
  return (
    <nav className="rail" aria-label={t.nav}>
      <img className="rail-mark" src={BRAND.mark.src} alt={BRAND.mark.alt} width={BRAND.mark.width} height={BRAND.mark.height} />
      {item('inbox', <MessagesSquare size={20} aria-hidden />, t.inbox, inboxUnread)}
      {inboxUnread > 0 && <span id="rail-unread-desc" className="vh">{t.hu.unreadNav(num(inboxUnread, lang ?? 'ar'))}</span>}
      {show.templates && item('templates', <FileText size={20} aria-hidden />, t.tplNav)}
      {show.campaigns && item('campaigns', <Megaphone size={20} aria-hidden />, t.campaigns)}
      {show.contacts && item('contacts', <Users size={20} aria-hidden />, t.contacts)}
      {show.agent && item('agent', <Sparkles size={20} aria-hidden />, t.agent)}
      {show.bot && item('bot', <Bot size={20} aria-hidden />, t.botNav)}
      {show.numbers && item('numbers', <Phone size={20} aria-hidden />, t.numbersNav)}
      {show.integrations && item('integrations', <Plug size={20} aria-hidden />, t.intNav)}
      {show.wallet && item('wallet', <Wallet size={20} aria-hidden />, t.walletNav)}
      {show.team && item('team', <UsersRound size={20} aria-hidden />, t.teamNav)}
      {show.operator && item('operator', <ShieldCheck size={20} aria-hidden />, t.opNav)}
      {status}
      {assistant && <button type="button" id="assistant-launcher" className="rail-assistant" aria-expanded={assistant.open} aria-controls="assistant-panel" aria-keyshortcuts="Control+J Meta+J" onClick={assistant.onToggle}><CircleHelp size={20} aria-hidden /><span>{t.assistantNav}</span></button>}
      {store?.stores && <StoreMenu t={t} source={store} />}
      {onSignOut && !store?.stores && <button type="button" className="rail-signout" onClick={onSignOut}><LogOut size={20} aria-hidden /><span>{t.signOut}</span></button>}
    </nav>
  );
}
