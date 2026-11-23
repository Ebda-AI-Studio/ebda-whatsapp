import { searchFoldOf } from './search-fold';

/**
 * Brings one contact's row in `contacts_fts` in line with `contacts.profile_name` (rowid = contacts.id). Call it after EVERY write of
 * profile_name, inside the same transaction; a contact with no usable name has no row.
 */
export function indexContactName(sql: SqlStorage, contactId: number): void {
  const name = sql.exec<{ profile_name: string | null }>('SELECT profile_name FROM contacts WHERE id = ?', contactId).toArray()[0]?.profile_name;
  sql.exec('DELETE FROM contacts_fts WHERE rowid = ?', contactId);
  const t = name ? searchFoldOf(sql)(name) : '';
  if (t) sql.exec('INSERT INTO contacts_fts (rowid, name) VALUES (?, ?)', contactId, t);
}

/** The index and the table must agree again: rebuilt from scratch (after a restore, or for rows older than the index). */
export function rebuildContactIndex(sql: SqlStorage): void {
  sql.exec('DELETE FROM contacts_fts');
  const fold = searchFoldOf(sql);
  for (const c of sql.exec<{ id: number; profile_name: string }>('SELECT id, profile_name FROM contacts WHERE profile_name IS NOT NULL').toArray()) {
    const t = fold(c.profile_name);
    if (t) sql.exec('INSERT INTO contacts_fts (rowid, name) VALUES (?, ?)', c.id, t);
  }
}
