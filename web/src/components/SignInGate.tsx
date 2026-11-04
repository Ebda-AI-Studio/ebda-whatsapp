import { useEffect, useRef } from 'react';
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
  const ar = STRINGS.ar;
  const en = STRINGS.en;
  const lock = BRAND.gate;
  const failed = kind === 'unreachable';
  return (
    <main className="gate">
      <div className="gate-card">
        <div className="gate-lockup" lang="ar" dir="rtl">
          <img src={BRAND.mark.src} alt="" width={BRAND.mark.width} height={BRAND.mark.height} />
          <span className="gate-studio">{lock?.studio.ar}</span>
          <span className="gate-studio-en" lang="en" dir="ltr">{lock?.studio.en}</span>
        </div>
        <hr className="gate-rule" />
        <h1 lang="ar" dir="rtl">{lock?.product.ar}</h1>
        <p className="gate-product-en" lang="en" dir="ltr">{lock?.product.en}</p>
        {failed ? (
          <div role="alert" className="gate-error">
            <p lang="ar" dir="rtl">{ar.gateUnreachable}</p>
            <p lang="en" dir="ltr">{en.gateUnreachable}</p>
          </div>
        ) : (
          <div className="gate-body">
            <p lang="ar" dir="rtl">{ar.gateBody}</p>
            <p lang="en" dir="ltr">{en.gateBody}</p>
          </div>
        )}
        <button ref={btn} type="button" className="btn gold gate-btn" onClick={onContinue}>
          {failed ? `${ar.gateRetry} / ${en.gateRetry}` : `${ar.gateSignIn} / ${en.gateSignIn}`}
        </button>
      </div>
    </main>
  );
}
