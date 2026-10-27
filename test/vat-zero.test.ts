import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, operatorCall, useApiKey } from './helpers/api';

useApiKey();
beforeEach(() => configureSessionCheck(async () => false)); // healthy accounts service: no session is revoked
afterEach(() => configureSessionCheck(null));

// Ruling VAT-0 (Ahmad 2026-10-26): no VAT is charged; a VAT above 0 needs a new ruling (and a code change), never an operator form.
describe('VAT-0: pricing settings cannot publish a VAT above 0', () => {
  it('a VAT above 0 is refused with vat_locked; VAT 0 still publishes', async () => {
    const body = { marginBps: 0, creditLimitMinor: 5000, fxBufferBps: 0, reason: 'vat zero check' };
    const refused = await operatorCall(OP1, 'POST', '/pricing-settings', { ...body, vatBps: 1400 });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'vat_locked' });
    expect((await operatorCall(OP1, 'POST', '/pricing-settings', { ...body, vatBps: 0 })).status).toBe(201);
  });
});
