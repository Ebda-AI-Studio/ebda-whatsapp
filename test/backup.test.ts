import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
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

it('alarm exports and re-arms about 24 h later', async () => {
  await seed('ws-b6', 2);
  const before = await runInDurableObject(workspace('ws-b6'), (_i, s) => s.storage.getAlarm());
  await exec('ws-b6', 'UPDATE scheduled_tasks SET due_at = 1'); // the alarm fires when the task is due; make it due now
  expect(await runDurableObjectAlarm(workspace('ws-b6'))).toBe(true);
  const listed = await env.BACKUPS.list({ prefix: 'backups/ws-b6/' });
  expect(listed.objects.some((o) => o.key.endsWith('/manifest.json'))).toBe(true);
  const after = await runInDurableObject(workspace('ws-b6'), (_i, s) => s.storage.getAlarm());
  expect(after!).toBeGreaterThan(Date.now());
  expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(after!)).toBe('02:00');
  expect(before).not.toBeNull();
});

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
