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
  expect(main.textContent).not.toContain('Ebda Chat'); // Arabic first; English only after the toggle
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
  expect(screen.getByRole('alert').textContent).not.toContain(STRINGS.en.gateUnreachable); // one language at a time
  fireEvent.click(screen.getByRole('button', { name: new RegExp(STRINGS.ar.gateRetry) }));
  expect(go).toHaveBeenCalledTimes(1);
});

it('both languages carry every gate string', () => {
  for (const k of ['gateBody', 'gateSignIn', 'gateUnreachable', 'gateRetry'] as const) {
    expect(STRINGS.ar[k], k).toBeTruthy();
    expect(STRINGS.en[k], k).toBeTruthy();
  }
});

it('the button reads Arabic only (no Latin string inside it); English stays in the accessible name', () => {
  render(<SignInGate kind="signedOut" onContinue={() => {}} />);
  const b = screen.getByRole('button', { name: new RegExp(STRINGS.ar.gateSignIn) });
  expect(b.textContent).toBe(STRINGS.ar.gateSignIn);
  expect(b.getAttribute('aria-label')).toContain(STRINGS.en.gateSignIn);
});

it('one language at a time: Arabic leads with no English line under it, and the toggle switches the whole card', () => {
  render(<SignInGate kind="signedOut" onContinue={() => {}} />);
  const main = screen.getByRole('main');
  expect(main.getAttribute('dir')).toBe('rtl');
  expect(main.textContent).not.toContain(STRINGS.en.gateBody);
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  expect(main.getAttribute('dir')).toBe('ltr');
  expect(main.textContent).toContain(STRINGS.en.gateBody);
  expect(main.textContent).not.toContain(STRINGS.ar.gateBody);
  expect(screen.getByRole('button', { name: /Sign in/ }).textContent).toBe(STRINGS.en.gateSignIn);
});

it('after the toggle the studio lockup reads in English too', () => {
  render(<SignInGate kind="signedOut" onContinue={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  expect(screen.getByRole('main').textContent).toContain('Ebda Chat');
});
