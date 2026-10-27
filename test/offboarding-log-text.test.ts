import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { runOffboarding } from '../src/core/ops/offboarding';
import { OP1, OP2, apiFor, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { own } from './helpers/workspace';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); });
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });
const ws = W0(3200);
const PHONE = '01001234567';
const R = (n: number) => `case ${n}: caller ${PHONE} asked by phone`;
const op = (sub: string, method: string, path: string, body?: unknown) => operatorCall(sub, method, `/workspaces/${ws}/offboarding${path}`, body);
const d1 = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).all<T>().then((r) => r.results);
const logText = async () => JSON.stringify(await d1('SELECT * FROM offboarding_log WHERE workspace_id = ?', ws));

describe('AUDIT-REASONS: the immutable offboarding_log stores NO free text; the reason lives in audit_reasons, referenced by id', () => {
  it('a reason with a phone number never reaches offboarding_log on any path; the operator view still shows it; deletion removes it everywhere', async () => {
    await own(ws);
    await (await apiFor(ws)).call('POST', '/offboarding', { confirm: true, reason: R(0) }); // an owner's own words
    expect((await op(OP1, 'POST', '', { reason: R(1) })).status).toBe(202); // takeover
    expect((await op(OP1, 'POST', '', { reason: R(2) })).status).toBe(202); // changed
    expect(await logText()).not.toContain(PHONE);
    const view = (await (await op(OP1, 'GET', '')).json()) as { log: { action: string; reason: string | null }[] };
    expect(view.log.map((l) => [l.action, l.reason])).toEqual([['requested', R(0)], ['taken_over', R(1)], ['operator_changed', R(2)]]); // shown through the id, while the workspace exists
    expect((await op(OP2, 'DELETE', '', { reason: R(3) })).status).toBe(200);
    expect((await op(OP1, 'POST', '', { reason: R(4), immediate: true })).status).toBe(202);
    expect(await logText()).not.toContain(PHONE);
    expect(await d1('SELECT count(*) AS n FROM offboarding_log WHERE workspace_id = ? AND reason IS NOT NULL', ws)).toEqual([{ n: 0 }]);
    expect(await d1('SELECT count(*) AS n FROM offboarding_log WHERE workspace_id = ? AND reason_id IS NOT NULL', ws)).toEqual([{ n: 5 }]);
    expect((await d1<{ n: number }>("SELECT count(*) AS n FROM audit_reasons WHERE workspace_id = ? AND reason LIKE ?", ws, `%${PHONE}%`))[0]!.n).toBe(5);
    expect(await runOffboarding(env, ws, Date.now() + 1000)).toBe('done');
    // gone with the workspace: the reasons, and the request row's own copy
    expect(await d1('SELECT 1 FROM audit_reasons WHERE workspace_id = ?', ws)).toEqual([]);
    expect(await d1('SELECT reason FROM offboarding WHERE workspace_id = ?', ws)).toEqual([{ reason: null }]);
    expect(await logText()).not.toContain(PHONE);
    expect((await d1<{ reason_id: number | null }>('SELECT reason_id FROM offboarding_log WHERE workspace_id = ? AND reason_id IS NOT NULL', ws)).length).toBe(5); // the ids stay; what they pointed at is gone
  });

  it('the second approval and the hold release keep their reasons out of the log too', async () => {
    const w2 = W0(3201);
    await own(w2);
    await operatorCall(OP1, 'POST', `/workspaces/${w2}/suspend`, { reason: 'abuse report 5' });
    await operatorCall(OP1, 'POST', `/workspaces/${w2}/offboarding`, { reason: R(5), immediate: true });
    await operatorCall(OP2, 'POST', `/workspaces/${w2}/offboarding/release-hold`, { reason: R(6) });
    const text = JSON.stringify(await d1('SELECT * FROM offboarding_log WHERE workspace_id = ?', w2));
    expect(text).not.toContain(PHONE);
    expect((await d1<{ n: number }>('SELECT count(*) AS n FROM audit_reasons WHERE workspace_id = ? AND reason LIKE ?', w2, `%${PHONE}%`))[0]!.n).toBe(2);
  });
});
