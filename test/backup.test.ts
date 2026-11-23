import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { BACKUP_TABLES, nextLocalHour } from '../src/core/backup';
import { exec, rows, workspace } from './helpers/workspace';

async function seed(ws: string, n: number, offset = 0) {
  const inbound = Array.from({ length: n }, (_, i) => ({ wamid: `wamid.${ws}.${offset + i}`, from: `2010000000${(offset + i) % 10}`, ts: 1000 + offset + i, type: 'text' as const, text: `رسالة ${offset + i} 👋` }));
  await workspace(ws).ingest({ phoneNumberId: 'pn', inbound, statuses: [{ wamid: `wamid.${ws}.0`, status: 'read', ts: 2000 }], receivedAt: 1 });
}

const lines = async (key: string) => ((await (await env.BACKUPS.get(key))?.text()) ?? '').split('\n').filter(Boolean).length;

it('export writes one file per table and a manifest with counts and hashes', async () => {
  await seed('ws-b1', 5);
  const m = await workspace('ws-b1').exportSnapshot('2026-10-24');
  expect(Object.keys(m.tables)).toEqual([...BACKUP_TABLES]);
  expect(m.tables.messages.rows).toBe(5);
  expect(m.tables.messages.sha256).toMatch(/^[0-9a-f]{64}$/);
  for (const t of BACKUP_TABLES) expect(await lines(`backups/ws-b1/2026-10-24/${t}.ndjson`)).toBe(m.tables[t]!.rows);
  expect(JSON.parse((await (await env.BACKUPS.get('backups/ws-b1/2026-10-24/manifest.json'))!.text())).workspaceId).toBe('ws-b1');
});

it('import into an empty workspace reproduces counts and hashes', async () => {
  await seed('ws-b2', 7);
  const m = await workspace('ws-b2').exportSnapshot('2026-10-24');
  const restored = await workspace('ws-b2-restore').importSnapshot('backups/ws-b2/2026-10-24/');
  expect(restored).toEqual({ ok: true, manifest: m });
  expect(await rows('ws-b2-restore', 'SELECT preview FROM messages ORDER BY id LIMIT 1')).toEqual([{ preview: 'رسالة 0 👋' }]);
});

it('a backup carries the merchant\'s quick replies and restore brings them back in order', async () => {
  await seed('ws-bq1', 2);
  await exec('ws-bq1', "INSERT INTO quick_replies (text, position, created_by, created_at) VALUES ('اهلا بيك', 1, 'u1', 10), ('تم الشحن', 2, NULL, 20)");
  const m = await workspace('ws-bq1').exportSnapshot('2026-10-24');
  expect(m.tables.quick_replies!.rows).toBe(2);
  expect(await workspace('ws-bq1-restore').importSnapshot('backups/ws-bq1/2026-10-24/')).toEqual({ ok: true, manifest: m });
  expect(await rows('ws-bq1-restore', 'SELECT text, position, created_by, created_at FROM quick_replies ORDER BY position')).toEqual([
    { text: 'اهلا بيك', position: 1, created_by: 'u1', created_at: 10 }, { text: 'تم الشحن', position: 2, created_by: null, created_at: 20 },
  ]);
});

it('import refuses a tampered file', async () => {
  await seed('ws-b3', 3);
  await workspace('ws-b3').exportSnapshot('2026-10-24');
  const key = 'backups/ws-b3/2026-10-24/messages.ndjson';
  const text = (await (await env.BACKUPS.get(key))!.text()).replace('رسالة 1', 'رسالة X');
  await env.BACKUPS.put(key, text);
  expect(await workspace('ws-b3-restore').importSnapshot('backups/ws-b3/2026-10-24/')).toEqual({ ok: false, reason: 'backup checksum mismatch: messages' });
  expect(await rows('ws-b3-restore', 'SELECT id FROM messages')).toEqual([]);
});

it('import refuses a non-empty workspace', async () => {
  await seed('ws-b4', 2);
  await workspace('ws-b4').exportSnapshot('2026-10-24');
  expect(await workspace('ws-b4').importSnapshot('backups/ws-b4/2026-10-24/')).toEqual({ ok: false, reason: 'restore target workspace is not empty' });
});

it('ingest arms a daily alarm once', async () => {
  await seed('ws-b5', 1);
  const first = await runInDurableObject(workspace('ws-b5'), (_i, s) => s.storage.getAlarm());
  await seed('ws-b5', 1, 10);
  const second = await runInDurableObject(workspace('ws-b5'), (_i, s) => s.storage.getAlarm());
  expect(first).toBeTypeOf('number');
  expect(second).toBe(first);
});

// The DO has ONE alarm = the earliest of the daily tasks (backup 02:00 Cairo, retention purge 05:00 Cairo). Pin "now" so the
// answer never depends on when CI runs: between 02:00 and 05:00 Cairo the purge is the earlier task, and that is correct.
const cairo = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
const taskDue = (ws: string, kind: string) => rows<{ due_at: number }>(ws, 'SELECT due_at FROM scheduled_tasks WHERE kind = ?', kind).then((r) => r[0]!.due_at);

// Winter time in Cairo (UTC+2). The instants are far in the future so an alarm armed under the fake clock is not already overdue on the real one.
for (const c of [
  { name: 'between 02:00 and 05:00 Cairo (purge alarm is first)', now: Date.UTC(2030, 0, 15, 1, 30), alarm: 'purge' },
  { name: 'just after the 02:00 alarm fired', now: Date.UTC(2030, 0, 15, 0, 0, 30), alarm: 'purge' },
  { name: 'after 05:00 Cairo (backup alarm is first)', now: Date.UTC(2030, 0, 15, 4, 0), alarm: 'backup' },
] as const) {
  it(`alarm exports and re-arms the backup about 24 h later: ${c.name}`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(c.now);
      const ws = `ws-b6-${c.now}`;
      await seed(ws, 2);
      await exec(ws, "UPDATE scheduled_tasks SET due_at = 1 WHERE kind = 'backup'"); // the alarm fires when the task is due; make it due now
      const purgeBefore = await taskDue(ws, 'retention_purge');
      expect(await runDurableObjectAlarm(workspace(ws))).toBe(true);
      expect((await env.BACKUPS.list({ prefix: `backups/${ws}/` })).objects.some((o) => o.key.endsWith('/manifest.json'))).toBe(true);
      const backupNext = await taskDue(ws, 'backup');
      expect(cairo(backupNext)).toBe('02:00');
      expect(backupNext).toBe(Date.UTC(2030, 0, 16, 0, 0)); // the NEXT 02:00 Cairo (00:00 UTC), whichever task armed the alarm
      expect(cairo(purgeBefore)).toBe('05:00');
      const alarm = await runInDurableObject(workspace(ws), (_i, s) => s.storage.getAlarm());
      expect(alarm).toBe(Math.min(backupNext, await taskDue(ws, 'retention_purge')));
      expect(cairo(alarm!)).toBe(c.alarm === 'purge' ? '05:00' : '02:00');
    } finally {
      vi.useRealTimers();
    }
  });
}

it('snapshot is consistent while ingest runs', async () => {
  await seed('ws-b7', 20);
  const [m] = await Promise.all([workspace('ws-b7').exportSnapshot('2026-10-25'), seed('ws-b7', 20, 100)]);
  for (const t of BACKUP_TABLES) expect(await lines(`backups/ws-b7/2026-10-25/${t}.ndjson`)).toBe(m.tables[t]!.rows);
});

it('nextLocalHour finds the next 02:00 in Cairo', () => {
  const now = Date.UTC(2026, 9, 24, 22, 0); // 01:00 Cairo (UTC+3, summer time)
  const next = nextLocalHour(now, 2, 'Africa/Cairo');
  expect(new Date(next).toISOString()).toBe('2026-10-24T23:00:00.000Z');
});
