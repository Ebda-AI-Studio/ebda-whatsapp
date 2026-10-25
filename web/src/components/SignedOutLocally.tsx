import { STRINGS } from '../i18n';

/** Shown after a sign-out the provider could not complete (no end-session endpoint): this page forgot you, the provider may not have. */
export function SignedOutLocally({ onSignIn }: { onSignIn: () => void }) {
  return (
    <main className="screen">
      <div className="placeholder" role="status">
        <p lang="ar" dir="rtl">{STRINGS.ar.signedOutLocal}</p>
        <p lang="en" dir="ltr">{STRINGS.en.signedOutLocal}</p>
        <button type="button" className="btn primary" onClick={onSignIn}>{STRINGS.ar.signedOutSignIn} / {STRINGS.en.signedOutSignIn}</button>
      </div>
    </main>
  );
}
