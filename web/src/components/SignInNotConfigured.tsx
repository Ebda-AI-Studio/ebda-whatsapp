import { STRINGS } from '../i18n';

/** Shown when this build has no sign-in address (a brand on its own identity provider, opened without its portal): never a blank page. */
export function SignInNotConfigured() {
  return (
    <main className="screen">
      <div className="placeholder" role="alert">
        <p lang="ar" dir="rtl">{STRINGS.ar.signInNotConfigured}</p>
        <p lang="en" dir="ltr">{STRINGS.en.signInNotConfigured}</p>
      </div>
    </main>
  );
}
