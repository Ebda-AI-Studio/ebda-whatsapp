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
