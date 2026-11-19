import { expect, it, vi } from 'vitest';
import { makeSignOut } from './signout';

it('stops the realtime socket FIRST, then signs out, and shows the signed-out screen only after a local sign-out', async () => {
  const order: string[] = [];
  const onLocal = vi.fn(() => order.push('screen'));
  const signOut = makeSignOut({ stopRealtime: () => order.push('stop'), session: { signOut: async () => { order.push('signOut'); return 'local' as const; } }, onLocal });
  signOut();
  await vi.waitFor(() => expect(onLocal).toHaveBeenCalled());
  expect(order).toEqual(['stop', 'signOut', 'screen']);
});

it('a redirect to the provider shows nothing else', async () => {
  const onLocal = vi.fn();
  const signOut = makeSignOut({ stopRealtime: () => undefined, session: { signOut: async () => 'redirected' as const }, onLocal });
  signOut();
  await Promise.resolve(); await Promise.resolve();
  expect(onLocal).not.toHaveBeenCalled();
});

it('gate-screen sign-out and use-another-account share makeAccountsSignOut: exactly one /logout POST, then the chosen landing', async () => {
  const { makeAccountsSignOut } = await import('./signout');
  const f = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  const after = vi.fn();
  makeAccountsSignOut({ stopRealtime: () => undefined, accountsUrl: 'https://accounts.ebda.app', getToken: async () => 't', fetchImpl: f as unknown as typeof fetch, reload: after })();
  await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(1));
  expect(f).toHaveBeenCalledTimes(1);
  expect(f.mock.calls[0]![0]).toBe('https://accounts.ebda.app/logout');
});
