import { clearAssistantConversations } from './data/assistant';

/**
 * The sign-out button's action. The realtime socket is stopped FIRST (it would otherwise keep delivering a signed-out person's messages), then the
 * session signs out. A 'local' result (the provider has no end-session endpoint) replaces the app with the signed-out notice: no reload, because a
 * reload would sign the person straight back in through the provider's own session.
 */
export function makeSignOut(o: { stopRealtime: () => void; session: { signOut(): Promise<'redirected' | 'local'> }; onLocal: () => void }): () => void {
  return () => {
    o.stopRealtime();
    clearAssistantConversations(); // the assistant's conversation ids belong to the person who is leaving
    void o.session.signOut().then((r) => { if (r === 'local') o.onLocal(); });
  };
}

/**
 * Sign-out for the shared accounts service (no OIDC session object): stop the socket, end the session at the accounts service (POST /logout with its cookie;
 * that revokes the session for every product), then reload, which lands on the sign-in entry. A failed call still reloads: the next token request decides.
 */
export function makeAccountsSignOut(o: { stopRealtime: () => void; accountsUrl: string; getToken: () => Promise<string>; fetchImpl?: typeof fetch; reload: () => void }): () => void {
  const f = o.fetchImpl ?? fetch;
  return () => {
    o.stopRealtime();
    clearAssistantConversations();
    void (async () => {
      try {
        const token = await o.getToken();
        await f(`${o.accountsUrl}/logout`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
      } catch { /* the reload below shows the sign-in entry if the session is gone, the app if it somehow is not */ }
      o.reload();
    })();
  };
}

/** What a gate screen needs from the session: the OIDC session when the brand uses OIDC (set BEFORE the callback is handled), else the accounts-service pieces. */
export type GateDeps = {
  stopRealtime: () => void;
  oidc: () => { signOut(): Promise<'redirected' | 'local'>; startSignIn(returnTo: string, opts?: { prompt?: 'select_account' | 'login' }): Promise<void> } | null;
  accounts: () => { accountsUrl: string; getToken: () => Promise<string>; loginUrl: () => string };
  /** OIDC sign-out with no provider end-session endpoint: the app is replaced by the signed-out notice (its button signs in again). */
  onSignedOutLocally: (signIn: () => void) => void;
  reload: () => void;
  assign: (url: string) => void;
  fetchImpl?: typeof fetch;
};

/**
 * The two ways out of a gate screen (no store, no seat, refused view-as, a refused sign-in). They are DIFFERENT actions:
 * - signOut ends the session and lands on the sign-in entry (OIDC: the signed-out notice or the provider's end-session page; accounts: reload).
 * - switchAccount ends the session and goes straight to a login that lets the person pick another account (OIDC: `prompt=select_account` when the provider
 *   has no end-session page; accounts: the login URL).
 * Both work before the sign-in finished: the OIDC session is read at click time, never the unassigned accounts `tokens`.
 */
export function makeGateActions(d: GateDeps): { signOutNow: () => void; switchAccount: () => void } {
  const accounts = (reload: () => void) => { const a = d.accounts(); return makeAccountsSignOut({ stopRealtime: d.stopRealtime, accountsUrl: a.accountsUrl, getToken: a.getToken, reload, ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}) }); };
  return {
    signOutNow: () => {
      const s = d.oidc();
      if (s) { makeSignOut({ stopRealtime: d.stopRealtime, session: s, onLocal: () => d.onSignedOutLocally(() => { void s.startSignIn('/'); }) })(); return; }
      accounts(d.reload)();
    },
    switchAccount: () => {
      const s = d.oidc();
      if (s) {
        d.stopRealtime();
        clearAssistantConversations();
        void s.signOut().then((r) => { if (r === 'local') void s.startSignIn('/', { prompt: 'select_account' }); }); // 'redirected': the provider's end-session page already shows its login
        return;
      }
      accounts(() => d.assign(d.accounts().loginUrl()))();
    },
  };
}
