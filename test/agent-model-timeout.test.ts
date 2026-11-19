import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { stubGraph } from './helpers/graph';
import { useStoreLink } from './helpers/store-link';
import { rows, workspace } from './helpers/workspace';

// A stalled model call (live eval 2026-11-19: one Workers AI call took 81 s) is abandoned after `modelTimeoutMs`, retried ONCE, and only then handed to a person.
useStoreLink();
const agent = useAgent({ modelTimeoutMs: 80 });
const W = (n: number) => `00000000-0000-4000-8000-0000000097${String(n).padStart(2, '0')}`;
const model = (steps: ConstructorParameters<typeof ScriptedProvider>[0]) => (agent.model = new ScriptedProvider(steps)) as ScriptedProvider;
const outcome = async (ws: string) => (await rows<{ outcome: string }>(ws, 'SELECT outcome FROM agent_turns ORDER BY rowid DESC LIMIT 1'))[0]?.outcome;
beforeEach(() => configureSessionCheck(async () => false));
afterEach(() => configureSessionCheck(null));

describe('model call timeout', () => {
  it('a call that stalls past the limit is retried once and the retry answers', async () => {
    const ws = W(1);
    const pn = await agentWorkspace(ws);
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
    const m = model([{ text: 'late answer', delayMs: 400 }, { text: 'تمام، أهلاً بيك' }]);
    const g = stubGraph();
    await say(ws, pn, text('أهلاً'), g);
    g.restore();
    expect(m.callCount).toBe(2);
    expect(await outcome(ws)).toBe('reply');
  });
  it('two stalls in a row hand the customer to a person (one retry, not a loop)', async () => {
    const ws = W(2);
    const pn = await agentWorkspace(ws);
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
    const m = model([{ text: 'late 1', delayMs: 400 }, { text: 'late 2', delayMs: 400 }, { text: 'never used' }]);
    const g = stubGraph();
    await say(ws, pn, text('أهلاً'), g);
    g.restore();
    expect(m.callCount).toBe(2);
    expect(await outcome(ws)).toBe('handoff:provider_error');
  });
});
