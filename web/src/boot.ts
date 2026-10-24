export type Mode = 'live' | 'sample';

/** Sample data exists only under the Vite dev server; a production bundle can never show it. */
export function chooseMode(env: { dev: boolean }, search: string): Mode {
  if (!env.dev) return 'live';
  return new URLSearchParams(search).get('live') === '1' ? 'live' : 'sample';
}

/** ?store= wins only when the token actually lists that store (the server checks it again). */
export function pickStore(stores: { id: string; role: 'owner' | 'staff' }[], search: string): string | null {
  const wanted = new URLSearchParams(search).get('store');
  if (wanted && stores.some((s) => s.id === wanted)) return wanted;
  return stores[0]?.id ?? null;
}
