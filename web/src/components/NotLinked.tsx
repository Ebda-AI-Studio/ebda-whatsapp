import { useEffect, useRef } from 'react';
import { BRAND } from '@brand';
import { STRINGS } from '../i18n';
import { maskEmail } from '../data/auth';

/** Shown when the signed-in account belongs to no store: says which account is signed in (masked) so a wrong-account person sees why, and offers the way out. */
export function NotLinked({ email, onSignOut, onSwitch }: { email: string | null; onSignOut: () => void; onSwitch: () => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const ar = STRINGS.ar;
  const en = STRINGS.en;
  const lock = BRAND.gate;
  return (
    <main className="gate">
      <div className="gate-card" role="alert">
        <div className="gate-lockup" lang="ar" dir="rtl">
          <img src={BRAND.mark.src} alt="" width={BRAND.mark.width} height={BRAND.mark.height} />
          <span className="gate-studio">{lock?.studio.ar}</span>
          <span className="gate-studio-en" lang="en" dir="ltr">{lock?.studio.en}</span>
        </div>
        <hr className="gate-rule" />
        <h1 lang="ar" dir="rtl">{ar.notLinkedTitle}</h1>
        <p className="gate-product-en" lang="en" dir="ltr">{en.notLinkedTitle}</p>
        <div className="gate-body">
          <p lang="ar" dir="rtl">{ar.notLinkedBody}</p>
          <p lang="en" dir="ltr">{en.notLinkedBody}</p>
          {email && (
            <p className="gate-account" data-testid="signed-in-as">
              <span lang="ar" dir="rtl">{ar.notLinkedSignedInAs}</span> <bdi dir="ltr">{maskEmail(email)}</bdi>
              <span lang="en" dir="ltr" className="gate-account-en"> ({en.notLinkedSignedInAs})</span>
            </p>
          )}
        </div>
        <div className="account-actions" role="group" aria-label={`${ar.signOutAction} / ${en.signOutAction}`}>
          <button ref={first} type="button" className="btn gold gate-btn" lang="ar" dir="rtl" aria-label={`${ar.useAnotherAccount} / ${en.useAnotherAccount}`} onClick={onSwitch}>{ar.useAnotherAccount}</button>
          <button type="button" className="btn ghost gate-btn" lang="ar" dir="rtl" aria-label={`${ar.signOutAction} / ${en.signOutAction}`} onClick={onSignOut}>{ar.signOutAction}</button>
        </div>
      </div>
    </main>
  );
}
