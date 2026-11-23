import { STRINGS } from '../i18n';

/**
 * The way out of every gate screen (no store, no seat, a refused view-as): a person who is signed in as the wrong account must never be stuck.
 * Both are real buttons. Arabic leads in the visible label; the English stays in the accessible name.
 */
export function AccountActions({ onSignOut, onSwitch, className = 'btn ghost' }: { onSignOut: () => void; onSwitch: () => void; className?: string }) {
  const ar = STRINGS.ar;
  const en = STRINGS.en;
  return (
    <div className="account-actions" role="group" aria-label={`${ar.signOutAction} / ${en.signOutAction}`}>
      <button type="button" className={className} lang="ar" dir="rtl" aria-label={`${ar.signOutAction} / ${en.signOutAction}`} onClick={onSignOut}>{ar.signOutAction}</button>
      <button type="button" className={className} lang="ar" dir="rtl" aria-label={`${ar.useAnotherAccount} / ${en.useAnotherAccount}`} onClick={onSwitch}>{ar.useAnotherAccount}</button>
    </div>
  );
}
