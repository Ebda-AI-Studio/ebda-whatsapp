import { afterEach, beforeEach, expect, it } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, operatorCall, storeId as W, useApiKey } from './helpers/api';
import { chat, fund, holdOf, jobOf, pn, queueTemplate, setupBilling } from './helpers/billing';

useApiKey();
beforeEach(() => configureSessionCheck(async () => false));
afterEach(() => configureSessionCheck(null));

it('an operator funding change reaches the workspace at once: the next marketing send holds the wallet', async () => {
  const ws = W(9101);
  await setupBilling(ws, { funding: 'merchant_card' });
  await fund(ws, 1000);
  const conv = await chat(ws);
  const before = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
  expect(await holdOf(ws, before)).toMatchObject({ amount_minor: 0 }); // the merchant's card pays Meta: nothing from the wallet
  expect((await operatorCall(OP1, 'PUT', `/numbers/${pn(ws)}/funding`, { funding: 'platform_line', reason: 'platform pays' })).status).toBe(200);
  const after = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
  expect(await holdOf(ws, after)).toMatchObject({ state: 'held', amount_minor: 250 });
});
