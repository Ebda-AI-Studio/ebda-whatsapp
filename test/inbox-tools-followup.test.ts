import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { DO_MIGRATIONS } from '../src/core/do-migrations';
import { exec, openChat, rows, workspace } from './helpers/workspace';

// The v48 fold (wa#92 review follow-up): conversation tags have been lower-cased at write time since A27; rows written before that are folded once.
// Found by content, not by number: the number moves when another branch's migration lands first (the guard in guards.test.ts keeps the numbering contiguous).
const fold = DO_MIGRATIONS.find((sql) => sql.includes('INSERT OR IGNORE INTO conversation_tags'));

it('migration v48 folds mixed-case conversation tags into one lower-case row and keeps every conversation link', async () => {
  expect(fold).toBeTruthy();
  const ws = 'ws-fold1';
  const a = await openChat(ws, '201001234501', { text: 'a' });
  const b = await openChat(ws, '201001234502', { text: 'b' });
  const c = await openChat(ws, '201001234503', { text: 'c' });
  // the state before A27: nothing lower-cased
  await exec(ws, `INSERT INTO conversation_tags (conversation_id, tag) VALUES (${a}, 'VIP'), (${a}, 'vip'), (${b}, 'VIP'), (${c}, 'Shipping'), (${c}, 'شحن'), (${c}, ' Late ')`);
  await runInDurableObject(workspace(ws), (_i, state) => { state.storage.sql.exec(fold!); });
  const tags = await rows<{ conversation_id: number; tag: string }>(ws, 'SELECT conversation_id, tag FROM conversation_tags ORDER BY conversation_id, tag');
  expect(tags).toEqual([
    { conversation_id: a, tag: 'vip' }, // VIP and vip are one row now
    { conversation_id: b, tag: 'vip' }, // a lone VIP is renamed, not lost
    { conversation_id: c, tag: 'late' }, { conversation_id: c, tag: 'shipping' }, { conversation_id: c, tag: 'شحن' },
  ]);
  // running it again changes nothing (a replay is safe)
  await runInDurableObject(workspace(ws), (_i, state) => { state.storage.sql.exec(fold!); });
  expect(await rows(ws, 'SELECT count(*) AS n FROM conversation_tags')).toEqual([{ n: 5 }]);
});

it('a tag written through the product is lower-cased already (nothing new needs folding)', async () => {
  const ws = 'ws-fold2';
  const conv = await openChat(ws, '201001234504', { text: 'a' });
  await workspace(ws).setTags(conv, ['VIP', 'vip', ' Late ']);
  expect((await rows<{ tag: string }>(ws, 'SELECT tag FROM conversation_tags ORDER BY tag')).map((r) => r.tag)).toEqual(['late', 'vip']);
});
