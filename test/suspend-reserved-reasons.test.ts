import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { clearIntegrationCache } from '../src/core/identity/integration';
import { OP1, operatorCall, storeId as W, useApiKey } from './helpers/api';
import { setupBilling } from './helpers/billing';
import { workspace } from './helpers/workspace';

// An operator reason is free text, but these values name DERIVED holds the mirror may clear or overwrite: they are refused at input (400, nothing written).
useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); clearIntegrationCache(); });
afterEach(() => configureSessionCheck(null));

const d1 = (ws: string) => env.DB.prepare('SELECT suspended_at, suspended_reason FROM workspaces WHERE id = ?').bind(ws).first();
const audits = (ws: string) => env.DB.prepare('SELECT count(*) AS n FROM operator_actions WHERE workspace_id = ?').bind(ws).first<{ n: number }>().then((r) => r!.n);

describe('reserved suspension reasons', () => {
  it.each(['wallet_debt', ' Store_Suspended ', 'STORE_DELETED', 'offboarding', 'Operator'])('"%s" is refused: 400, no D1 or workspace change, no audit row', async (reason) => {
    const ws = W(1400 + Math.floor(Math.random() * 1000));
    await setupBilling(ws);
    const r = await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'invalid_request', message: 'reserved_reason' });
    expect(await d1(ws)).toEqual({ suspended_at: null, suspended_reason: null });
    expect(await workspace(ws).suspended()).toBe(false);
    expect(await audits(ws)).toBe(0);
  });

  it('a normal reason still works', async () => {
    const ws = W(2500);
    await setupBilling(ws);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: 'abuse report 2026-11-16' })).status).toBe(200);
    expect(await d1(ws)).toMatchObject({ suspended_reason: 'abuse report 2026-11-16' });
  });
});
