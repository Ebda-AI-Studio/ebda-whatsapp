import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { REVERT_GRACE_MS } from '../foundation/instapay-state';

// Doc parity (plan C7): the help articles state the grace and the first-payment limit; the number is DERIVED from the foundation constant, so changing the constant fails here.
const HOURS = REVERT_GRACE_MS / 3_600_000;
const help = (lang: 'ar' | 'en') => readFileSync(new URL(`../docs/help/${lang}/09-wallet-top-ups-and-refunds.md`, import.meta.url), 'utf8');

it('the English help article names the revert grace in hours and the one-month first-payment limit', () => {
  const s = help('en');
  expect(s).toContain('wallet.instapay-auto-confirm@');
  expect(s).toContain(`**${HOURS} hours**`);
  expect(s).toMatch(/\*\*first\*\* automatic payment is limited to \*\*one month\*\*/);
});
it('the Arabic help article names the same grace and limit', () => {
  const s = help('ar');
  expect(s).toContain(`**${HOURS} ساعة**`);
  expect(s).toContain('**شهر واحد**');
  expect(s).toContain('wallet.instapay-auto-confirm@');
});
it('the money doc and the data-protection doc describe the new tables and the switches', () => {
  const billing = readFileSync(new URL('../docs/billing.md', import.meta.url), 'utf8');
  for (const w of ['instapay_auto_confirmations', 'instapay_auto_workspace', 'INSTAPAY_DEDUPE_DB', 'payment_unconfirmed_until', '/internal/instapay/auto-confirm/not-received']) expect(billing, w).toContain(w);
  expect(readFileSync(new URL('../docs/data-protection.md', import.meta.url), 'utf8')).toContain('instapay_auto_confirmations');
});
