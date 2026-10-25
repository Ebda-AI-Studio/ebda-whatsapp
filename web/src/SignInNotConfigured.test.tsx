import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { SignInNotConfigured } from './components/SignInNotConfigured';
import { STRINGS } from './i18n';

afterEach(cleanup);

it('a build with no sign-in address says so in both languages instead of rendering nothing', () => {
  render(<SignInNotConfigured />);
  expect(screen.getByRole('alert').textContent).toContain(STRINGS.ar.signInNotConfigured);
  expect(screen.getByRole('alert').textContent).toContain(STRINGS.en.signInNotConfigured);
});
