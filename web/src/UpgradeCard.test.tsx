import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { UpgradeCard, billingUrl } from './components/UpgradeCard';

afterEach(cleanup);

it('billingUrl points at the Store admin billing page for the store', () => {
  expect(billingUrl('abc-123')).toBe('https://store.ebda.app/stores/abc-123/billing');
  expect(billingUrl(undefined)).toBeNull();
});

it('the card is a labelled note with one link action, never an alert', () => {
  render(<UpgradeCard title="باقتك وصلت" body="body" cta="رقّي الباقة" href="https://store.ebda.app/stores/s/billing" />);
  expect(screen.getByLabelText('باقتك وصلت').getAttribute('role')).toBeNull();
  const a = screen.getByRole('link', { name: 'رقّي الباقة' });
  expect(a.getAttribute('href')).toBe('https://store.ebda.app/stores/s/billing');
  expect(a.getAttribute('rel')).toContain('noopener');
});

it('without a billing page the card still explains and offers no dead link', () => {
  render(<UpgradeCard title="t" body="b" cta="go" href={null} />);
  expect(screen.queryByRole('link')).toBeNull();
});
