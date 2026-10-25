import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { SignedOutLocally } from './components/SignedOutLocally';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';

afterEach(cleanup);
const t = STRINGS.ar;

it('the rail offers sign-out only when the source can sign out, and pressing it calls it', async () => {
  const plain = createSampleSource();
  render(<App source={plain} />);
  expect(screen.queryByRole('button', { name: t.signOut })).toBeNull();
  cleanup();
  const source = createSampleSource();
  source.signOut = vi.fn();
  render(<App source={source} />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: t.signOut })));
  expect(source.signOut).toHaveBeenCalledTimes(1);
});

it('after a local-only sign-out the page says, in both languages, to sign out at the provider too, and offers to sign in again', () => {
  const again = vi.fn();
  render(<SignedOutLocally onSignIn={again} />);
  const text = screen.getByRole('status').textContent!;
  expect(text).toContain(STRINGS.ar.signedOutLocal);
  expect(text).toContain(STRINGS.en.signedOutLocal);
  fireEvent.click(screen.getByRole('button'));
  expect(again).toHaveBeenCalledTimes(1);
});
