/**
 * The sign-out button's action. The realtime socket is stopped FIRST (it would otherwise keep delivering a signed-out person's messages), then the
 * session signs out. A 'local' result (the provider has no end-session endpoint) replaces the app with the signed-out notice: no reload, because a
 * reload would sign the person straight back in through the provider's own session.
 */
export function makeSignOut(o: { stopRealtime: () => void; session: { signOut(): Promise<'redirected' | 'local'> }; onLocal: () => void }): () => void {
  return () => {
    o.stopRealtime();
    void o.session.signOut().then((r) => { if (r === 'local') o.onLocal(); });
  };
}
