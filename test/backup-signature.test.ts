import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { canonicalManifest, sha256Hex, signManifest, toNdjson, verifyManifestSignature, type BackupManifest } from '../src/core/backup';
import { workspace } from './helpers/workspace';

// M-174: the manifest carries an HMAC (key from env), not only hashes: a hash proves integrity, an HMAC proves the manifest was written by us.
const KEY = 'backup-hmac-key-for-tests-0123456789abcdef';
const OTHER = 'another-backup-hmac-key-0123456789abcdef';
const M: BackupManifest = { workspaceId: 'ws', date: '2026-10-24', schemaVersion: 3, tables: { contacts: { rows: 1, sha256: 'a'.repeat(64) }, conversations: { rows: 0, sha256: 'b'.repeat(64) }, messages: { rows: 2, sha256: 'c'.repeat(64) }, message_status_events: { rows: 0, sha256: 'd'.repeat(64) } } };

describe('signing', () => {
  it('the canonical form ignores key order and the signature field itself', () => {
    const reordered = JSON.parse(JSON.stringify({ tables: M.tables, schemaVersion: M.schemaVersion, date: M.date, workspaceId: M.workspaceId, signature: 'hmac-sha256:' + '0'.repeat(64) }));
    expect(canonicalManifest(reordered)).toBe(canonicalManifest(M));
  });
  it('verifies under the right key and fails under another key, after a one-field change, and without a signature', async () => {
    const signed = { ...M, signature: await signManifest(M, KEY) };
    expect(signed.signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(await verifyManifestSignature(signed, [KEY])).toBe(true);
    expect(await verifyManifestSignature(signed, [OTHER])).toBe(false);
    expect(await verifyManifestSignature(signed, [OTHER, KEY])).toBe(true); // a rotated key: the previous one still verifies old backups
    expect(await verifyManifestSignature({ ...signed, tables: { ...M.tables, messages: { rows: 3, sha256: 'c'.repeat(64) } } }, [KEY])).toBe(false);
    expect(await verifyManifestSignature(M, [KEY])).toBe(false);
  });
});

const withKey = (ws: string, key: string | undefined, previous?: string) =>
  runInDurableObject(workspace(ws), (inst) => { (inst as unknown as { env: Record<string, unknown> }).env = { ...(inst as unknown as { env: Record<string, unknown> }).env, BACKUP_HMAC_KEY: key, BACKUP_HMAC_KEY_PREVIOUS: previous }; });
const seed = (ws: string) => workspace(ws).ingest({ phoneNumberId: 'pn', inbound: [{ wamid: `wamid.${ws}.1`, from: '201000000001', ts: 1000, type: 'text', text: 'hi' }], statuses: [], receivedAt: 1 });
const manifestOf = async (ws: string) => JSON.parse(await (await env.BACKUPS.get(`backups/${ws}/2026-10-24/manifest.json`))!.text()) as BackupManifest & { signature?: string };
const PREFIX = (ws: string) => `backups/${ws}/2026-10-24/`;

describe('export and restore', () => {
  it('a backup taken with a key is signed, and restores under the same key', async () => {
    await seed('ws-sg1'); await withKey('ws-sg1', KEY);
    const m = await workspace('ws-sg1').exportSnapshot('2026-10-24');
    expect((await manifestOf('ws-sg1')).signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    await withKey('ws-sg1-restore', KEY);
    expect(await workspace('ws-sg1-restore').importSnapshot(PREFIX('ws-sg1'))).toEqual({ ok: true, manifest: m });
  });

  it('an attacker with bucket write access who edits a table AND recomputes the manifest hashes is refused (the hash alone would have passed)', async () => {
    await seed('ws-sg2'); await withKey('ws-sg2', KEY);
    await workspace('ws-sg2').exportSnapshot('2026-10-24');
    const key = `${PREFIX('ws-sg2')}contacts.ndjson`;
    const forged = toNdjson([{ id: 99, wa_id: '201999999999', profile_name: 'attacker' }]);
    await env.BACKUPS.put(key, forged);
    const man = await manifestOf('ws-sg2');
    man.tables.contacts = { rows: 1, sha256: await sha256Hex(forged) }; // a consistent forgery; the old signature stays
    await env.BACKUPS.put(`${PREFIX('ws-sg2')}manifest.json`, JSON.stringify(man));
    await withKey('ws-sg2-restore', KEY);
    expect(await workspace('ws-sg2-restore').importSnapshot(PREFIX('ws-sg2'))).toEqual({ ok: false, reason: 'backup manifest signature invalid' });
  });

  it('removing the signature does not downgrade the check: with a key configured an unsigned manifest is refused', async () => {
    await seed('ws-sg3'); await withKey('ws-sg3', KEY);
    await workspace('ws-sg3').exportSnapshot('2026-10-24');
    const man = await manifestOf('ws-sg3');
    delete man.signature;
    await env.BACKUPS.put(`${PREFIX('ws-sg3')}manifest.json`, JSON.stringify(man));
    await withKey('ws-sg3-restore', KEY);
    expect(await workspace('ws-sg3-restore').importSnapshot(PREFIX('ws-sg3'))).toEqual({ ok: false, reason: 'backup manifest is not signed' });
  });

  it('a signed backup cannot be restored where no key is configured (it would skip the check silently)', async () => {
    await seed('ws-sg4'); await withKey('ws-sg4', KEY);
    await workspace('ws-sg4').exportSnapshot('2026-10-24');
    await withKey('ws-sg4-restore', undefined);
    expect(await workspace('ws-sg4-restore').importSnapshot(PREFIX('ws-sg4'))).toEqual({ ok: false, reason: 'backup manifest is signed but BACKUP_HMAC_KEY is not set' });
  });

  it('an old backup restores under a rotated key while the old one is the previous key', async () => {
    await seed('ws-sg5'); await withKey('ws-sg5', OTHER);
    await workspace('ws-sg5').exportSnapshot('2026-10-24');
    await withKey('ws-sg5-restore', KEY, OTHER);
    expect((await workspace('ws-sg5-restore').importSnapshot(PREFIX('ws-sg5'))).ok).toBe(true);
    await withKey('ws-sg5-restore2', KEY);
    expect(await workspace('ws-sg5-restore2').importSnapshot(PREFIX('ws-sg5'))).toEqual({ ok: false, reason: 'backup manifest signature invalid' });
  });

  it('one workspace\'s valid signed manifest cannot stand in for another\'s or another date\'s (the signature is bound to the folder it is read from)', async () => {
    await seed('ws-sg7a'); await withKey('ws-sg7a', KEY);
    await workspace('ws-sg7a').exportSnapshot('2026-10-24');
    // the substitution: B's folder holds A's table files AND A's signed manifest, so the hashes and the signature are all genuine
    for (const f of (await env.BACKUPS.list({ prefix: PREFIX('ws-sg7a') })).objects) {
      await env.BACKUPS.put(f.key.replace('ws-sg7a', 'ws-sg7b'), await (await env.BACKUPS.get(f.key))!.arrayBuffer());
      await env.BACKUPS.put(f.key.replace('ws-sg7a/2026-10-24', 'ws-sg7a/2026-10-20'), await (await env.BACKUPS.get(f.key))!.arrayBuffer());
    }
    await withKey('ws-sg7-restore', KEY);
    expect(await workspace('ws-sg7-restore').importSnapshot(PREFIX('ws-sg7b'))).toEqual({ ok: false, reason: 'backup manifest is for another workspace or date' });
    expect(await workspace('ws-sg7-restore').importSnapshot('backups/ws-sg7a/2026-10-20/')).toEqual({ ok: false, reason: 'backup manifest is for another workspace or date' });
    expect((await workspace('ws-sg7-restore').importSnapshot(PREFIX('ws-sg7a'))).ok).toBe(true); // the right folder still restores (into another workspace id, as the runbook says)
  });

  it('with no key anywhere, unsigned backups behave as before (existing restores keep working)', async () => {
    await seed('ws-sg6');
    await workspace('ws-sg6').exportSnapshot('2026-10-24');
    expect('signature' in (await manifestOf('ws-sg6'))).toBe(false);
    expect((await workspace('ws-sg6-restore').importSnapshot(PREFIX('ws-sg6'))).ok).toBe(true);
  });
});
