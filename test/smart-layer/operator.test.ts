import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { configureSessionCheck } from '../../src/core/identity/session';
import { chatControls } from '../../src/core/smart-layer/controls';
import { OP1, apiFor, operatorCall, storeId, useApiKey } from '../helpers/api';
import { workspace } from '../helpers/workspace';

useApiKey();
beforeEach(() => { configureSessionCheck(async () => false); });

describe('operator assistant controls', () => {
  it('an operator sets a workspace mode and the platform switches; none of it needs a deploy', async () => {
    const s = storeId(7101);
    await apiFor(s);
    expect((await operatorCall(OP1, 'PUT', `/workspaces/${s}/assistant`, { mode: 'answer-only' })).status).toBe(200);
    expect(await workspace(s).assistantMode()).toBe('answer-only');
    // An unset platform cap is OFF: a store flag alone never turns the assistant on.
    expect((await chatControls(env, workspace(s))).mode).toBe('off');
    expect((await operatorCall(OP1, 'PUT', '/assistant/flags', { global: { mode: 'answer-only' }, killedTools: [] })).status).toBe(200);
    expect((await chatControls(env, workspace(s))).mode).toBe('answer-only');
    const put = await operatorCall(OP1, 'PUT', '/assistant/flags', { global: { kill: true }, killedTools: ['wallet_view'] });
    expect(put.status).toBe(200);
    expect(await chatControls(env, workspace(s))).toMatchObject({ mode: 'off', killGlobal: true });
    expect(await (await operatorCall(OP1, 'GET', '/assistant')).json()).toMatchObject({ global: { kill: true }, killedTools: ['wallet_view'] });
    await operatorCall(OP1, 'PUT', '/assistant/flags', { global: { mode: 'answer-only' }, killedTools: [] });
    expect((await chatControls(env, workspace(s))).mode).toBe('answer-only');
  });

  it('an operator can read a workspace mode back (404 for an unknown workspace)', async () => {
    const s = storeId(7105);
    await apiFor(s);
    expect(await (await operatorCall(OP1, 'GET', `/workspaces/${s}/assistant`)).json()).toEqual({ mode: 'off' });
    await operatorCall(OP1, 'PUT', `/workspaces/${s}/assistant`, { mode: 'suggest' });
    expect(await (await operatorCall(OP1, 'GET', `/workspaces/${s}/assistant`)).json()).toEqual({ mode: 'suggest' });
    expect((await operatorCall(OP1, 'GET', `/workspaces/${storeId(7198)}/assistant`)).status).toBe(404);
  });

  it('the audit rows for the assistant switches carry before and after values (not NULL detail)', async () => {
    const s = storeId(7106);
    await apiFor(s);
    await operatorCall(OP1, 'PUT', '/assistant/flags', { global: { kill: false, mode: 'answer-only', shadow: false }, product: { kill: false }, killedTools: [] });
    await operatorCall(OP1, 'PUT', '/assistant/flags', { global: { kill: true, mode: 'act', shadow: false }, killedTools: ['wallet_view'] });
    await operatorCall(OP1, 'PUT', `/workspaces/${s}/assistant`, { mode: 'suggest' });
    await operatorCall(OP1, 'PUT', `/workspaces/${s}/assistant`, { mode: 'act' });
    const rows = (await env.DB.prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'PUT /operator/%assistant%' AND (workspace_id = ? OR workspace_id IS NULL) ORDER BY id").bind(s).all<{ action: string; detail: string | null }>()).results;
    const flags = rows.filter((r) => r.action.endsWith('/assistant/flags') && r.detail).map((r) => JSON.parse(r.detail ?? 'null'));
    expect(flags.at(-1)).toMatchObject({ globalKillFrom: false, globalKillTo: true, globalModeFrom: 'answer-only', globalModeTo: 'act', killedToolsFrom: '', killedToolsTo: 'wallet_view' });
    expect(flags.at(-1)).not.toHaveProperty('chatKillFrom'); // untouched switches are not claimed
    const modes = rows.filter((r) => r.action.endsWith(':workspaceId/assistant')).map((r) => JSON.parse(r.detail ?? 'null'));
    expect(modes).toEqual([{ modeFrom: 'off', modeTo: 'suggest' }, { modeFrom: 'suggest', modeTo: 'act' }]);
  });

  it('refuses an unknown mode, an unknown field and an unknown workspace', async () => {
    const s = storeId(7102);
    await apiFor(s);
    expect((await operatorCall(OP1, 'PUT', `/workspaces/${s}/assistant`, { mode: 'turbo' })).status).toBe(400);
    expect((await operatorCall(OP1, 'PUT', '/assistant/flags', { global: { mode: 'act' }, rootAccess: true })).status).toBe(400);
    expect((await operatorCall(OP1, 'PUT', `/workspaces/${storeId(7199)}/assistant`, { mode: 'act' })).status).toBe(404);
  });

  it('a merchant (owner) can never set the mode, their own or anyone\'s', async () => {
    const s = storeId(7103);
    const { call, token } = await apiFor(s);
    expect((await call('PUT', '/assistant', { mode: 'act' })).status).toBe(404);
    const res = await SELF.fetch(`https://x/api/v1/operator/workspaces/${s}/assistant`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'act' }) });
    expect(res.status).toBe(403);
    expect(await workspace(s).assistantMode()).toBe('off');
  });

  it('the agent-settings PUT cannot carry the assistant mode (server-owned): the key is ignored or refused and the mode stays off', async () => {
    const s = storeId(7104);
    const { call } = await apiFor(s);
    for (const body of [{ assistantMode: 'act' }, { assistant: { mode: 'act' } }, { mode: 'act' }, { 'assistant.mode': 'act' }]) {
      const res = await call('PUT', '/agent', body);
      expect([200, 400]).toContain(res.status);
      expect(await workspace(s).assistantMode()).toBe('off');
    }
  });
});
