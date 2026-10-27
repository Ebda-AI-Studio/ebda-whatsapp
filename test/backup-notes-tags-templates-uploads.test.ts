import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BACKUP_TABLES } from '../src/core/backup';
import { exec, openChat, rows, workspace } from './helpers/workspace';

async function seedPhase2(ws: string) {
  const conv = await openChat(ws, '201001234567', { text: 'نص قابل للبحث' });
  await workspace(ws).addNote(conv, 'u1', 'ملاحظة داخلية');
  await workspace(ws).setTags(conv, ['vip', 'شحن']);
  await workspace(ws).assign(conv, 'u1', 'u1');
  await exec(ws, "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('t', 'ar', 'UTILITY', 'APPROVED', '[]', 1)");
  await exec(ws, "INSERT INTO uploads (id, meta_media_id, mime, size, filename, r2_key, created_at) VALUES ('u', 'm', 'image/png', 1, 'a.png', 'uploads/x/u', 1)");
  await exec(ws, "UPDATE contacts SET opted_out_at = 5, consent_source = 'keyword_stop'");
}

it('a backup covers notes, tags, templates, uploads, assignment and consent, and restore brings them (and search) back', async () => {
  await seedPhase2('ws-bp1');
  const m = await workspace('ws-bp1').exportSnapshot('2026-10-24');
  expect(Object.keys(m.tables)).toEqual([...BACKUP_TABLES]);
  expect(BACKUP_TABLES).toEqual(expect.arrayContaining(['notes', 'conversation_tags', 'templates', 'uploads']));
  expect(await workspace('ws-bp1-restore').importSnapshot('backups/ws-bp1/2026-10-24/')).toEqual({ ok: true, manifest: m });
  const r = 'ws-bp1-restore';
  expect(await rows(r, 'SELECT text FROM notes')).toEqual([{ text: 'ملاحظة داخلية' }]);
  expect((await rows<{ tag: string }>(r, 'SELECT tag FROM conversation_tags')).map((x) => x.tag).sort()).toEqual(['vip', 'شحن'].sort());
  expect(await rows(r, 'SELECT name FROM templates')).toEqual([{ name: 't' }]);
  expect(await rows(r, 'SELECT id FROM uploads')).toEqual([{ id: 'u' }]);
  expect(await rows(r, 'SELECT assignee_user_id FROM conversations')).toEqual([{ assignee_user_id: 'u1' }]);
  expect(await rows(r, 'SELECT opted_out_at, consent_source FROM contacts')).toEqual([{ opted_out_at: 5, consent_source: 'keyword_stop' }]);
  expect(await workspace(r).search('قابل', 20)).toHaveLength(1); // the search index is rebuilt on restore
});

it('a Phase 1 backup (four tables, no Phase 2 entries) still restores', async () => {
  await openChat('ws-bp2', '201001234567', { text: 'قديم' });
  const m = await workspace('ws-bp2').exportSnapshot('2026-10-24');
  const key = 'backups/ws-bp2/2026-10-24/manifest.json';
  const legacy = { ...m, schemaVersion: 4, tables: { contacts: m.tables.contacts, conversations: m.tables.conversations, messages: m.tables.messages, message_status_events: m.tables.message_status_events } };
  await env.BACKUPS.put(key, JSON.stringify(legacy));
  const res = await workspace('ws-bp2-restore').importSnapshot('backups/ws-bp2/2026-10-24/');
  expect(res.ok).toBe(true);
  expect(await rows('ws-bp2-restore', 'SELECT preview FROM messages')).toEqual([{ preview: 'قديم' }]);
});
