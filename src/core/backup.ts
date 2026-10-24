export const BACKUP_TABLES = ['contacts', 'conversations', 'messages', 'message_status_events'] as const;
export type BackupTable = (typeof BACKUP_TABLES)[number];
export type BackupManifest = {
  workspaceId: string;
  date: string;
  schemaVersion: number;
  tables: Record<BackupTable, { rows: number; sha256: string }>;
};

export const BACKUP_HOUR_LOCAL = 2;
export const BACKUP_TIME_ZONE = 'Africa/Cairo';

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function toNdjson(rows: Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

/** Epoch ms of the next whole hour `hour` in `timeZone` strictly after `now` (DST-safe: walks hour by hour). */
export function nextLocalHour(now: number, hour: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
  let t = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
  for (let i = 0; i < 48; i++, t += 3_600_000) {
    if (Number(fmt.format(t)) === hour) return t;
  }
  throw new Error('no matching hour within 48 h');
}

export function backupPrefix(workspaceId: string, date: string): string {
  return `backups/${workspaceId}/${date}/`;
}
