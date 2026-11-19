import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { accountsUrlFor, chooseMode, pickStore, signInMode, viewAsStore } from './boot';
import { STRINGS } from './i18n';
import { NotLinked } from './components/NotLinked';
import { NoSeat } from './components/NoSeat';
import { SignInError } from './components/SignInError';
import { makeAccountsSignOut, makeSignOut } from './signout';
import { AccountActions } from './components/AccountActions';
import { clearAssistantConversations } from './data/assistant';
import { SignedOutLocally } from './components/SignedOutLocally';
import { SignInNotConfigured } from './components/SignInNotConfigured';
import { connectRealtime, createApiSource } from './data/api';
import { SIGNED_OUT, createTokenProvider, decodeEmail, decodeStores, decodeSub } from './data/auth';
import { SignInGate } from './components/SignInGate';
import { CALLBACK_PATH, OidcSignInError, createOidcSession } from './data/oidc';
import type { InboxSource } from './data/source';
import { BRAND } from '@brand';
import './styles.css';
import '@brand-tokens';

// A brand on its own identity provider has no accounts service here (accountsUrl null): it signs in on that provider (Authorization Code + PKCE).
const ACCOUNTS_URL = accountsUrlFor(import.meta.env.VITE_ACCOUNTS_URL as string | undefined, BRAND.accountsUrl);
const root = createRoot(document.getElementById('root')!);

async function boot(): Promise<void> {
  let source: InboxSource;
  // `import.meta.env.DEV &&` is replaced at build time, so production bundles drop the sample module entirely.
  if (import.meta.env.DEV && chooseMode({ dev: true }, location.search) === 'sample') {
    const { createSampleSource } = await import('./data/sample');
    source = createSampleSource();
    // Preview only: `?role=super_admin` (or staff) shows what that role sees. Production bundles drop this branch with the sample module.
    const role = new URLSearchParams(location.search).get('role');
    if (role === 'super_admin' || role === 'staff' || role === 'owner') source.role = role;
  } else {
    const mode = signInMode(ACCOUNTS_URL, BRAND.oidc);
    if (mode === 'none') { root.render(<SignInNotConfigured />); return; }
    let tokens: { getToken: () => Promise<string> };
    let oidcSession: ReturnType<typeof createOidcSession> | null = null;
    let accountsTokens: ReturnType<typeof createTokenProvider> | null = null;
    // The way out of a gate screen: the SAME sign-out the rail uses (#155's makeAccountsSignOut / makeSignOut). Accounts mode ends the shared
    // session (one POST /logout) then `after` runs: reload lands on the sign-in entry, 'use another account' goes straight to the login URL.
    const gateSignOut = (after: () => void): (() => void) => () => {
      if (oidcSession) { const session = oidcSession; makeSignOut({ stopRealtime: () => undefined, session, onLocal: () => root.render(<SignedOutLocally onSignIn={() => { void session.startSignIn('/'); }} />) })(); return; }
      makeAccountsSignOut({ stopRealtime: () => undefined, accountsUrl: ACCOUNTS_URL!, getToken: tokens.getToken, reload: after })();
    };
    const signOutNow = gateSignOut(() => location.reload());
    const switchAccount = gateSignOut(() => location.assign(accountsTokens ? accountsTokens.loginUrl() : '/'));
    if (mode === 'oidc') {
      const session = createOidcSession({ oidc: BRAND.oidc!, origin: location.origin });
      if (location.pathname === CALLBACK_PATH) {
        try {
          await session.handleCallback(location.search);
        } catch (e) {
          // Show why, with one explicit retry: a refused answer never bounces back to the provider by itself.
          const code = e instanceof OidcSignInError ? e.code : 'token';
          oidcSession = session;
          root.render(<SignInError code={code} onRetry={() => { void session.startSignIn('/'); }} onSignOut={signOutNow} onSwitch={switchAccount} />);
          return;
        }
      }
      tokens = session;
      oidcSession = session;
    } else {
      // Signed out: show the brand's own sign-in entry; its button (not an automatic redirect) goes to the shared sign-in and returns here.
      tokens = accountsTokens = createTokenProvider({
        accountsUrl: ACCOUNTS_URL!,
        ...(BRAND.signInProduct ? { product: BRAND.signInProduct } : {}),
        redirect: (url) => root.render(<SignInGate kind="signedOut" onContinue={() => location.assign(url)} />),
      });
    }
    let token: string;
    try {
      token = await tokens.getToken();
    } catch (e) {
      if (e instanceof Error && e.message === SIGNED_OUT) return; // the sign-in entry is already on screen
      root.render(<SignInGate kind="unreachable" onContinue={() => location.reload()} />);
      return;
    }
    // T35: an operator opening a merchant's workspace read-only (?viewAs=1&store=<id>); the server writes an audit row for every request.
    const viewAsId = viewAsStore(location.search);
    const reason = viewAsId ? (window.prompt(STRINGS.ar.viewAsPrompt) ?? '').trim() : '';
    if (viewAsId && reason.length < 10) {
      root.render(<main className="screen"><div className="placeholder" role="alert"><p lang="ar" dir="rtl">{STRINGS.ar.viewAsNeedsReason}</p><AccountActions onSignOut={signOutNow} onSwitch={switchAccount} /></div></main>);
      return;
    }
    const storeId = viewAsId ?? pickStore(decodeStores(token), location.search);
    if (!storeId) {
      root.render(<NotLinked email={decodeEmail(token)} onSignOut={signOutNow} onSwitch={switchAccount} />);
      return;
    }
    const api = createApiSource({ baseUrl: location.origin, storeId, getToken: tokens.getToken, userNames: {}, currentUserId: decodeSub(token) ?? '', ...(viewAsId ? { viewAs: { reason } } : {}) });
    // A live socket would outlive the audit of one request, so a view-as session has none (the server refuses it).
    const stopRealtime = viewAsId ? () => undefined : connectRealtime({
      url: `${location.origin.replace(/^http/, 'ws')}/api/v1/stores/${storeId}/ws`,
      getToken: tokens.getToken,
      onEvent: api.emit,
      onReload: api.reload,
      fetchEvents: api.fetchEvents,
    });
    stopRealtimeNow = stopRealtime;
    await api.loadCapabilities();
    if (api.noSeat) { // a member the owner has not seated (or whose seat the package no longer covers): say so, with a retry, instead of an inbox that cannot load
      stopRealtime();
      root.render(<NoSeat reason={api.noSeat} onRetry={() => location.reload()} onSignOut={signOutNow} onSwitch={switchAccount} />);
      return;
    }
    if (oidcSession) {
      const session = oidcSession;
      api.signOut = makeSignOut({ stopRealtime, session, onLocal: () => root.render(<SignedOutLocally onSignIn={() => { void session.startSignIn('/'); }} />) });
    }
    else if (ACCOUNTS_URL) api.signOut = makeAccountsSignOut({ stopRealtime, accountsUrl: ACCOUNTS_URL, getToken: tokens.getToken, reload: () => location.reload() });
    // The store picker reloads Chat on the chosen store (boot reads ?store= and the server checks the token lists it).
    api.switchStore = (id) => { const u = new URL(location.href); u.searchParams.set('store', id); u.searchParams.delete('viewAs'); location.assign(u); };
    source = api;
  }
  root.render(
    <StrictMode>
      <App source={source} />
    </StrictMode>,
  );
}

void boot();
