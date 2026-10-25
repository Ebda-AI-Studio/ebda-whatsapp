import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { accountsUrlFor, chooseMode, pickStore } from './boot';
import { SignInNotConfigured } from './components/SignInNotConfigured';
import { connectRealtime, createApiSource } from './data/api';
import { createTokenProvider, decodeStores, decodeSub } from './data/auth';
import type { InboxSource } from './data/source';
import { BRAND } from '@brand';
import './styles.css';
import '@brand-tokens';

// A brand on its own identity provider has no accounts service here (accountsUrl null): its portal signs users in.
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
    if (!ACCOUNTS_URL) { root.render(<SignInNotConfigured />); return; }
    const tokens = createTokenProvider({ accountsUrl: ACCOUNTS_URL });
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
