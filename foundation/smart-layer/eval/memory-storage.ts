/**
 * In-memory `SmartLayerStorage` with the atomicity the real adapters must provide (CAS transitions, single-use claim). Used by the
 * engine tests and by adapter tests as the reference behaviour. Not for production: nothing is persisted.
 */
import type { ApprovalRecord, AppliedRecord, AuditRow, DecisionRow, PreviewRecord, SmartLayerStorage, TurnRow } from '../types';

export function memoryStorage(): SmartLayerStorage & { turns: TurnRow[]; audits: AuditRow[]; previews: Map<string, PreviewRecord>; applied: Map<string, AppliedRecord>; approvals: Map<string, ApprovalRecord>; decisions: DecisionRow[] } {
  const turns: TurnRow[] = [];
  const audits: AuditRow[] = [];
  const previews = new Map<string, PreviewRecord>();
  const applied = new Map<string, AppliedRecord>();
  const approvals = new Map<string, ApprovalRecord>();
  const decisions: DecisionRow[] = [];
  const hits = new Map<string, number[]>();
  const key = (s: string, id: string) => `${s}|${id}`;
  return {
    turns, audits, previews, applied, approvals, decisions,
    async appendTurn(r) { turns.push(r); },
    async loadTurns(storeId, conversationId, limit) { return turns.filter((t) => t.storeId === storeId && t.conversationId === conversationId).slice(-limit); },
    async appendAudit(r) { audits.push(r); },
    async putPreview(r) { previews.set(key(r.storeId, r.id), r); },
    async getPreview(s, id) { return previews.get(key(s, id)) ?? null; },
    async transitionPreview(s, id, from, to) {
      const p = previews.get(key(s, id));
      if (!p || p.status !== from) return false;
      p.status = to;
      return true;
    },
    async putApplied(r) { applied.set(key(r.storeId, r.id), r); },
    async getApplied(s, id) { return applied.get(key(s, id)) ?? null; },
    async markUndone(s, id, now) {
      const a = applied.get(key(s, id));
      if (!a || a.undoneAt !== undefined) return false;
      a.undoneAt = now;
      return true;
    },
    async unmarkUndone(s, id) {
      const a = applied.get(key(s, id));
      if (!a || a.undoneAt === undefined) return false;
      delete a.undoneAt;
      return true;
    },
    async putApproval(r) { approvals.set(key(r.storeId, r.id), r); },
    async getApproval(s, id) { return approvals.get(key(s, id)) ?? null; },
    async closeApproval(s, id, to) {
      const a = approvals.get(key(s, id));
      if (!a || a.status !== 'pending') return false;
      a.status = to;
      return true;
    },
    async claimApproval(s, id, tokenHash, payloadHash, now) {
      // No await between the read and the write: the claim is atomic in a single-threaded runtime, like a SQL UPDATE .. WHERE status = 'pending'.
      const a = approvals.get(key(s, id));
      if (!a) return 'missing';
      if (a.tokenHash !== tokenHash || a.payloadHash !== payloadHash) return 'mismatch';
      if (a.status !== 'pending') return 'used';
      if (a.expiresAt <= now) { a.status = 'expired'; return 'expired'; }
      a.status = 'used';
      return 'claimed';
    },
    async recordDecision(r) { decisions.push(r); },
    async loadDecisions(s, approvalId) { return decisions.filter((d) => d.storeId === s && d.approvalId === approvalId); },
    async loadAudits(s, since, limit) { return audits.filter((r) => r.storeId === s && r.at >= since).slice(-limit); },
    async bump(k, windowMs, now) {
      const arr = (hits.get(k) ?? []).filter((t) => t > now - windowMs);
      arr.push(now);
      hits.set(k, arr);
      return arr.length;
    },
    async eraseStore(storeId) {
      for (const arr of [turns, audits, decisions] as Array<Array<{ storeId: string }>>) for (let i = arr.length - 1; i >= 0; i--) if (arr[i]!.storeId === storeId) arr.splice(i, 1);
      for (const mp of [previews, applied, approvals] as Array<Map<string, { storeId: string }>>) for (const [k, v] of mp) if (v.storeId === storeId) mp.delete(k);
    },
    async eraseUser(storeId, userId) {
      for (const arr of [turns, audits] as Array<Array<{ storeId: string; userId: string }>>) for (let i = arr.length - 1; i >= 0; i--) if (arr[i]!.storeId === storeId && arr[i]!.userId === userId) arr.splice(i, 1);
      for (let i = decisions.length - 1; i >= 0; i--) if (decisions[i]!.storeId === storeId && decisions[i]!.decider === userId) decisions.splice(i, 1);
      for (const mp of [previews, applied, approvals] as Array<Map<string, { storeId: string; userId: string }>>) for (const [k, v] of mp) if (v.storeId === storeId && v.userId === userId) mp.delete(k);
    },
    async purgeBefore(cutoff) {
      let n = 0;
      for (const [arr, ts] of [[turns, 'at'], [audits, 'at'], [decisions, 'at']] as unknown as Array<[Array<Record<string, number>>, string]>) for (let i = arr.length - 1; i >= 0; i--) if (arr[i]![ts]! < cutoff) { arr.splice(i, 1); n++; }
      for (const [mp, ts] of [[previews, 'createdAt'], [applied, 'appliedAt'], [approvals, 'createdAt']] as unknown as Array<[Map<string, Record<string, number>>, string]>) for (const [k, v] of mp) if (v[ts]! < cutoff) { mp.delete(k); n++; }
      return n;
    },
  };
}
