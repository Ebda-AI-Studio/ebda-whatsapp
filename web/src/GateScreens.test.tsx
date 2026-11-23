import type React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NotLinked } from './components/NotLinked';
import { NoSeat } from './components/NoSeat';
import { SignInError } from './components/SignInError';
import { STRINGS } from './i18n';

afterEach(cleanup);

// One row per gate screen a signed-in person can be stuck on: each must offer sign-out and use-another-account as real buttons.
const GATES: [string, (o: { onSignOut: () => void; onSwitch: () => void }) => React.ReactElement][] = [
  ['NotLinked', (o) => <NotLinked email="ahmad@example.com" {...o} />],
  ['NoSeat', (o) => <NoSeat reason="none" onRetry={() => undefined} {...o} />],
  ['SignInError', (o) => <SignInError code="token" onRetry={() => undefined} {...o} />],
];

for (const [name, make] of GATES) {
  it(`${name} has a sign-out and a use-another-account button that fire`, () => {
    const onSignOut = vi.fn();
    const onSwitch = vi.fn();
    render(make({ onSignOut, onSwitch }));
    fireEvent.click(screen.getByRole('button', { name: `${STRINGS.ar.signOutAction} / ${STRINGS.en.signOutAction}` }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(onSwitch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: `${STRINGS.ar.useAnotherAccount} / ${STRINGS.en.useAnotherAccount}` }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });
}

it('NotLinked names the signed-in account masked, in both languages', () => {
  render(<NotLinked email="ahmad@example.com" onSignOut={() => undefined} onSwitch={() => undefined} />);
  expect(screen.getByTestId('signed-in-as').textContent).toContain('a***@example.com');
  expect(screen.getByTestId('signed-in-as').textContent).not.toContain('ahmad@');
  expect(screen.getByRole('alert').textContent).toContain(STRINGS.ar.notLinkedTitle);
  expect(screen.getByRole('alert').textContent).toContain(STRINGS.en.notLinkedTitle);
});

it('main.tsx renders no gate as bare body text (a dead end with no buttons)', async () => {
  const src = (await import('./main.tsx?raw')).default as string;
  expect(src).not.toMatch(/document\.body\.textContent/);
});
