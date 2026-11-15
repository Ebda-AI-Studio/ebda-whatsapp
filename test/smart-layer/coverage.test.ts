import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import corpusJson from '../../assistant/help-corpus.generated.json';
import registryJson from '../../assistant/registry.generated.json';
import { applyBaseline, baselineGrowth, guardOutcome, violationId } from '../../foundation/ratchet';
import { chatAdapter } from '../../src/core/smart-layer/adapter';
import { toViolations, uncovered } from '../../src/core/smart-layer/coverage';
import { DEEP_LINK_ONLY, ownedElsewhere } from '../../src/core/smart-layer/deep-link-only';
import { ASSISTANT_CAPABILITY } from '../../src/routes/assistant';

const OWNED_ELSEWHERE = ownedElsewhere(ASSISTANT_CAPABILITY);
import type { HelpCorpus } from '../../src/core/smart-layer/help-index';
import { viewOf, type StoredCap } from '../../src/core/smart-layer/registry';
import baselineJson from '../../capabilities/baselines/assistant-tools.json';
import { noHelp } from './harness';

const REGISTRY = viewOf(registryJson as unknown as StoredCap[]);
const TOOLS = chatAdapter({ env, ws: undefined as never, callApi: async () => ({ status: 200, json: {} }), registry: REGISTRY, corpus: corpusJson as unknown as HelpCorpus, assistantCapability: 'assistant.ebda-assistant', help: noHelp, ai: { run: async () => ({}) } }).tools();
const BASELINE = (baselineJson as { ids: string[] }).ids;
const cap = (id: string, policy: 'free' | 'preview' | 'confirm' | 'forbidden' = 'free', status: 'live' | 'in-pr' | 'planned' = 'live') => ({ id, status, policy });

describe('uncovered()', () => {
  it('a live confirm capability with no tool fails', () => {
    expect(uncovered([cap('x.send', 'confirm')], [], {}, {})).toEqual(['x.send']);
    expect(uncovered([cap('x.send', 'confirm')], [{ capabilityId: 'x.send' }], {}, {})).toEqual([]);
  });
  it('a deep-link-only or engine-owned capability passes without a tool', () => {
    expect(uncovered([cap('a.secret', 'confirm'), cap('b.engine')], [], { 'a.secret': { secret: 'card' } }, { 'b.engine': 'the engine' })).toEqual([]);
  });
  it('forbidden capabilities and ones that are not live yet need no tool', () => {
    expect(uncovered([cap('op.kill', 'forbidden'), cap('p.later', 'confirm', 'planned'), cap('q.soon', 'free', 'in-pr')], [], {}, {})).toEqual([]);
  });
});

describe('the baseline of capabilities without a tool (shrink-only)', () => {
  const current = uncovered(REGISTRY.caps.values(), TOOLS, DEEP_LINK_ONLY, OWNED_ELSEWHERE);
  it('every capability without a tool is in the baseline, and every baseline id still needs fixing: a live capability without a tool is a new failure', () => {
    const r = guardOutcome(applyBaseline(toViolations(current), BASELINE));
    expect(r.failures).toEqual([]);
  });
  it('a planned -> live flip without a tool is a NEW violation (it is not in the baseline)', () => {
    const flipped = toViolations([...current, 'agent.some-new-capability']);
    expect(applyBaseline(flipped, BASELINE).fresh.map(violationId)).toEqual(['capability-without-tool|agent.some-new-capability']);
  });
  it('the baseline cannot grow: a PR baseline with an id the base lacks is reported', () => {
    expect(baselineGrowth([...BASELINE, 'new.id'], BASELINE)).toEqual(['new.id']);
    expect(baselineGrowth(BASELINE.slice(1), BASELINE)).toEqual([]);
  });
  it('the guard sees a real gap: removing a tool puts its capability back in the failures', () => {
    const without = TOOLS.filter((t) => t.name !== 'send_text');
    expect(uncovered(REGISTRY.caps.values(), without, DEEP_LINK_ONLY, OWNED_ELSEWHERE)).toContain('inbox.send-text');
  });
});

describe('deep-link-only entries are decisions, not escapes', () => {
  it('every entry names a live capability and a reason, and none has a tool of its own', () => {
    for (const [id, why] of Object.entries(DEEP_LINK_ONLY)) {
      expect(REGISTRY.caps.get(id)?.status, id).toBe('live');
      expect(Object.values(why)[0], id).toBeTruthy();
      expect(TOOLS.some((t) => t.capabilityId === id && t.policy !== 'free'), `${id} has a write tool AND is listed as deep-link only`).toBe(false);
    }
    for (const id of Object.keys(OWNED_ELSEWHERE)) expect(REGISTRY.caps.has(id), id).toBe(true);
  });
  it('the secret-only entries are exactly the credential, token, key, OAuth and card capabilities', () => {
    expect(Object.entries(DEEP_LINK_ONLY).filter(([, v]) => 'secret' in v).map(([k]) => k).sort()).toEqual(['access.integrator-tokens', 'access.signin', 'agent.provider-byok', 'numbers.connect', 'wallet.card-topup']);
  });
});
