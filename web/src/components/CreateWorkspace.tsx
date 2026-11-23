import { useEffect, useRef, useState } from 'react';
import { BRAND } from '@brand';
import { CREATE_WS } from '../i18n-workspace';
import type { AcceptResult, CreateResult, MyInvitation } from '../data/workspaces';

/**
 * A signed-in person with no Store and no workspace yet (CHAT-SA-5). One decision on the page: name the workspace (country is fixed, Egypt) and, while creation is
 * invite-only, the code they were sent. Same night + gold ground as the sign-in entry, one language at a time with a toggle, never a second line under every Arabic one.
 * `onCreate` answers with the contract's error codes; a success (or "you already own one") hands the id to `onDone`.
 */
export function CreateWorkspace({ needsInvite, onCreate, onDone, onSignOut }: {
  needsInvite: boolean;
  onCreate: (input: { name: string; inviteCode?: string }) => Promise<CreateResult>;
  onDone: (id: string) => void;
  onSignOut?: () => void;
}) {
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const c = CREATE_WS[lang];
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const nameBox = useRef<HTMLInputElement>(null);
  useEffect(() => { nameBox.current?.focus(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    const k = code.trim();
    if (!n) { setProblem('nameNeeded'); nameBox.current?.focus(); return; }
    if (needsInvite && !k) { setProblem('inviteNeeded'); return; }
    setBusy(true);
    setProblem(null);
    const r = await onCreate({ name: n, ...(needsInvite ? { inviteCode: k } : {}) });
    if (r.ok) { onDone(r.id); return; }
    setBusy(false);
    setProblem(r.error);
  };
  const message = problem === null ? null : problem === 'nameNeeded' ? c.nameNeeded : problem === 'inviteNeeded' ? c.inviteNeeded : c.errors[problem as keyof typeof c.errors] ?? c.errors.failed;

  return (
    <main className="gate" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <form className="gate-card gate-form" onSubmit={(e) => void submit(e)} noValidate aria-labelledby="cw-title" aria-busy={busy}>
        <div className="gate-lockup">
          <img src={BRAND.mark.src} alt="" width={BRAND.mark.width} height={BRAND.mark.height} />
          <span className="gate-studio">{BRAND.gate?.studio[lang]}</span>
        </div>
        <hr className="gate-rule" />
        <h1 id="cw-title">{c.title}</h1>
        <p className="gate-lede">{c.intro}</p>
        {message && <div role="alert" className="gate-error"><p>{message}</p></div>}
        <label className="gate-field">
          <span>{c.name}</span>
          <input ref={nameBox} value={name} maxLength={100} autoComplete="organization" placeholder={c.namePlaceholder} aria-describedby="cw-name-hint" aria-invalid={problem === 'nameNeeded' || undefined} onChange={(e) => setName(e.target.value)} />
          <small id="cw-name-hint">{c.nameHint}</small>
        </label>
        <label className="gate-field">
          <span>{c.country}</span>
          <input value={c.countryValue} readOnly aria-describedby="cw-country-hint" />
          <small id="cw-country-hint">{c.countryHint}</small>
        </label>
        {needsInvite && (
          <label className="gate-field">
            <span>{c.invite}</span>
            <input dir="ltr" value={code} autoComplete="off" autoCapitalize="off" spellCheck={false} aria-describedby="cw-invite-hint" aria-invalid={problem === 'inviteNeeded' || problem === 'invite_invalid' || problem === 'invite_required' || undefined} onChange={(e) => setCode(e.target.value)} />
            <small id="cw-invite-hint">{c.inviteHint}</small>
          </label>
        )}
        <button type="submit" className="btn gold gate-btn" disabled={busy}>{busy ? c.busy : c.submit}</button>
        <div className="gate-links">
          <button type="button" className="btn quiet gate-lang" lang={lang === 'ar' ? 'en' : 'ar'} onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{lang === 'ar' ? 'English' : 'العربية'}</button>
          {onSignOut && <button type="button" className="btn quiet gate-lang" onClick={onSignOut}>{lang === 'ar' ? 'تسجيل الخروج' : 'Sign out'}</button>}
        </div>
      </form>
    </main>
  );
}

/** Invite-only is closed and the person has no workspace: say so plainly, with the way back (sign out / another account) and a retry, never a bare text line. */
export function NoWorkspaceYet({ failed, onRetry, onSignOut }: { failed: boolean; onRetry: () => void; onSignOut?: () => void }) {
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const c = CREATE_WS[lang];
  return (
    <main className="gate" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <div className="gate-card" role={failed ? 'alert' : 'status'}>
        <div className="gate-lockup">
          <img src={BRAND.mark.src} alt="" width={BRAND.mark.width} height={BRAND.mark.height} />
          <span className="gate-studio">{BRAND.gate?.studio[lang]}</span>
        </div>
        <hr className="gate-rule" />
        <h1>{failed ? c.loadFailed : c.closedTitle}</h1>
        {!failed && <p className="gate-lede">{c.closedBody}</p>}
        {failed && <button type="button" className="btn gold gate-btn" onClick={onRetry}>{c.retry}</button>}
        <div className="gate-links">
          <button type="button" className="btn quiet gate-lang" lang={lang === 'ar' ? 'en' : 'ar'} onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{lang === 'ar' ? 'English' : 'العربية'}</button>
          {onSignOut && <button type="button" className="btn quiet gate-lang" onClick={onSignOut}>{lang === 'ar' ? 'تسجيل الخروج' : 'Sign out'}</button>}
        </div>
      </div>
    </main>
  );
}

/**
 * A person whose only way in is an invitation (CHAT-SA-4): one card per pending invitation, one action each. Shown before "create your workspace".
 * A refused accept stays on the card with its reason (expired / no seat) and a withdrawn invitation drops out of the list.
 */
export function Invitations({ items, onAccept, onAccepted, onCreate, onSignOut }: {
  items: MyInvitation[];
  onAccept: (workspaceId: string) => Promise<AcceptResult>;
  onAccepted: () => void;
  onCreate?: () => void;
  onSignOut?: () => void;
}) {
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const c = CREATE_WS[lang];
  const [list, setList] = useState(items);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; error: keyof typeof c.invErrors } | null>(null);
  const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { timeZone: 'Africa/Cairo', day: 'numeric', month: 'long', year: 'numeric' }); };
  const accept = async (id: string) => {
    if (busy) return;
    setBusy(id); setProblem(null);
    const r = await onAccept(id);
    if (r.ok) { onAccepted(); return; }
    setBusy(null);
    setProblem({ id, error: r.error });
    if (r.error === 'not_found') setList((xs) => xs.filter((x) => x.workspaceId !== id));
  };
  return (
    <main className="gate" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <section className="gate-card gate-form" aria-labelledby="inv-title">
        <div className="gate-lockup">
          <img src={BRAND.mark.src} alt="" width={BRAND.mark.width} height={BRAND.mark.height} />
          <span className="gate-studio">{BRAND.gate?.studio[lang]}</span>
        </div>
        <hr className="gate-rule" />
        <h1 id="inv-title">{c.invTitle}</h1>
        <p className="gate-lede">{c.invIntro}</p>
        {problem && <div role="alert" className="gate-error"><p>{c.invErrors[problem.error]}</p></div>}
        <ul className="inv-list">
          {list.map((i) => (
            <li key={i.workspaceId} className="inv-card">
              <b dir="auto">{i.workspaceName}</b>
              <small>{c.invExpires}: {when(i.expiresAt)}</small>
              <button type="button" className="btn gold" disabled={busy !== null} onClick={() => void accept(i.workspaceId)}>{busy === i.workspaceId ? c.invAccepting : c.invAccept}</button>
            </li>
          ))}
        </ul>
        <div className="gate-links">
          {onCreate && <button type="button" className="btn quiet gate-lang" onClick={onCreate}>{c.invCreateInstead}</button>}
          <button type="button" className="btn quiet gate-lang" lang={lang === 'ar' ? 'en' : 'ar'} onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{lang === 'ar' ? 'English' : 'العربية'}</button>
          {onSignOut && <button type="button" className="btn quiet gate-lang" onClick={onSignOut}>{lang === 'ar' ? 'تسجيل الخروج' : 'Sign out'}</button>}
        </div>
      </section>
    </main>
  );
}
