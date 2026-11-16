import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { recordWorkspaceOwner } from '../src/core/campaigns/new-cap';
import { OWNER_FREE_TURNS_PER_DAY, chatQuota } from '../src/core/smart-layer/quota';

// WA-OWNER-FREE-1 (#115): the assistant's free turns are budgeted per OWNER across workspaces, not only per workspace.
const W = (n: number) => `00000000-0000-4000-8000-0000000076${String(n).padStart(2, '0')}`;
const NOW = 1_800_000_000_000;
// each workspace's own journal counter: always far below its per-workspace cap, so only the owner budget can refuse
const ws = { assistantHold: async () => 'held' as const, assistantSettle: async () => 'ok' };
const quota = () => chatQuota({ bump: async () => 1 }, ws, env);
const turn = (storeId: string, at = NOW) => quota().assertTurn({ storeId, now: at, conversationId: 'c' } as never);

describe('WA-OWNER-FREE-1 free assistant turns per owner', () => {
  it('N workspaces of one owner share one daily free-turn budget', async () => {
    const [a, b, c] = [W(1), W(2), W(3)];
    for (const w of [a, b, c]) await recordWorkspaceOwner(env, w, 'owner-shared', NOW);
    const each = OWNER_FREE_TURNS_PER_DAY / 3;
    for (const w of [a, b, c]) for (let i = 0; i < each; i++) await turn(w);
    await expect(turn(a)).rejects.toThrow('free_cap');
    await expect(turn(b)).rejects.toThrow('free_cap');
    await expect(turn(c)).rejects.toThrow('free_cap');
  });

  it('another owner is not affected, and the budget frees up as the window rolls', async () => {
    const [x, y] = [W(4), W(5)];
    await recordWorkspaceOwner(env, x, 'owner-x', NOW);
    await recordWorkspaceOwner(env, y, 'owner-y', NOW);
    for (let i = 0; i < OWNER_FREE_TURNS_PER_DAY; i++) await turn(x);
    await expect(turn(x)).rejects.toThrow('free_cap');
    await turn(y); // a different owner
    await turn(x, NOW + 86_400_001); // a day later
  });

  it('a workspace with no owner row is its own owner (never locked out, never unmetered)', async () => {
    const z = W(6);
    for (let i = 0; i < OWNER_FREE_TURNS_PER_DAY; i++) await turn(z);
    await expect(turn(z)).rejects.toThrow('free_cap');
  });
});
