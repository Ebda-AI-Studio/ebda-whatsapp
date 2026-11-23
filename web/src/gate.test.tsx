import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SignInError } from './components/SignInError';
import { makeGateActions } from './signout';

const ACCOUNTS = { accountsUrl: 'https://accounts.ebda.app', getToken: async () => 't', loginUrl: () => 'https://accounts.ebda.app/login?return=x' };
afterEach(cleanup);
const click = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));

/** The OIDC callback-failure screen, wired exactly as boot() wires it: the OIDC session exists, the accounts pieces (and `tokens`) do NOT yet. */
function oidcFailureScreen(signOut: () => Promise<'redirected' | 'local'>) {
  const session = { signOut: vi.fn(signOut), startSignIn: vi.fn(async () => undefined) };
  const onSignedOutLocally = vi.fn();
  const accounts = vi.fn(() => { throw new TypeError("Cannot read properties of undefined (reading 'getToken')"); });
  const g = makeGateActions({ stopRealtime: () => undefined, oidc: () => session, accounts, onSignedOutLocally, reload: vi.fn(), assign: vi.fn() });
  render(<SignInError code="token" onRetry={() => undefined} onSignOut={g.signOutNow} onSwitch={g.switchAccount} />);
  return { session, onSignedOutLocally, accounts };
}

it('OIDC sign-in failure screen: "Sign out" ends the OIDC session and shows the signed-out notice, never touching the accounts path', async () => {
  const x = oidcFailureScreen(async () => 'local');
  click(/Sign out/);
  await vi.waitFor(() => expect(x.onSignedOutLocally).toHaveBeenCalledTimes(1));
  expect(x.session.signOut).toHaveBeenCalledTimes(1);
  expect(x.accounts).not.toHaveBeenCalled();
  x.onSignedOutLocally.mock.calls[0]![0](); // its sign-in button
  expect(x.session.startSignIn).toHaveBeenCalledWith('/');
});

it('OIDC sign-in failure screen: "Use another account" ends the session, then signs in with the account picker (differs from Sign out)', async () => {
  const x = oidcFailureScreen(async () => 'local');
  click(/Use another account/);
  await vi.waitFor(() => expect(x.session.startSignIn).toHaveBeenCalledWith('/', { prompt: 'select_account' }));
  expect(x.session.signOut).toHaveBeenCalledTimes(1);
  expect(x.onSignedOutLocally).not.toHaveBeenCalled();
  expect(x.accounts).not.toHaveBeenCalled();
});

it('OIDC with a provider end-session page: both buttons redirect there and do not start a second sign-in', async () => {
  const x = oidcFailureScreen(async () => 'redirected');
  click(/Use another account/);
  await vi.waitFor(() => expect(x.session.signOut).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  expect(x.session.startSignIn).not.toHaveBeenCalled();
});

it('accounts mode: Sign out reloads, Use another account goes to the login URL, each after exactly one /logout', async () => {
  const f = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  const reload = vi.fn(); const assign = vi.fn();
  const g = makeGateActions({ stopRealtime: () => undefined, oidc: () => null, accounts: () => ACCOUNTS, onSignedOutLocally: vi.fn(), reload, assign, fetchImpl: f as unknown as typeof fetch });
  g.signOutNow();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(assign).not.toHaveBeenCalled();
  g.switchAccount();
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(ACCOUNTS.loginUrl()));
  expect(f).toHaveBeenCalledTimes(2);
  expect(f.mock.calls.every((c) => c[0] === 'https://accounts.ebda.app/logout')).toBe(true);
});
