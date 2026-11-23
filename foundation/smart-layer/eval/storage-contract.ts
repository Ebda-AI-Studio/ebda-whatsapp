/**
 * Executable `SmartLayerStorage` contract. Import it in each adapter's test suite against the REAL storage path (Store `StoreDO`
 * SQLite, Chat `WorkspaceDO` SQLite) and pass your test runner's `describe` / `it` / `expect`:
 *
 *   runSmartLayerStorageContract(() => realStorage(), { describe, it, expect });
 *
 * It proves the atomicity the engine relies on (single winner under concurrent calls), the order of `claimApproval` checks, the expiry
 * boundary, store isolation, and that erasure / retention reach EVERY record type. It has no imports from a test framework.
 */
import type { ApprovalRecord, AppliedRecord, AuditRow, DecisionRow, PreviewRecord, SmartLayerStorage, TurnRow } from '../types';

type Ex = { toBe(x: unknown): void; toEqual(x: unknown): void; toBeNull(): void; toBeGreaterThan(x: number): void };
export interface ContractHarness {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
  expect(v: unknown): Ex;
}

const N = 8;
const draft = { summary: { ar: 'م', en: 's' }, rows: [{ label: { ar: 'ا', en: 'a' }, before: '+201001234567', after: 'x' }], affectedCount: 1, etag: 'e', payload: {} };
const preview = (o: Partial<PreviewRecord> = {}): PreviewRecord => ({ id: 'pv1', storeId: 's1', userId: 'u1', turnId: 't', tool: 'x', args: {}, draft, policy: 'preview', reasons: [], undo: 'reversible', payloadHash: 'ph', createdAt: 100, releaseId: 'r', status: 'open', ...o });
const approval = (o: Partial<ApprovalRecord> = {}): ApprovalRecord => ({ id: 'ap1', storeId: 's1', userId: 'u1', previewId: 'pv1', tokenHash: 'th', payloadHash: 'ph', expiresAt: 1000, status: 'pending', createdAt: 100, ...o });
const applied = (o: Partial<AppliedRecord> = {}): AppliedRecord => ({ id: 'ar1', storeId: 's1', previewId: 'pv1', userId: 'u1', tool: 'x', inverse: { tool: 'x', args: {} }, undo: 'reversible', etagAfter: 'e', appliedAt: 100, ...o });
const turn = (o: Partial<TurnRow> = {}): TurnRow => ({ id: 't1', storeId: 's1', conversationId: 'c1', userId: 'u1', role: 'merchant', maskedText: 'hi', at: 100, releaseId: 'r', ...o });
const audit = (o: Partial<AuditRow> = {}): AuditRow => ({ id: 'a1', storeId: 's1', userId: 'u1', turnId: 't1', at: 100, releaseId: 'r', maskedPrompt: 'p', maskedOutput: 'o', rails: {}, toolsOffered: [], toolCalls: [], outcome: 'answered', inputTokens: 1, outputTokens: 1, model: 'm', ...o });
const decision = (o: Partial<DecisionRow> = {}): DecisionRow => ({ approvalId: 'ap1', storeId: 's1', decider: 'u1', decision: 'confirmed', at: 100, ...o });

export function runSmartLayerStorageContract(make: () => SmartLayerStorage, h: ContractHarness): void {
  const { describe, it, expect } = h;
  const count = <T,>(xs: T[], v: T): number => xs.filter((x) => x === v).length;

  describe('SmartLayerStorage contract: atomic compare-and-set', () => {
    it('claimApproval: exactly one winner among concurrent claims', async () => {
      const s = make();
      await s.putApproval(approval());
      const rs = await Promise.all(Array.from({ length: N }, () => s.claimApproval('s1', 'ap1', 'th', 'ph', 500)));
      expect(count(rs, 'claimed')).toBe(1);
      expect(count(rs, 'used')).toBe(N - 1);
    });
    it('claimApproval: checks run missing, then mismatch (token or payload), then used, then expired', async () => {
      const s = make();
      await s.putApproval(approval());
      expect(await s.claimApproval('s1', 'nope', 'th', 'ph', 500)).toBe('missing');
      expect(await s.claimApproval('s1', 'ap1', 'WRONG', 'ph', 500)).toBe('mismatch');
      expect(await s.claimApproval('s1', 'ap1', 'th', 'WRONG', 500)).toBe('mismatch');
      expect(await s.claimApproval('s1', 'ap1', 'th', 'ph', 500)).toBe('claimed');
      expect(await s.claimApproval('s1', 'ap1', 'WRONG', 'ph', 500)).toBe('mismatch'); // wrong token is mismatch even after use
      expect(await s.claimApproval('s1', 'ap1', 'th', 'ph', 500)).toBe('used');
    });
    it('claimApproval: the expiry boundary is expiresAt <= now (inclusive)', async () => {
      const s = make();
      await s.putApproval(approval({ id: 'a-edge', expiresAt: 100 }));
      await s.putApproval(approval({ id: 'a-ok', expiresAt: 100 }));
      expect(await s.claimApproval('s1', 'a-ok', 'th', 'ph', 99)).toBe('claimed');
      expect(await s.claimApproval('s1', 'a-edge', 'th', 'ph', 100)).toBe('expired');
      expect(await s.claimApproval('s1', 'a-edge', 'th', 'ph', 50)).toBe('used'); // an expired approval is closed for good
    });
    it('closeApproval: exactly one winner, and a claimed or rejected approval cannot be claimed again', async () => {
      const s = make();
      await s.putApproval(approval());
      const rs = await Promise.all(Array.from({ length: N }, () => s.closeApproval('s1', 'ap1', 'rejected')));
      expect(count(rs, true)).toBe(1);
      expect(await s.claimApproval('s1', 'ap1', 'th', 'ph', 500)).toBe('used');
      await s.putApproval(approval({ id: 'ap2' }));
      expect(await s.claimApproval('s1', 'ap2', 'th', 'ph', 500)).toBe('claimed');
      expect(await s.closeApproval('s1', 'ap2', 'rejected')).toBe(false);
    });
    it('transitionPreview: exactly one winner among concurrent open to applying moves, and a wrong from state loses', async () => {
      const s = make();
      await s.putPreview(preview());
      const rs = await Promise.all(Array.from({ length: N }, () => s.transitionPreview('s1', 'pv1', 'open', 'applying')));
      expect(count(rs, true)).toBe(1);
      expect(await s.transitionPreview('s1', 'pv1', 'open', 'applied')).toBe(false);
      expect((await s.getPreview('s1', 'pv1'))!.status).toBe('applying');
    });
    it('markUndone: exactly one winner among concurrent calls; unmarkUndone rolls back once and lets markUndone win again', async () => {
      const s = make();
      await s.putApplied(applied());
      const rs = await Promise.all(Array.from({ length: N }, () => s.markUndone('s1', 'ar1', 500)));
      expect(count(rs, true)).toBe(1);
      const un = await Promise.all(Array.from({ length: N }, () => s.unmarkUndone('s1', 'ar1')));
      expect(count(un, true)).toBe(1);
      expect(await s.unmarkUndone('s1', 'ar1')).toBe(false);
      expect(await s.markUndone('s1', 'ar1', 600)).toBe(true);
    });
  });

  describe('SmartLayerStorage contract: isolation and reads', () => {
    it('another store never sees or changes a record (ids are scoped by store)', async () => {
      const s = make();
      await s.putApproval(approval());
      await s.putPreview(preview());
      await s.putApplied(applied());
      expect(await s.getApproval('s2', 'ap1')).toBeNull();
      expect(await s.getPreview('s2', 'pv1')).toBeNull();
      expect(await s.getApplied('s2', 'ar1')).toBeNull();
      expect(await s.claimApproval('s2', 'ap1', 'th', 'ph', 500)).toBe('missing');
      expect(await s.closeApproval('s2', 'ap1', 'rejected')).toBe(false);
      expect(await s.transitionPreview('s2', 'pv1', 'open', 'applying')).toBe(false);
      expect(await s.markUndone('s2', 'ar1', 500)).toBe(false);
      expect((await s.getPreview('s1', 'pv1'))!.status).toBe('open');
    });
    it('getApproval reads back what putApproval wrote (consistent read)', async () => {
      const s = make();
      await s.putApproval(approval());
      expect(await s.getApproval('s1', 'ap1')).toEqual(approval());
    });
    it('loadTurns is scoped to store and conversation and returns the last N oldest-first', async () => {
      const s = make();
      for (let i = 0; i < 5; i++) await s.appendTurn(turn({ id: `t${i}`, at: 100 + i, maskedText: `m${i}` }));
      await s.appendTurn(turn({ id: 'other-conv', conversationId: 'c2' }));
      await s.appendTurn(turn({ id: 'other-store', storeId: 's2' }));
      expect((await s.loadTurns('s1', 'c1', 3)).map((t) => t.maskedText)).toEqual(['m2', 'm3', 'm4']);
    });
    it('loadAudits is scoped to the store and honours sinceMs and limit', async () => {
      const s = make();
      await s.appendAudit(audit({ id: 'old', at: 10 }));
      await s.appendAudit(audit({ id: 'new', at: 200 }));
      await s.appendAudit(audit({ id: 'other', storeId: 's2', at: 200 }));
      expect((await s.loadAudits('s1', 100, 10)).map((r) => r.id)).toEqual(['new']);
    });
    it('bump counts inside the window, slides, and keys are independent', async () => {
      const s = make();
      expect(await s.bump('k', 1000, 0)).toBe(1);
      expect(await s.bump('k', 1000, 500)).toBe(2);
      expect(await s.bump('other', 1000, 500)).toBe(1);
      expect(await s.bump('k', 1000, 1600)).toBe(1);
    });
  });

  describe('SmartLayerStorage contract: erasure and retention reach every record type', () => {
    const seed = async (s: SmartLayerStorage, store: string, user: string, at: number) => {
      const id = `${store}-${user}-${at}`;
      await s.appendTurn(turn({ id: `t-${id}`, storeId: store, userId: user, at }));
      await s.appendAudit(audit({ id: `a-${id}`, storeId: store, userId: user, at }));
      await s.putPreview(preview({ id: `pv-${id}`, storeId: store, userId: user, createdAt: at }));
      await s.putApplied(applied({ id: `ar-${id}`, storeId: store, userId: user, appliedAt: at }));
      await s.putApproval(approval({ id: `ap-${id}`, storeId: store, userId: user, createdAt: at }));
      await s.recordDecision(decision({ approvalId: `ap-${id}`, storeId: store, decider: user, at }));
      return id;
    };
    const present = async (s: SmartLayerStorage, store: string, id: string): Promise<string[]> => {
      const out: string[] = [];
      if ((await s.loadTurns(store, 'c1', 100)).some((t) => t.id === `t-${id}`)) out.push('turn');
      if ((await s.loadAudits(store, 0, 100)).some((r) => r.id === `a-${id}`)) out.push('audit');
      if (await s.getPreview(store, `pv-${id}`)) out.push('preview');
      if (await s.getApplied(store, `ar-${id}`)) out.push('applied');
      if (await s.getApproval(store, `ap-${id}`)) out.push('approval');
      if ((await s.loadDecisions(store, `ap-${id}`)).length) out.push('decision');
      return out;
    };
    const ALL = ['turn', 'audit', 'preview', 'applied', 'approval', 'decision'];
    it('eraseStore removes every record type of that store and nothing of another', async () => {
      const s = make();
      const a = await seed(s, 's1', 'u1', 100);
      const b = await seed(s, 's2', 'u1', 100);
      await s.eraseStore('s1');
      expect(await present(s, 's1', a)).toEqual([]);
      expect(await present(s, 's2', b)).toEqual(ALL);
    });
    it('eraseUser removes that user turns, audits, previews, applied records, approvals and decisions, and nobody else', async () => {
      const s = make();
      const mine = await seed(s, 's1', 'u1', 100);
      const theirs = await seed(s, 's1', 'u2', 100);
      const otherStore = await seed(s, 's2', 'u1', 100);
      await s.eraseUser('s1', 'u1');
      expect(await present(s, 's1', mine)).toEqual([]);
      expect(await present(s, 's1', theirs)).toEqual(ALL);
      expect(await present(s, 's2', otherStore)).toEqual(ALL);
    });
    it('purgeBefore removes every old record type, keeps newer ones, and returns the number removed', async () => {
      const s = make();
      const old = await seed(s, 's1', 'u1', 100);
      const fresh = await seed(s, 's1', 'u1', 900);
      const n = await s.purgeBefore(500);
      expect(await present(s, 's1', old)).toEqual([]);
      expect(await present(s, 's1', fresh)).toEqual(ALL);
      expect(n).toBe(ALL.length);
    });
  });
}
