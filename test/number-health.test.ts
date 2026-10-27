import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { blocksTemplates, nextHealth, SPIKE_THRESHOLD, type HealthState } from '../src/core/numbers/health';
import { postWebhook } from './helpers/meta';
import { PARAMS, makeCampaign, seedContacts, seedTemplate } from './helpers/campaigns';
import { chat, jobOf, pn, queueTemplate, queueText, setupBilling, fund } from './helpers/billing';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { exec, own, rows, workspace } from './helpers/workspace';

useApiKey();
const alerts = () => vi.spyOn(console, 'error');
const alertNames = (s: ReturnType<typeof alerts>) => s.mock.calls.map((c) => { try { return (JSON.parse(String(c[0])) as { alert?: string }).alert; } catch { return undefined; } });

describe('the state machine', () => {
  const table: [HealthState, Parameters<typeof nextHealth>[1], HealthState][] = [
    ['green', { kind: 'quality', event: 'FLAGGED' }, 'red'], // FLAGGED fails closed: campaigns pause AND new templates stop
    ['yellow', { kind: 'quality', event: 'FLAGGED' }, 'red'],
    ['green', { kind: 'quality', event: 'DOWNGRADE' }, 'yellow'],
    ['red', { kind: 'quality', event: 'DOWNGRADE' }, 'red'], // a quality event NEVER lowers red
    ['restricted', { kind: 'quality', event: 'DOWNGRADE' }, 'restricted'],
    ['green', { kind: 'quality', event: 'ONBOARDING' }, 'green'],
    ['red', { kind: 'quality', event: 'ONBOARDING' }, 'red'],
    ['red', { kind: 'quality', event: 'UNFLAGGED' }, 'green'], // explicit recovery
    ['yellow', { kind: 'quality', event: 'UNFLAGGED' }, 'green'],
    ['yellow', { kind: 'quality', event: 'UPGRADE' }, 'green'],
    ['red', { kind: 'quality', event: 'UPGRADE' }, 'red'], // a tier upgrade is not a recovery from red
    ['green', { kind: 'rating', rating: 'RED' }, 'red'],
    ['green', { kind: 'rating', rating: 'yellow' }, 'yellow'],
    ['red', { kind: 'rating', rating: 'YELLOW' }, 'red'], // not lowered by anything but GREEN
    ['red', { kind: 'rating', rating: 'GREEN' }, 'green'],
    ['red', { kind: 'rating', rating: 'UNKNOWN' }, 'red'],
    ['green', { kind: 'restricted' }, 'restricted'],
    ['red', { kind: 'restricted' }, 'restricted'],
    ['restricted', { kind: 'quality', event: 'UNFLAGGED' }, 'restricted'], // only Meta lifting the restriction clears it
    ['restricted', { kind: 'quality', event: 'UPGRADE' }, 'restricted'],
    ['restricted', { kind: 'rating', rating: 'GREEN' }, 'restricted'],
    ['restricted', { kind: 'restriction_lifted' }, 'yellow'], // never straight to green
    ['green', { kind: 'restriction_lifted' }, 'green'],
    ['red', { kind: 'restriction_lifted' }, 'red'],
    ['green', { kind: 'spike' }, 'yellow'],
    ['red', { kind: 'spike' }, 'red'],
  ];
  it.each(table)('%s + %j -> %s', (from, sig, to) => expect(nextHealth(from, sig)).toBe(to));
  it('only red and restricted block templates', () => {
    expect(['green', 'yellow', 'red', 'restricted'].map((s) => blocksTemplates(s as HealthState))).toEqual([false, false, true, true]);
  });
});

const qualityHook = (waba: string, display: string, event: string, time = 1) =>
  JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: waba, time, changes: [{ field: 'phone_number_quality_update', value: { display_phone_number: display, event, current_limit: 'TIER_1K' } }] }] });
const accountHook = (waba: string, value: Record<string, unknown>, time = 1) =>
  JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: waba, time, changes: [{ field: 'account_update', value }] }] });
const d1Health = (id: string) => env.DB.prepare('SELECT health_state, health_reason FROM phone_numbers WHERE phone_number_id = ?').bind(id).first<{ health_state: string; health_reason: string | null }>();
async function runningCampaign(ws: string) {
  await own(ws);
  await env.DB.prepare("UPDATE phone_numbers SET display_phone = '+20 100 777 0001' WHERE phone_number_id = 'pn-x'").run();
  await seedTemplate(ws);
  await seedContacts(ws, 3);
  const c = await makeCampaign(ws);
  await exec(ws, "UPDATE campaigns SET status = 'running', attempt = 1 WHERE id = ?", c.id);
  return c;
}
const campaignRow = async (ws: string, id: string) => (await rows<{ status: string; pause_reason: string | null }>(ws, 'SELECT status, pause_reason FROM campaigns WHERE id = ?', id))[0]!;

describe('Meta webhooks drive the state', () => {
  it('FLAGGED: running campaigns pause with quality_flagged, the number goes red (templates stop), D1 and the workspace agree, P0 number_restricted; the webhook is acknowledged', async () => {
    const ws = W(980);
    const c = await runningCampaign(ws);
    const spy = alerts();
    expect((await postWebhook(SELF, qualityHook('waba-own', '201007770001', 'FLAGGED'))).status).toBe(200);
    expect(await campaignRow(ws, c.id)).toEqual({ status: 'paused', pause_reason: 'quality_flagged' });
    expect(await d1Health('pn-x')).toEqual({ health_state: 'red', health_reason: 'quality:FLAGGED' });
    expect(await workspace(ws).numberHealth('pn-x')).toBe('red');
    expect(alertNames(spy)).toContain('number_restricted');
  });

  it('a redelivered FLAGGED changes nothing a second time (idempotent: one log row, one alert)', async () => {
    const ws = W(981);
    await runningCampaign(ws);
    const spy = alerts();
    await postWebhook(SELF, qualityHook('waba-own', '201007770001', 'FLAGGED'));
    await postWebhook(SELF, qualityHook('waba-own', '201007770001', 'FLAGGED'));
    expect(await rows(ws, 'SELECT 1 FROM number_health_log')).toHaveLength(1);
    expect(alertNames(spy).filter((n) => n === 'number_restricted')).toHaveLength(1);
  });

  it('recovery (UNFLAGGED) turns the number green but NEVER resumes a campaign', async () => {
    const ws = W(982);
    const c = await runningCampaign(ws);
    await postWebhook(SELF, qualityHook('waba-own', '201007770001', 'FLAGGED'));
    await postWebhook(SELF, qualityHook('waba-own', '201007770001', 'UNFLAGGED', 2));
    expect(await d1Health('pn-x')).toMatchObject({ health_state: 'green' });
    expect(await campaignRow(ws, c.id)).toEqual({ status: 'paused', pause_reason: 'quality_flagged' });
  });

  it('account_update: a restriction restricts every number on the WABA (P0), lifting it only gets back to yellow, campaigns stay paused', async () => {
    const ws = W(983);
    const c = await runningCampaign(ws);
    const spy = alerts();
    expect((await postWebhook(SELF, accountHook('waba-own', { event: 'ACCOUNT_RESTRICTION', restriction_info: [{ restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING', expiration: '2026-11-01T00:00:00Z' }] }))).status).toBe(200);
    expect((await d1Health('pn-x'))!.health_state).toBe('restricted');
    expect(await campaignRow(ws, c.id)).toEqual({ status: 'paused', pause_reason: 'quality_flagged' });
    expect(alertNames(spy)).toContain('number_restricted');
    await postWebhook(SELF, accountHook('waba-own', { event: 'ACCOUNT_RESTRICTION', restriction_info: [] }));
    expect((await d1Health('pn-x'))!.health_state).toBe('yellow');
    expect((await campaignRow(ws, c.id)).status).toBe('paused');
  });

  it('a ban (DISABLE) restricts; REINSTATE lifts', async () => {
    const ws = W(984);
    await runningCampaign(ws);
    await postWebhook(SELF, accountHook('waba-own', { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'DISABLE' } }));
    expect((await d1Health('pn-x'))!.health_state).toBe('restricted');
    await postWebhook(SELF, accountHook('waba-own', { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'REINSTATE' } }));
    expect((await d1Health('pn-x'))!.health_state).toBe('yellow');
  });

  it('an unrelated account_update or quality event without a known meaning changes nothing', async () => {
    const ws = W(985);
    await runningCampaign(ws);
    await postWebhook(SELF, accountHook('waba-own', { event: 'VERIFIED_ACCOUNT' }));
    await postWebhook(SELF, qualityHook('waba-own', '201007770001', 'ONBOARDING'));
    expect((await d1Health('pn-x'))!.health_state).toBe('green');
    expect(await rows(ws, 'SELECT 1 FROM number_health_log')).toHaveLength(0);
  });
});

describe('fail closed and ordered', () => {
  it('RED then DOWNGRADE (or a YELLOW rating) is still red: only UNFLAGGED / a GREEN rating lowers it', async () => {
    const ws = W(991);
    await runningCampaign(ws);
    await workspace(ws).applyNumberHealth('pn-x', { kind: 'rating', rating: 'RED' }, Date.now(), 1000);
    await postWebhook(SELF, qualityHook('waba-own', '201007770001', 'DOWNGRADE', 5)); // newer than the RED, and still not allowed to lower it
    expect((await d1Health('pn-x'))!.health_state).toBe('red');
    expect(await workspace(ws).numberHealth('pn-x')).toBe('red');
    await workspace(ws).applyNumberHealth('pn-x', { kind: 'rating', rating: 'YELLOW' }, Date.now(), 6000);
    expect(await workspace(ws).numberHealth('pn-x')).toBe('red');
    await postWebhook(SELF, qualityHook('waba-own', '201007770001', 'UNFLAGGED', 10));
    expect(await workspace(ws).numberHealth('pn-x')).toBe('green');
  });

  it('a retried OLDER signal never undoes a newer one: REINSTATE(t1), DISABLE(t2), REINSTATE(t1) again -> still restricted', async () => {
    const ws = W(992);
    await runningCampaign(ws);
    const disable = { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'DISABLE' } };
    const reinstate = { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'REINSTATE' } };
    await postWebhook(SELF, accountHook('waba-own', reinstate, 1000));
    await postWebhook(SELF, accountHook('waba-own', disable, 2000));
    expect((await d1Health('pn-x'))!.health_state).toBe('restricted');
    await postWebhook(SELF, accountHook('waba-own', reinstate, 1000)); // Meta retries the old one after a 5xx
    expect((await d1Health('pn-x'))!.health_state).toBe('restricted');
    expect(await workspace(ws).numberHealth('pn-x')).toBe('restricted');
    await postWebhook(SELF, accountHook('waba-own', reinstate, 3000)); // a genuinely newer REINSTATE does lift it
    expect((await d1Health('pn-x'))!.health_state).toBe('yellow');
  });
});

describe('ordering can only drop a stale RECOVERY, never a worsening', () => {
  it('a local spike (processing time) does not make a later-arriving, earlier-stamped Meta DISABLE look stale: it is applied -> restricted', async () => {
    const ws = W(993);
    await runningCampaign(ws);
    for (let i = 0; i < SPIKE_THRESHOLD; i++) await workspace(ws).noteSendError('pn-x', 131049); // local "now" is far newer than the DISABLE below
    expect((await d1Health('pn-x'))!.health_state).toBe('yellow');
    expect(await env.DB.prepare("SELECT health_signal_at AS t FROM phone_numbers WHERE phone_number_id = 'pn-x'").first('t')).toBe(0); // a local signal never advances the ordering column
    await postWebhook(SELF, accountHook('waba-own', { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'DISABLE' } }, 90));
    expect((await d1Health('pn-x'))!.health_state).toBe('restricted');
    expect(await workspace(ws).numberHealth('pn-x')).toBe('restricted');
  });
  it('a worsening Meta signal stamped BEFORE the newest applied one is still applied (FLAGGED t=5 after UNFLAGGED t=10)', async () => {
    const ws = W(994);
    await runningCampaign(ws);
    await postWebhook(SELF, qualityHook('waba-own', '201007770001', 'UNFLAGGED', 10));
    await postWebhook(SELF, qualityHook('waba-own', '201007770001', 'FLAGGED', 5));
    expect((await d1Health('pn-x'))!.health_state).toBe('red'); // fail closed: never dropped for being old
  });
  it('a stale RECOVERY is dropped: DISABLE(t2) then REINSTATE(t1) -> still restricted', async () => {
    const ws = W(995);
    await runningCampaign(ws);
    await postWebhook(SELF, accountHook('waba-own', { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'DISABLE' } }, 2000));
    await postWebhook(SELF, accountHook('waba-own', { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'REINSTATE' } }, 1000));
    expect((await d1Health('pn-x'))!.health_state).toBe('restricted');
  });
});

describe('what a number state stops', () => {
  it('RED / restricted: a template send is refused at claim (number_restricted) but a service reply inside the window still goes; yellow stops nothing but campaigns', async () => {
    const ws = W(986);
    await setupBilling(ws);
    await fund(ws, 100_000);
    const conv = await chat(ws, 'UTILITY');
    const number = pn(ws);
    await workspace(ws).applyNumberHealth(number, { kind: 'rating', rating: 'YELLOW' });
    const tplYellow = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    expect(await workspace(ws).claimSend(tplYellow)).toBe('claimed'); // yellow: still allowed
    await workspace(ws).applyNumberHealth(number, { kind: 'rating', rating: 'RED' });
    const tpl = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    expect(await workspace(ws).claimSend(tpl)).toBe('dropped');
    expect(await rows(ws, 'SELECT status, error_reason FROM messages WHERE idempotency_key = ?', tpl.idempotencyKey)).toEqual([{ status: 'failed', error_reason: 'number_restricted' }]);
    const reply = jobOf(await queueText(ws, conv));
    expect(await workspace(ws).claimSend(reply)).toBe('claimed'); // service reply inside the 24 h window
    await workspace(ws).applyNumberHealth(number, { kind: 'rating', rating: 'GREEN' });
    const again = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    expect(await workspace(ws).claimSend(again)).toBe('claimed'); // green again
  });

  it('a campaign on a red / restricted number cannot be resumed or started until Meta clears it', async () => {
    const ws = W(987);
    const c = await runningCampaign(ws);
    await workspace(ws).applyNumberHealth('pn-x', { kind: 'restricted' });
    expect(await workspace(ws).resumeCampaign(c.id)).toEqual({ ok: false, reason: 'number_restricted' });
    await workspace(ws).applyNumberHealth('pn-x', { kind: 'restriction_lifted' }); // yellow
    const r = await workspace(ws).resumeCampaign(c.id);
    expect(r.ok).toBe(true); // the merchant decides, with the badge in front of them
  });
});

describe('spike guard (A5)', () => {
  it(`${SPIKE_THRESHOLD} frequency-cap / undeliverable errors inside the window pause the number's campaigns and raise P1; below that nothing happens`, async () => {
    const ws = W(988);
    const c = await runningCampaign(ws);
    const spy = alerts();
    for (let i = 0; i < SPIKE_THRESHOLD - 1; i++) await workspace(ws).noteSendError('pn-x', i % 2 ? 131049 : 131026);
    expect((await campaignRow(ws, c.id)).status).toBe('running');
    await workspace(ws).noteSendError('pn-x', 131049);
    expect(await campaignRow(ws, c.id)).toEqual({ status: 'paused', pause_reason: 'quality_flagged' });
    expect(await d1Health('pn-x')).toMatchObject({ health_state: 'yellow', health_reason: 'spike' });
    expect(alertNames(spy)).toContain('number_error_spike');
  });
  it('other error codes never count', async () => {
    const ws = W(989);
    const c = await runningCampaign(ws);
    for (let i = 0; i < SPIKE_THRESHOLD + 5; i++) await workspace(ws).noteSendError('pn-x', 131047);
    expect((await campaignRow(ws, c.id)).status).toBe('running');
  });
});

describe('the Numbers screen reads the state', () => {
  it('GET /numbers carries health for the owner', async () => {
    const ws = W(990);
    await runningCampaign(ws);
    await postWebhook(SELF, qualityHook('waba-own', '201007770001', 'DOWNGRADE'));
    const api = await apiFor(ws);
    const res = await api.call('GET', '/numbers');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { phoneNumberId: string; health?: string }[] };
    expect(body.items.find((n) => n.phoneNumberId === 'pn-x')?.health).toBe('yellow');
  });
});
