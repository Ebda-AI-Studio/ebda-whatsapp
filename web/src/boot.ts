export type Mode = 'live' | 'sample';

/** Sample data exists only under the Vite dev server; a production bundle can never show it. */
export function chooseMode(env: { dev: boolean }, search: string): Mode {
  if (!env.dev) return 'live';
  return new URLSearchParams(search).get('live') === '1' ? 'live' : 'sample';
}

/** Where sign-in lives: the build-time override, else the brand's own host; null when neither exists. */
export function accountsUrlFor(envUrl: string | undefined, brandUrl: string | null): string | null {
  return envUrl || brandUrl || null;
}

/** ?store= wins only when the token actually lists that store (the server checks it again). */
export function pickStore(stores: { id: string; role: 'owner' | 'staff' }[], search: string): string | null {
  const wanted = new URLSearchParams(search).get('store');
  if (wanted && stores.some((s) => s.id === wanted)) return wanted;
  return stores[0]?.id ?? null;
}

/** Which sign-in this build uses. A brand names exactly one: the suite's accounts service, or its own OpenID Connect provider. */
export function signInMode(accountsUrl: string | null, oidc: { issuer: string; clientId: string } | null | undefined): 'accounts' | 'oidc' | 'none' {
  if (accountsUrl && oidc) throw new Error('a brand has one sign-in: accounts service or its own OIDC provider, not both');
  return accountsUrl ? 'accounts' : oidc ? 'oidc' : 'none';
}
