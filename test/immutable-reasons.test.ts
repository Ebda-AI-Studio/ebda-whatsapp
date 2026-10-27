import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { own } from './helpers/workspace';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });
const ws = W0(3300);
const PHONE = '01001234567';
const R = (what: string) => `${what}: customer ${PHONE} asked by phone`;
const all = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).all<T>().then((r) => r.results);
const IMMUTABLE = ['operator_actions', 'billing_audit', 'instapay_releases', 'pricing_settings', 'workspace_pricing_overrides', 'offboarding_log', 'audit_log', 'ledger_mirror'];

describe('AUDIT-REASONS-1, the whole class: no append-only table holds an operator\'s typed text', () => {
  it('an operator action and a billing adjustment (and pricing publishes) with a phone number in the reason leave it only in audit_reasons; the operator views still show it', async () => {
    await own(ws);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: R('abuse report') })).status).toBe(200);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/adjustments`, { amountMinor: 500, reason: R('goodwill credit') })).status).toBe(201);
    expect((await operatorCall(OP1, 'POST', '/pricing-settings', { marginBps: 100, creditLimitMinor: 5000, fxBufferBps: 0, vatBps: 0, reason: R('margin review') })).status).toBe(201);
    expect((await operatorCall(OP1, 'POST', `/pricing-overrides/${ws}`, { marginBps: 50, reason: R('deal') })).status).toBe(201);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/unsuspend`, { reason: R('case closed') })).status).toBe(200);

    for (const t of IMMUTABLE) expect(JSON.stringify(await all(`SELECT * FROM ${t}`)), t).not.toContain(PHONE);
    // the legacy column carries the constant, and the row points at the text
    expect(await all("SELECT reason, reason_id IS NOT NULL AS linked FROM operator_actions WHERE workspace_id = ?", ws)).toEqual([{ reason: 'see reason_id', linked: 1 }, { reason: 'see reason_id', linked: 1 }]);
    const billing = await all<{ action: string; reason: string | null; linked: number }>("SELECT action, reason, reason_id IS NOT NULL AS linked FROM billing_audit WHERE action IN ('adjustment_applied', 'adjustment_requested', 'pricing_settings_published', 'pricing_override_published')");
    expect(billing.length).toBeGreaterThanOrEqual(3);
    for (const b of billing) expect(b, b.action).toMatchObject({ reason: null, linked: 1 });
    expect((await all("SELECT count(*) AS n FROM audit_reasons WHERE workspace_id = ? AND reason LIKE ?", ws, `%${PHONE}%`))[0]).toEqual({ n: 5 + 0 });
    // the operator screens read them through the join
    const ops = (await (await operatorCall(OP1, 'GET', `/workspaces/${ws}/ops`)).json()) as { recentActions: { action: string; reason: string }[] };
    expect(ops.recentActions.map((a) => [a.action, a.reason])).toEqual([['unsuspend', R('case closed')], ['suspend', R('abuse report')]]);
    const log = (await (await operatorCall(OP1, 'GET', `/change-log?workspaceId=${ws}`)).json()) as { items: { action: string; reason: string | null }[] };
    expect(log.items.find((i) => i.action.startsWith('adjustment'))!.reason).toBe(R('goodwill credit'));
    const settings = (await (await operatorCall(OP1, 'GET', '/pricing-settings')).json()) as { items: { reason: string }[] };
    expect(settings.items[0]!.reason).toBe(R('margin review'));
    const overrides = (await (await operatorCall(OP1, 'GET', `/pricing-overrides/${ws}`)).json()) as { items: { reason: string }[] };
    expect(overrides.items[0]!.reason).toBe(R('deal'));
  });

  it('deleting the workspace removes the texts; the immutable rows stay with their ids', async () => {
    const w2 = W0(3301);
    await own(w2);
    await operatorCall(OP1, 'POST', `/workspaces/${w2}/suspend`, { reason: R('abuse report') });
    const { runOffboarding } = await import('../src/core/ops/offboarding');
    await operatorCall(OP1, 'POST', `/workspaces/${w2}/offboarding`, { reason: R('legal'), immediate: true });
    await operatorCall('22222222-2222-4222-8222-222222222222', 'POST', `/workspaces/${w2}/offboarding/release-hold`, { reason: R('release') });
    expect(await runOffboarding(env, w2, Date.now() + 1000)).toBe('done');
    expect(await all('SELECT 1 FROM audit_reasons WHERE workspace_id = ?', w2)).toEqual([]);
    expect((await all("SELECT count(*) AS n FROM operator_actions WHERE workspace_id = ?", w2))[0]!.n).toBeGreaterThan(0);
  });
});
