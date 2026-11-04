import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SignInGate } from './components/SignInGate';
import { STRINGS } from './i18n';

afterEach(cleanup);

it('signed out: the studio lockup leads into Ebda Chat, and the button goes to sign-in only when pressed', () => {
  const go = vi.fn();
  render(<SignInGate kind="signedOut" onContinue={go} />);
  const main = screen.getByRole('main');
  expect(main.textContent).toContain('ابدأ ستوديو');
  expect(main.textContent).toContain('ابدأ شات');
  expect(main.textContent).toContain('Ebda Chat');
  expect(main.textContent).not.toMatch(/Ebda Store|ابدأ ستور|إبدأ/);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(go).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: new RegExp(STRINGS.ar.gateSignIn) }));
  expect(go).toHaveBeenCalledTimes(1);
});

it('unreachable: an Egyptian-Arabic sentence in an alert with a retry, never raw service text', () => {
  const go = vi.fn();
  render(<SignInGate kind="unreachable" onContinue={go} />);
  expect(screen.getByRole('alert').textContent).toContain(STRINGS.ar.gateUnreachable);
  expect(screen.getByRole('alert').textContent).toContain(STRINGS.en.gateUnreachable);
  fireEvent.click(screen.getByRole('button'));
  expect(go).toHaveBeenCalledTimes(1);
});

it('both languages carry every gate string', () => {
  for (const k of ['gateBody', 'gateSignIn', 'gateUnreachable', 'gateRetry'] as const) {
    expect(STRINGS.ar[k], k).toBeTruthy();
    expect(STRINGS.en[k], k).toBeTruthy();
  }
});
