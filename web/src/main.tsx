import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { accountsUrlFor, chooseMode, pickStore, signInMode } from './boot';
import { SignInError } from './components/SignInError';
import { SignInNotConfigured } from './components/SignInNotConfigured';
import { connectRealtime, createApiSource } from './data/api';
import { createTokenProvider, decodeStores, decodeSub } from './data/auth';
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
    if (mode === 'oidc') {
      const session = createOidcSession({ oidc: BRAND.oidc!, origin: location.origin });
      if (location.pathname === CALLBACK_PATH) {
        try {
          await session.handleCallback(location.search);
        } catch (e) {
          // Show why, with one explicit retry: a refused answer never bounces back to the provider by itself.
          const code = e instanceof OidcSignInError ? e.code : 'token';
          root.render(<SignInError code={code} onRetry={() => { void session.startSignIn('/'); }} />);
          return;
        }
      }
      tokens = session;
    } else {
      tokens = createTokenProvider({ accountsUrl: ACCOUNTS_URL! });
    }
    const token = await tokens.getToken(); // redirects to sign-in when signed out
    const storeId = pickStore(decodeStores(token), location.search);
    if (!storeId) {
      document.body.textContent = 'حسابك مش مربوط بأي متجر لسه. / Your account is not linked to a store yet.';
      return;
    }
    const api = createApiSource({ baseUrl: location.origin, storeId, getToken: tokens.getToken, userNames: {}, currentUserId: decodeSub(token) ?? '' });
    connectRealtime({
      url: `${location.origin.replace(/^http/, 'ws')}/api/v1/stores/${storeId}/ws`,
      getToken: tokens.getToken,
      onEvent: api.emit,
      onReload: api.reload,
      fetchEvents: api.fetchEvents,
    });
    await api.loadCapabilities();
    source = api;
  }
  root.render(
    <StrictMode>
      <App source={source} />
    </StrictMode>,
  );
}

void boot();
