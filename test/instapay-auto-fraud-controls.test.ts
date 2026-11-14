import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1DuplicateIndex, type D1Like } from '../foundation/instapay-dedupe';
import { autoConfirmInstapay } from '../src/core/billing/instapay-auto';
import { configurePayments } from '../src/core/billing/payments';
import { configureSessionCheck } from '../src/core/identity/session';
import { storeId as W0, useApiKey } from './helpers/api';
import { aiEnv, goodAnswer, nextRef, request, reqRow, seedGold, seedSub, sessionOk, setMode } from './helpers/instapay-auto';
import { testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';

// Mutation control for the cross-product duplicate case (plan S11 step 2 / C8 step 2), in a scoped test double: the shared duplicate index is replaced by one
// that Store does not share (so it knows nothing of Store's claims). The source is untouched. (The other protections live in the pure foundation decision, proved by its own vectors, and are mutation-checked
// against the real source: see the PR body.) With the real index the receipt Store already claimed waits; with the unshared double it activates, so
// `fraud: a receipt already claimed by ANOTHER PRODUCT` in test/instapay-auto-fraud.test.ts can really go red.
useApiKey();
useStoreLink();
beforeEach(async () => { await env.INSTAPAY_DEDUPE_DB!.prepare('DELETE FROM instapay_dedupe').run(); sessionOk(); configurePayments(() => testKashier()); await seedGold(); await setMode('live'); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

const privateIndex = (env as unknown as { INSTAPAY_DEDUPE_DB_PRIVATE: D1Database }).INSTAPAY_DEDUPE_DB_PRIVATE; // an index Store never writes to

describe('mutation control: duplicate index off', () => {
  it('a receipt Store already claimed activates in Chat only when the shared index is switched off', async () => {
    for (const off of [false, true]) {
      const ws = W0(9400 + (off ? 2 : 1));
      await seedSub(ws);
      const r = await request(ws, 'topup', { amountMinor: 20_000 });
      const ref = nextRef();
      await new D1DuplicateIndex(env.INSTAPAY_DEDUPE_DB as unknown as D1Like).claim({ referenceKey: ref, imageSha256: (off ? 'b' : 'a').repeat(64), product: 'store', ownerId: 'store-1', paymentId: `receipt-${off}` });
      const e = { ...aiEnv(goodAnswer(20_000, { reference: ref })), ...(off ? { INSTAPAY_DEDUPE_DB: privateIndex } : {}) } as typeof env;
      await autoConfirmInstapay(e, r.id);
      expect((await reqRow(r.id))!.state === 'confirmed', `duplicate index ${off ? 'OFF' : 'on'}`).toBe(off);
    }
  });
});
