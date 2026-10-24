import { MessagesSquare } from 'lucide-react';
import type { Strings } from '../i18n';

// Only sections that exist are listed: templates, campaigns and settings join the rail when their screens ship.
export function Rail({ t }: { t: Strings }) {
  return (
    <nav className="rail" aria-label={t.nav}>
      <img className="rail-mark" src="/brand/symbol-gold.svg" alt="Ebda AI Studio" width={30} height={36} />
      <a href="#inbox" aria-current="page"><MessagesSquare size={20} aria-hidden /><span>{t.inbox}</span></a>
    </nav>
  );
}
