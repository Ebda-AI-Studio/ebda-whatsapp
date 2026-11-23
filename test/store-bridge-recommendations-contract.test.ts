import { describe, expect, it } from 'vitest';
import fx from '../vectors/bridge-recs-v1.json';
import { createServiceBindingBridge } from '../src/addons/ebda/store-bridge';

/** Caller side of `getRecommendations`: the Store's recorded answers (vendored byte for byte, sha pinned in vendored-artifacts.test.ts) must pass our adapter unchanged. */
type Case = { name: string; method: string; args: unknown[]; expect: unknown };
describe('getRecommendations contract vectors', () => {
  for (const c of fx.cases as Case[]) {
    it(c.name, async () => {
      const calls: unknown[][] = [];
      const binding = new Proxy({}, { get: (_t, m: string) => async (...a: unknown[]) => { calls.push([m, ...a]); return c.expect; } });
      const bridge = createServiceBindingBridge({ STORE_BRIDGE: binding } as never) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      expect(await bridge[c.method]!(...c.args)).toEqual(c.expect);
      expect(calls).toEqual([[c.method, ...c.args]]);
    });
  }
});
