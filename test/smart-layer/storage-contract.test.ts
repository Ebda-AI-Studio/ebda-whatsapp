import { describe, expect, it } from 'vitest';
import { runSmartLayerStorageContract } from '../../foundation/smart-layer/eval/storage-contract';
import { rpcStorage } from '../../src/core/smart-layer/storage-do';
import { rows, workspace } from '../helpers/workspace';

// The engine's executable storage contract, against the REAL workspace Durable Object through its RPC (the path production uses).
// One workspace per case so state never leaks between cases; the contract's own store ids ('s1', 's2') are the isolation under test.
let n = 0;
const make = () => {
  const ws = workspace(`00000000-0000-4000-8000-00000000a${String(++n).padStart(3, '0')}`);
  return rpcStorage((op, args) => ws.smartLayer(op, args));
};
runSmartLayerStorageContract(make, { describe, it, expect: (v) => ({
  toBe: (x) => expect(v).toBe(x), toEqual: (x) => expect(v).toEqual(x), toBeNull: () => expect(v).toBeNull(), toBeGreaterThan: (x) => expect(v as number).toBeGreaterThan(x),
}) });

describe('assistant journal in the workspace DO', () => {
  it('purge is called by the retention purge with a 90-day window', async () => {
    const ws = workspace('00000000-0000-4000-8000-00000000af01');
    const s = rpcStorage((op, args) => ws.smartLayer(op, args));
    const now = Date.now();
    await s.appendTurn({ id: 'old', storeId: 's', conversationId: 'c', userId: 'u', role: 'merchant', maskedText: 'x', at: now - 91 * 86_400_000, releaseId: 'r' });
    await s.appendTurn({ id: 'new', storeId: 's', conversationId: 'c', userId: 'u', role: 'merchant', maskedText: 'x', at: now - 1000, releaseId: 'r' });
    await ws.retentionPurge(now);
    expect(await rows('00000000-0000-4000-8000-00000000af01', 'SELECT id FROM sl_turns')).toEqual([{ id: 'new' }]);
  });
  it('the RPC op list is exactly the storage interface (no op missing, none extra)', async () => {
    const { SL_OPS, doStorageOps } = await import('../../src/core/smart-layer/storage-do');
    const impl = Object.keys(doStorageOps({} as never, ((f: () => unknown) => f()) as never)).sort();
    expect([...SL_OPS].sort()).toEqual(impl);
    expect(impl).not.toContain('eraseEverything');
  });
});
