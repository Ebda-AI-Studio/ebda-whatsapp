import { describe, expect, it } from 'vitest';
import { walletDto } from '../src/core/api/contract';
import { STORE_PLAN_NAMES, storePlanNames } from '../src/core/billing/store-plan-names';
import { apiFor, useApiKey } from './helpers/api';
import { deliver, iso, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { workspace } from './helpers/workspace';

// CHAT-QA-13: the wallet names the plan the way the Store sells it, one name per plan; a bought Ebda Chat package is labelled as one.
useApiKey();
useStoreLink();
const W = (n: number) => `00000000-0000-4000-8000-0000000093${String(n).padStart(2, '0')}`;
const DAY = 86_400_000;
const plan = (ws: string, planCode: string, t = Date.now()) => storeEvent(ws, 'store.plan_changed', { planCode, includesWhatsApp: true, ownerUserId: 'u', effectiveAt: iso(t), status: 'active', periodEnd: iso(t + 31 * DAY) }, { occurredAt: iso(t) });
const wallet = async (ws: string) => walletDto.parse(await (await (await apiFor(ws, 'owner')).call('GET', '/wallet')).json());

describe('wallet plan naming', () => {
  it('a Store-included package shows the Store plan by the Store\'s own name (الأعمال / Business), not a raw package id', async () => {
    const ws = W(1);
    await storeWorkspace(ws);
    await deliver([plan(ws, 'business')]);
    const p = (await wallet(ws)).plan!;
    expect(p.packageId).toBe('store-included');
    expect(p.storePlan).toEqual({ code: 'business', nameAr: 'الأعمال', nameEn: 'Business' });
  });

  it('the name follows a plan change, and an unknown code is shown as the code, never a guessed name', async () => {
    const ws = W(2);
    await storeWorkspace(ws);
    const t = Date.now();
    await deliver([plan(ws, 'business', t)]);
    await deliver([plan(ws, 'growth', t + 1000)]);
    expect((await wallet(ws)).plan!.storePlan).toMatchObject({ nameEn: 'Growth', nameAr: 'النمو' });
    await deliver([plan(ws, 'zz_new', t + 2000)]);
    expect((await wallet(ws)).plan!.storePlan).toEqual({ code: 'zz_new', nameAr: 'zz_new', nameEn: 'zz_new' });
  });

  it('a package bought in Chat carries its own name and no Store plan, even when the Store has a plan on file', async () => {
    const ws = W(3);
    await storeWorkspace(ws);
    await deliver([plan(ws, 'business')]);
    await workspace(ws).applyEntitlement({ version: 99, packageId: 'pro', status: 'active', periodStart: Date.now() - 1000, periodEnd: Date.now() + DAY * 20, aiCredits: 40 });
    const p = (await wallet(ws)).plan!;
    expect(p).toMatchObject({ packageId: 'pro', packageName: 'Pro' });
    expect(p.storePlan).toBeUndefined();
  });

  it('another store\'s plan never shows here (tenant-scoped read)', async () => {
    const a = W(4);
    const b = W(5);
    await storeWorkspace(a);
    await storeWorkspace(b);
    await deliver([plan(a, 'pro')]);
    await deliver([plan(b, 'basic')]);
    expect((await wallet(a)).plan!.storePlan!.code).toBe('pro');
    expect((await wallet(b)).plan!.storePlan!.code).toBe('basic');
  });
});

describe('the Store plan names table', () => {
  it('names every plan the Store sells today, in both languages, once', () => {
    expect(Object.keys(STORE_PLAN_NAMES).sort()).toEqual(['basic', 'business', 'comped', 'founding_free', 'free', 'growth', 'pro']);
    expect(storePlanNames('business')).toEqual({ code: 'business', nameAr: 'الأعمال', nameEn: 'Business' });
    const ar = Object.values(STORE_PLAN_NAMES).map((n) => n.ar);
    expect(new Set(ar).size).toBe(ar.length);
  });
});
