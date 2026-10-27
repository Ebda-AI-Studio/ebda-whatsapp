import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { backoffMs } from '../src/core/scheduler';
import type { SendJob } from '../src/core/send-queue';
import { exec, openChat, rows, workspace } from './helpers/workspace';

const alarmOf = (ws: string) => runInDurableObject(workspace(ws), (_i, s) => s.storage.getAlarm());
const tasks = (ws: string) => rows<{ kind: string; due_at: number; attempts: number }>(ws, 'SELECT kind, due_at, attempts FROM scheduled_tasks ORDER BY id');
const job: SendJob = { workspaceId: 'ws-sc', phoneNumberId: 'pn', to: '201001234567', text: 'x', idempotencyKey: 'ui:k' };

it('the single DO alarm is armed for the earliest due task (earliest wins)', async () => {
  const ws = workspace('ws-sc1');
  const t = Date.now();
  await ws.schedule('campaign_step', t + 600_000, { n: 1 });
  expect(await alarmOf('ws-sc1')).toBe(t + 600_000);
  await ws.schedule('campaign_step', t + 60_000, { n: 2 });
  expect(await alarmOf('ws-sc1')).toBe(t + 60_000);
  await ws.schedule('campaign_step', t + 900_000, { n: 3 });
  expect(await alarmOf('ws-sc1')).toBe(t + 60_000);
});

it('backup and r2_drain are singletons that keep the earliest due time', async () => {
  const ws = workspace('ws-sc2');
  const t = Date.now();
  await ws.schedule('r2_drain', t + 5_000_000);
  await ws.schedule('r2_drain', t + 1_000_000);
  await ws.schedule('r2_drain', t + 9_000_000);
  expect(await tasks('ws-sc2')).toEqual([{ kind: 'r2_drain', due_at: t + 1_000_000, attempts: 0 }]);
});

it('runs every due task even when one fails, records the failure with backoff, and re-arms', async () => {
  await openChat('ws-sc3'); // arms backup + r2_drain
  await exec('ws-sc3', "INSERT INTO r2_pending_deletes (key) VALUES ('bodies/ws-sc3/old')");
  const ws = workspace('ws-sc3');
  const now = Date.now();
  await exec('ws-sc3', 'UPDATE scheduled_tasks SET due_at = ?', now - 1000); // backup and r2_drain are both due
  await ws.schedule('send_release', now - 500, { job, reason: 'throughput' });
  vi.spyOn(env.BACKUPS, 'put').mockRejectedValue(new Error('bucket missing'));
  const spy = vi.mocked(env.SEND_QUEUE.sendBatch);
  const r = await ws.runDueTasks(now);
  expect(r).toEqual({ ran: 4, failed: 1 }); // backup (fails), r2_drain, retention_purge and the send release
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]![0]).toEqual([{ body: job }]);
  expect(await rows('ws-sc3', 'SELECT key FROM r2_pending_deletes')).toEqual([]); // drain ran despite the failed backup
  const left = await tasks('ws-sc3');
  expect(left.map((x) => x.kind).sort()).toEqual(['backup', 'r2_drain', 'retention_purge']);
  expect(left.find((x) => x.kind === 'backup')).toEqual({ kind: 'backup', due_at: now + backoffMs(1), attempts: 1 });
  expect(left.find((x) => x.kind === 'r2_drain')!.due_at).toBeGreaterThan(now); // rescheduled for the next night
  expect(await alarmOf('ws-sc3')).toBe(Math.min(...left.map((x) => x.due_at)));
});

it('backoff grows and is capped at one hour', () => {
  expect([1, 2, 3, 4].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
  expect(backoffMs(30)).toBe(3_600_000);
});

it('a backup that succeeds schedules the next one for 02:00 Cairo', async () => {
  await openChat('ws-sc4');
  const ws = workspace('ws-sc4');
  await exec('ws-sc4', "UPDATE scheduled_tasks SET due_at = 1 WHERE kind = 'backup'");
  expect(await ws.runDueTasks(Date.now())).toMatchObject({ failed: 0 });
  const [b] = (await tasks('ws-sc4')).filter((x) => x.kind === 'backup');
  expect(b!.due_at).toBeGreaterThan(Date.now());
  expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(b!.due_at)).toBe('02:00');
  expect((await env.BACKUPS.list({ prefix: 'backups/ws-sc4/' })).objects.length).toBeGreaterThan(0);
});

it('alarm() restores the daily tasks when a workspace had an alarm but no task rows (pre-scheduler data)', async () => {
  await openChat('ws-sc5');
  await exec('ws-sc5', 'DELETE FROM scheduled_tasks');
  await runInDurableObject(workspace('ws-sc5'), (_i, s) => s.storage.setAlarm(Date.now() + 1000));
  expect(await runDurableObjectAlarm(workspace('ws-sc5'))).toBe(true);
  expect((await tasks('ws-sc5')).map((x) => x.kind).sort()).toEqual(['backup', 'r2_drain', 'retention_purge']);
  expect(await alarmOf('ws-sc5')).toBeTypeOf('number');
});

it('a task with an invalid payload is dropped instead of retried forever', async () => {
  const ws = workspace('ws-sc6');
  await ws.schedule('send_release', Date.now() - 1, { nope: true } as never);
  expect(await ws.runDueTasks(Date.now())).toEqual({ ran: 1, failed: 0 });
  expect((await tasks('ws-sc6')).filter((x) => x.kind === 'send_release')).toEqual([]);
  expect(vi.mocked(env.SEND_QUEUE.sendBatch)).not.toHaveBeenCalled();
});
