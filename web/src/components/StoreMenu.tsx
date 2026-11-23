import { Briefcase, Store } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Strings } from '../i18n';
import type { InboxSource } from '../data/source';

/** The active store's name for display: its Chat workspace name, else a neutral word (a store with no workspace has no name here). */
export function activeStoreName(source: Pick<InboxSource, 'stores' | 'storeId'>, fallback: string): string {
  return source.stores?.find((s) => s.id === source.storeId)?.name ?? fallback;
}

/**
 * Store picker + account menu in the rail: shows the active store, lists the stores that have Chat (switching reloads Chat on that store),
 * and signs out. Opens on press, closes on Escape / outside press.
 */
export function StoreMenu({ t, source }: { t: Strings; source: Pick<InboxSource, 'stores' | 'storeId' | 'switchStore' | 'signOut' | 'standalone'> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);
  const name = activeStoreName(source, t.storeUnnamed);
  const others = (source.stores ?? []).filter((s) => s.id !== source.storeId);
  return (
    <div className="store-menu" ref={box}>
      <button type="button" className="rail-store" aria-haspopup="dialog" aria-expanded={open} aria-controls="store-menu-panel" aria-label={`${t.storeMenu}: ${name}`} onClick={() => setOpen((o) => !o)}>
        {source.standalone ? <Briefcase size={20} aria-hidden /> : <Store size={20} aria-hidden />}<span>{name}</span>
      </button>
      {open && (
        <div id="store-menu-panel" className="store-menu-panel" role="dialog" aria-label={t.storeMenu}>
          <p className="store-menu-label">{t.storeMenuCurrent}</p>
          <p className="store-menu-current" aria-current="true">{name}</p>
          <p className="store-menu-label">{t.storeMenuSwitch}</p>
          {others.length === 0 || !source.switchStore
            ? <p className="store-menu-none">{t.storeMenuNone}</p>
            : <ul>{others.map((s) => <li key={s.id}><button type="button" onClick={() => source.switchStore!(s.id)}>{s.name}</button></li>)}</ul>}
          {source.signOut && <button type="button" className="store-menu-signout" onClick={() => source.signOut!()}>{t.signOut}</button>}
        </div>
      )}
    </div>
  );
}
