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
    expect((await chatControls(env, workspace(s))).mode).toBe('answer-only');
    const put = await operatorCall(OP1, 'PUT', '/assistant/flags', { global: { kill: true }, killedTools: ['wallet_view'] });
    expect(put.status).toBe(200);
    expect(await chatControls(env, workspace(s))).toMatchObject({ mode: 'off', killGlobal: true });
    expect(await (await operatorCall(OP1, 'GET', '/assistant')).json()).toMatchObject({ global: { kill: true }, killedTools: ['wallet_view'] });
    await operatorCall(OP1, 'PUT', '/assistant/flags', { global: {}, killedTools: [] });
    expect((await chatControls(env, workspace(s))).mode).toBe('answer-only');
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
});
