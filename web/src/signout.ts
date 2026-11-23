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
