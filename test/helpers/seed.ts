import { runInDurableObject } from 'cloudflare:test';
import { workspace } from './workspace';

/** Bulk-inserts `n` conversations (4 messages each) plus one 2,000-message chat on the newest one. Returns the big chat's id. */
export async function seedConversations(workspaceId: string, n = 5000): Promise<number> {
  return runInDurableObject(workspace(workspaceId), (_i, state) => {
    const sql = state.storage.sql;
    return state.storage.transactionSync(() => {
      const base = Math.floor(Date.now() / 1000) - 6_000;
      let last = 0;
      for (let i = 0; i < n; i++) {
        const c = sql.exec<{ id: number }>('INSERT INTO contacts (wa_id, profile_name, last_inbound_at) VALUES (?, ?, ?) RETURNING id', `2011${String(i).padStart(8, '0')}`, `عميل ${i}`, base + i).one().id;
        last = sql.exec<{ id: number }>('INSERT INTO conversations (contact_id, last_message_at, unread, assignee_user_id) VALUES (?, ?, ?, ?) RETURNING id', c, base + i, i % 3 === 0 ? 1 : 0, i % 7 === 0 ? 'u1' : null).one().id;
        for (let m = 0; m < 4; m++) {
          sql.exec("INSERT INTO messages (wamid, conversation_id, direction, type, preview, body, created_at, updated_at) VALUES (?, ?, 'in', 'text', ?, ?, ?, ?)", `seed.${i}.${m}`, last, `رسالة ${m}`, `رسالة ${m}`, (base + i) * 1000 + m, 0);
        }
      }
      for (let m = 0; m < 2000; m++) {
        sql.exec("INSERT INTO messages (wamid, conversation_id, direction, type, preview, body, created_at, updated_at) VALUES (?, ?, 'out', 'text', 'x', 'x', ?, 0)", `big.${m}`, last, m);
      }
      return last;
    });
  });
}
