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
import { CreateWorkspace, Invitations, NoWorkspaceYet } from './components/CreateWorkspace';
import { acceptInvitation, createWorkspace, fetchInvitations, fetchMine, isStandaloneId } from './data/workspaces';
import { connectRealtime, createApiSource, isOperator } from './data/api';
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
    // The way out of a gate screen: the SAME sign-out the rail uses (makeAccountsSignOut / makeSignOut). Accounts mode ends the shared session
    // (one POST /logout) then `after` runs: reload lands on the sign-in entry, 'use another account' goes straight to the login URL.
    let stopRealtimeNow: () => void = () => undefined;
    const gateSignOut = (after: () => void): (() => void) => () => {
      if (oidcSession) { const session = oidcSession; makeSignOut({ stopRealtime: stopRealtimeNow, session, onLocal: () => root.render(<SignedOutLocally onSignIn={() => { void session.startSignIn('/'); }} />) })(); return; }
      makeAccountsSignOut({ stopRealtime: stopRealtimeNow, accountsUrl: ACCOUNTS_URL!, getToken: tokens.getToken, reload: after })();
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
    // CHAT-SA-5: a Store id (the token's `stores`) takes today's path untouched. A `?store=sw_...` names a standalone workspace (the server checks membership on every request);
    // an identity with no Store at all asks which standalone workspaces it has, and is offered the create screen when it has none.
    const openWorkspace = (id: string) => { const u = new URL(location.href); u.searchParams.set('store', id); u.searchParams.delete('viewAs'); location.assign(u); };
    const wantedId = new URLSearchParams(location.search).get('store');
    const tokenStores = decodeStores(token);
    const pickedStore = viewAsId ?? (isStandaloneId(wantedId) ? wantedId : pickStore(tokenStores, location.search));
    // A super admin has no store membership: ask the store-independent operator endpoint and boot straight into the console (no store calls, no socket), before any workspace question.
    const operatorOnly = !pickedStore && await isOperator(location.origin, tokens.getToken);
    if (!pickedStore && !operatorOnly && tokenStores.length === 0) {
      const showMine = async (): Promise<void> => {
        let mine: Awaited<ReturnType<typeof fetchMine>>;
        try { mine = await fetchMine(location.origin, tokens.getToken); } catch { root.render(<NoWorkspaceYet failed onRetry={() => void showMine()} onSignOut={signOutNow} />); return; }
        const first = mine.items[0];
        if (first) { openWorkspace(first.id); return; }
        const create = () => root.render(<CreateWorkspace needsInvite={mine.needsInvite} onCreate={(input) => createWorkspace(location.origin, tokens.getToken, input)} onDone={openWorkspace} onSignOut={signOutNow} />);
        // A pending invitation comes first: that person has no workspace YET, but accepting is one press and creating a second one is not what they came for.
        const invites = await fetchInvitations(location.origin, tokens.getToken).catch(() => []);
        if (invites.length > 0) { root.render(<Invitations items={invites} onAccept={(id) => acceptInvitation(location.origin, tokens.getToken, id)} onAccepted={() => void showMine()} onCreate={mine.canCreate ? create : undefined} onSignOut={signOutNow} />); return; }
        if (!mine.canCreate && !mine.needsInvite) { root.render(<NoWorkspaceYet failed={false} onRetry={() => void showMine()} onSignOut={signOutNow} />); return; }
        create();
      };
      await showMine();
      return;
    }
    if (!pickedStore && !operatorOnly) {
      root.render(<NotLinked email={decodeEmail(token)} onSignOut={signOutNow} onSwitch={switchAccount} />);
      return;
    }
    const storeId = pickedStore ?? '';
    const api = createApiSource({ baseUrl: location.origin, storeId, getToken: tokens.getToken, userNames: {}, currentUserId: decodeSub(token) ?? '', ...(viewAsId ? { viewAs: { reason } } : {}) });
    // A live socket would outlive the audit of one request, so a view-as session has none (the server refuses it).
    const stopRealtime = viewAsId || operatorOnly ? () => undefined : connectRealtime({
      url: `${location.origin.replace(/^http/, 'ws')}/api/v1/stores/${storeId}/ws`,
      getToken: tokens.getToken,
      onEvent: api.emit,
      onReload: api.reload,
      fetchEvents: api.fetchEvents,
    });
    stopRealtimeNow = stopRealtime;
    if (operatorOnly) { api.role = 'super_admin'; api.operatorOnly = true; } else await api.loadCapabilities();
    if (api.noSeat) { // a member the owner has not seated (or whose seat the package no longer covers): say so, with a retry, instead of an inbox that cannot load
      stopRealtime();
      root.render(<NoSeat reason={api.noSeat} onRetry={() => location.reload()} onSignOut={signOutNow} onSwitch={switchAccount} standalone={isStandaloneId(storeId)} />);
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
