import type { Ref } from 'react';
import { STRINGS } from '../i18n';

/**
 * The way out of every gate screen (no store, no seat, a refused view-as): a person who is signed in as the wrong account must never be stuck.
 * Both are real buttons. Arabic leads in the visible label; the English stays in the accessible name.
 */
export function AccountActions({ onSignOut, onSwitch, className = 'btn ghost', switchFirst = false, switchClassName = className, switchRef }: { onSignOut: () => void; onSwitch: () => void; className?: string; /** 'Use another account' first (the not-linked gate, where it is the likely next step), with its own class and a ref for focus. */ switchFirst?: boolean; switchClassName?: string; switchRef?: Ref<HTMLButtonElement> }) {
  const ar = STRINGS.ar;
  const en = STRINGS.en;
  const signOutBtn = <button type="button" className={className} lang="ar" dir="rtl" aria-label={`${ar.signOutAction} / ${en.signOutAction}`} onClick={onSignOut}>{ar.signOutAction}</button>;
  const switchBtn = <button ref={switchRef} type="button" className={switchClassName} lang="ar" dir="rtl" aria-label={`${ar.useAnotherAccount} / ${en.useAnotherAccount}`} onClick={onSwitch}>{ar.useAnotherAccount}</button>;
  return (
    <div className="account-actions" role="group" aria-label={`${ar.signOutAction} / ${en.signOutAction}`}>
      {switchFirst ? switchBtn : signOutBtn}
      {switchFirst ? signOutBtn : switchBtn}
    </div>
  );
}
