import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SignInError } from './components/SignInError';
import type { SignInErrorCode } from './data/oidc';
import { STRINGS } from './i18n';

afterEach(cleanup);
const CODES: SignInErrorCode[] = ['denied', 'state', 'nonce', 'token', 'discovery', 'missing_id_token', 'claims'];

it('every sign-in failure has a message in both languages', () => {
  for (const c of CODES) {
    expect(STRINGS.ar.signInErrors[c], c).toBeTruthy();
    expect(STRINGS.en.signInErrors[c], c).toBeTruthy();
  }
});

it('shows the reason in Arabic and English and starts over only when the person presses the button', () => {
  const retry = vi.fn();
  render(<SignInError code="state" onRetry={retry} onSignOut={() => undefined} onSwitch={() => undefined} />);
  expect(screen.getByRole('alert').textContent).toContain(STRINGS.ar.signInErrors.state);
  expect(screen.getByRole('alert').textContent).toContain(STRINGS.en.signInErrors.state);
  expect(retry).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: new RegExp(STRINGS.ar.signInTryAgain) }));
  expect(retry).toHaveBeenCalledTimes(1);
});
