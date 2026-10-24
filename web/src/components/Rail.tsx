import { FileText, Megaphone, MessagesSquare, Settings } from 'lucide-react';
import type { Strings } from '../i18n';

export function Rail({ t, onToggleLang }: { t: Strings; onToggleLang: () => void }) {
  return (
    <nav className="rail" aria-label={t.nav}>
      <img className="rail-mark" src="/brand/symbol-gold.svg" alt="Ebda AI Studio" width={30} height={36} />
      <a href="#inbox" aria-current="page"><MessagesSquare size={20} aria-hidden /><span>{t.inbox}</span></a>
      <a href="#templates"><FileText size={20} aria-hidden /><span>{t.templates}</span></a>
      <a href="#campaigns"><Megaphone size={20} aria-hidden /><span>{t.campaigns}</span></a>
      <span className="rail-spacer" />
      <a href="#settings"><Settings size={20} aria-hidden /><span>{t.settings}</span></a>
      <button type="button" className="rail-item lang" onClick={onToggleLang}>{t.language}</button>
    </nav>
  );
}
