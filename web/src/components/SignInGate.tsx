import { useEffect, useRef, useState } from 'react';
import { BRAND } from '@brand';
import { STRINGS } from '../i18n';

/**
 * The brand's own sign-in entry. The credential form lives in the shared accounts flow, so this page never takes a password: it says which
 * product the person is opening (company lockup, then the product) and the button hands them to sign-in. It never redirects by itself, so a
 * refused or unreachable service cannot loop. `unreachable` is the token service failing (not a signed-out person): a sentence, never raw text.
 */
export function SignInGate({ kind, onContinue }: { kind: 'signedOut' | 'unreachable'; onContinue: () => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => { btn.current?.focus(); }, []);
  // One language at a time, Arabic first; English is a toggle, never a second line under every Arabic one (UI audit #13 / foundation auth rule).
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const t = STRINGS[lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const lock = BRAND.gate;
  const failed = kind === 'unreachable';
  return (
    <main className="gate" lang={lang} dir={dir}>
      <div className="gate-card">
        <div className="gate-lockup">
          <img src={BRAND.mark.src} alt="" width={BRAND.mark.width} height={BRAND.mark.height} />
          <span className="gate-studio">{lock?.studio[lang]}</span>
        </div>
        <hr className="gate-rule" />
        <h1>{lock?.product[lang]}</h1>
        {failed ? (
          <div role="alert" className="gate-error"><p>{t.gateUnreachable}</p></div>
        ) : (
          <div className="gate-body"><p>{t.gateBody}</p></div>
        )}
        {/* The label follows the chosen language; the accessible name keeps both so a screen reader user in either language finds it. */}
        <button
          ref={btn}
          type="button"
          className="btn gold gate-btn"
          aria-label={failed ? `${STRINGS.ar.gateRetry} / ${STRINGS.en.gateRetry}` : `${STRINGS.ar.gateSignIn} / ${STRINGS.en.gateSignIn}`}
          onClick={onContinue}
        >
          {failed ? t.gateRetry : t.gateSignIn}
        </button>
        <button type="button" className="btn quiet gate-lang" lang={lang === 'ar' ? 'en' : 'ar'} onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
          {lang === 'ar' ? 'English' : 'العربية'}
        </button>
      </div>
    </main>
  );
}
