import { STRINGS } from '../i18n';
import type { SignInErrorCode } from '../data/oidc';

/** Shown when the provider's answer was refused. One explicit button starts over: the page never redirects back by itself (no loop). */
export function SignInError({ code, onRetry }: { code: SignInErrorCode; onRetry: () => void }) {
  return (
    <main className="screen">
      <div className="placeholder" role="alert">
        {(['ar', 'en'] as const).map((lang) => (
          <section key={lang} lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
            <h1>{STRINGS[lang].signInFailed}</h1>
            <p>{STRINGS[lang].signInErrors[code] ?? STRINGS[lang].signInErrors.token}</p>
          </section>
        ))}
        <button type="button" className="btn" onClick={onRetry}>{STRINGS.ar.signInTryAgain} / {STRINGS.en.signInTryAgain}</button>
      </div>
    </main>
  );
}
