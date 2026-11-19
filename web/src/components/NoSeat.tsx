import { STRINGS } from '../i18n';
import { AccountActions } from './AccountActions';

/** Shown when the server refused this person for want of a seat (WA-SEATS-1): they are a member of the store but the owner has not seated them (or the package now allows fewer). */
export function NoSeat({ reason, onRetry, onSignOut, onSwitch }: { reason: 'none' | 'over_limit'; onRetry: () => void; onSignOut: () => void; onSwitch: () => void }) {
  return (
    <main className="screen">
      <div className="placeholder" role="alert">
        <h1 lang="ar" dir="rtl">{STRINGS.ar.noSeatTitle}</h1>
        <p lang="ar" dir="rtl">{reason === 'over_limit' ? STRINGS.ar.noSeatOver : STRINGS.ar.noSeatBody}</p>
        <h2 lang="en" dir="ltr">{STRINGS.en.noSeatTitle}</h2>
        <p lang="en" dir="ltr">{reason === 'over_limit' ? STRINGS.en.noSeatOver : STRINGS.en.noSeatBody}</p>
        <button type="button" className="btn primary" onClick={onRetry}>{STRINGS.ar.noSeatRetry} / {STRINGS.en.noSeatRetry}</button>
        <AccountActions onSignOut={onSignOut} onSwitch={onSwitch} />
      </div>
    </main>
  );
}
