import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Ruling WA-IDLE-1: wa.ebda.app is idle after load except for ONE intentional connection, the realtime inbox socket. Every timer
// that talks to the network runs only while something is actually in flight (a pending payment, a running import or campaign) and
// stops itself. This scan fails when a new unconditional poll appears, which is what would keep the page from ever settling.
const root = new URL('../web/src', import.meta.url).pathname;
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}
const files = walk(root);
const rel = (p: string) => p.slice(root.length + 1);

// file -> why it may poll (each is guarded: it returns early unless the thing it waits for is pending / running)
const POLLS: Record<string, string> = {
  'components/MoneySurfaces.tsx': 'credit top-up: only while a payment is pending',
  'components/WalletScreen.tsx': 'wallet top-up and package order: only while one is pending (two intervals)',
  'components/CampaignsScreen.tsx': 'only while a campaign is running or scheduled',
  'components/ContactsScreen.tsx': 'only while an import is pending or running',
};

describe('wa.ebda.app settles after load (Ruling WA-IDLE-1)', () => {
  it('every setInterval is on the allowlist and guarded by an early return', () => {
    const seen: Record<string, number> = {};
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (!/\bsetInterval\(/.test(l) || /^\s*(\/\/|\*)/.test(l)) return;
        const name = rel(f);
        seen[name] = (seen[name] ?? 0) + 1;
        const before = lines.slice(Math.max(0, i - 3), i).join('\n');
        expect(before, `${name}:${i + 1} polls without a guard`).toMatch(/if \(!.*\) return;/);
      });
    }
    expect(Object.keys(seen).sort()).toEqual(Object.keys(POLLS).sort());
    expect(seen['components/WalletScreen.tsx']).toBe(2);
  });

  it('there is exactly one long-lived connection: the realtime socket opened by connectRealtime from main.tsx', () => {
    const strays = files
      .filter((f) => rel(f) !== 'data/api.ts')
      .flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => /\b(WebSocket|EventSource)\b/.test(l) && !/^\s*(\/\/|\*)/.test(l)).map((l) => `${rel(f)}: ${l.trim().slice(0, 60)}`));
    expect(strays, 'a connection opened outside connectRealtime').toEqual([]);
    const api = readFileSync(join(root, 'data/api.ts'), 'utf8');
    expect((api.match(/new Socket\(o\.url/g) ?? []).length).toBe(1);
    expect(readFileSync(join(root, 'main.tsx'), 'utf8')).toMatch(/connectRealtime\(\{/);
    // it never stops trying (backoff caps at 30 s), and sign-out / no-seat / view-as stop it
    expect(api).toMatch(/Math\.min\(30_000/);
  });
});
