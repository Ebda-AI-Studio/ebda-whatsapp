/**
 * The assistant's journal in the workspace Durable Object SQLite (SL-CHAT-1). Every method runs synchronously inside the DO, so a
 * read-then-write is atomic (single-threaded, no await between) and the status compare-and-sets are one `UPDATE .. WHERE status = from`
 * with the changed-row count checked. `test/smart-layer/storage-contract.test.ts` runs the engine's executable storage contract against
 * this class through the real DO RPC path.
 */
import type { ApprovalRecord, AppliedRecord, AuditRow, DecisionRow, PreviewRecord, SmartLayerStorage, TurnRow } from '../../../foundation/smart-layer/types';

type Sql = DurableObjectStorage['sql'];
type Tx = <R>(f: () => R) => R;

const changed = (sql: Sql, q: string, ...b: unknown[]): number => sql.exec(q, ...(b as never[])).rowsWritten > 0 ? 1 : 0;
const rows = <T extends Record<string, SqlStorageValue>>(sql: Sql, q: string, ...b: unknown[]): T[] => sql.exec<T>(q, ...(b as never[])).toArray();
const one = <T extends Record<string, SqlStorageValue>>(sql: Sql, q: string, ...b: unknown[]): T | undefined => rows<T>(sql, q, ...b)[0];

/** Synchronous implementation; `rpc-storage.ts` wraps it for the Worker side. Method names are the RPC op names. */
export function doStorageOps(sql: Sql, tx: Tx) {
  return {
    appendTurn(r: TurnRow): void {
      sql.exec('INSERT INTO sl_turns (id, store_id, thread_id, user_id, role, masked_text, at, release_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', r.id, r.storeId, r.conversationId, r.userId, r.role, r.maskedText, r.at, r.releaseId);
    },
    loadTurns(storeId: string, conversationId: string, limit: number): TurnRow[] {
      const n = Math.max(0, Math.floor(limit));
      return rows<{ id: string; store_id: string; thread_id: string; user_id: string; role: string; masked_text: string; at: number; release_id: string }>(sql,
        'SELECT id, store_id, thread_id, user_id, role, masked_text, at, release_id FROM (SELECT * FROM sl_turns WHERE store_id = ? AND thread_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq', storeId, conversationId, n)
        .map((t) => ({ id: t.id, storeId: t.store_id, conversationId: t.thread_id, userId: t.user_id, role: t.role as TurnRow['role'], maskedText: t.masked_text, at: t.at, releaseId: t.release_id }));
    },
    appendAudit(r: AuditRow): void {
      sql.exec('INSERT INTO sl_audit (id, store_id, user_id, at, json) VALUES (?, ?, ?, ?, ?)', r.id, r.storeId, r.userId, r.at, JSON.stringify(r));
    },
    loadAudits(storeId: string, sinceMs: number, limit: number): AuditRow[] {
      return rows<{ json: string }>(sql, 'SELECT json FROM (SELECT seq, json FROM sl_audit WHERE store_id = ? AND at >= ? ORDER BY seq DESC LIMIT ?) ORDER BY seq', storeId, sinceMs, Math.max(0, Math.floor(limit))).map((r) => JSON.parse(r.json) as AuditRow);
    },
    putPreview(r: PreviewRecord): void {
      const { status, ...rest } = r;
      sql.exec('INSERT OR REPLACE INTO sl_previews (id, store_id, user_id, created_at, status, json) VALUES (?, ?, ?, ?, ?, ?)', r.id, r.storeId, r.userId, r.createdAt, status, JSON.stringify(rest));
    },
    getPreview(storeId: string, id: string): PreviewRecord | null {
      const r = one<{ status: string; json: string }>(sql, 'SELECT status, json FROM sl_previews WHERE store_id = ? AND id = ?', storeId, id);
      return r ? ({ ...(JSON.parse(r.json) as object), status: r.status } as PreviewRecord) : null;
    },
    transitionPreview(storeId: string, id: string, from: PreviewRecord['status'], to: PreviewRecord['status']): boolean {
      return changed(sql, 'UPDATE sl_previews SET status = ? WHERE store_id = ? AND id = ? AND status = ?', to, storeId, id, from) === 1;
    },
    putApplied(r: AppliedRecord): void {
      const { undoneAt, ...rest } = r;
      sql.exec('INSERT OR REPLACE INTO sl_applied (id, store_id, user_id, applied_at, undone_at, json) VALUES (?, ?, ?, ?, ?, ?)', r.id, r.storeId, r.userId, r.appliedAt, undoneAt ?? null, JSON.stringify(rest));
    },
    getApplied(storeId: string, id: string): AppliedRecord | null {
      const r = one<{ undone_at: number | null; json: string }>(sql, 'SELECT undone_at, json FROM sl_applied WHERE store_id = ? AND id = ?', storeId, id);
      return r ? ({ ...(JSON.parse(r.json) as object), ...(r.undone_at !== null ? { undoneAt: r.undone_at } : {}) } as AppliedRecord) : null;
    },
    markUndone(storeId: string, id: string, now: number): boolean {
      return changed(sql, 'UPDATE sl_applied SET undone_at = ? WHERE store_id = ? AND id = ? AND undone_at IS NULL', now, storeId, id) === 1;
    },
    unmarkUndone(storeId: string, id: string): boolean {
      return changed(sql, 'UPDATE sl_applied SET undone_at = NULL WHERE store_id = ? AND id = ? AND undone_at IS NOT NULL', storeId, id) === 1;
    },
    putApproval(r: ApprovalRecord): void {
      sql.exec('INSERT OR REPLACE INTO sl_approvals (id, store_id, user_id, preview_id, token_hash, payload_hash, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', r.id, r.storeId, r.userId, r.previewId, r.tokenHash, r.payloadHash, r.expiresAt, r.status, r.createdAt);
    },
    getApproval(storeId: string, id: string): ApprovalRecord | null {
      const r = one<{ id: string; store_id: string; user_id: string; preview_id: string; token_hash: string; payload_hash: string; expires_at: number; status: string; created_at: number }>(sql, 'SELECT * FROM sl_approvals WHERE store_id = ? AND id = ?', storeId, id);
      return r ? { id: r.id, storeId: r.store_id, userId: r.user_id, previewId: r.preview_id, tokenHash: r.token_hash, payloadHash: r.payload_hash, expiresAt: r.expires_at, status: r.status as ApprovalRecord['status'], createdAt: r.created_at } : null;
    },
    closeApproval(storeId: string, id: string, to: 'rejected' | 'expired'): boolean {
      return changed(sql, "UPDATE sl_approvals SET status = ? WHERE store_id = ? AND id = ? AND status = 'pending'", to, storeId, id) === 1;
    },
    claimApproval(storeId: string, id: string, tokenHash: string, payloadHash: string, now: number): 'claimed' | 'used' | 'expired' | 'mismatch' | 'missing' {
      return tx(() => {
        const a = one<{ token_hash: string; payload_hash: string; status: string; expires_at: number }>(sql, 'SELECT token_hash, payload_hash, status, expires_at FROM sl_approvals WHERE store_id = ? AND id = ?', storeId, id);
        if (!a) return 'missing';
        if (a.token_hash !== tokenHash || a.payload_hash !== payloadHash) return 'mismatch';
        if (a.status !== 'pending') return 'used';
        if (a.expires_at <= now) {
          sql.exec("UPDATE sl_approvals SET status = 'expired' WHERE store_id = ? AND id = ? AND status = 'pending'", storeId, id);
          return 'expired';
        }
        const won = changed(sql, "UPDATE sl_approvals SET status = 'used' WHERE store_id = ? AND id = ? AND status = 'pending' AND token_hash = ? AND payload_hash = ? AND expires_at > ?", storeId, id, tokenHash, payloadHash, now);
        return won === 1 ? 'claimed' : 'used';
      });
    },
    recordDecision(r: DecisionRow): void {
      sql.exec('INSERT INTO sl_decisions (approval_id, store_id, decider, decision, reason, at) VALUES (?, ?, ?, ?, ?, ?)', r.approvalId, r.storeId, r.decider, r.decision, r.reason ?? null, r.at);
    },
    loadDecisions(storeId: string, approvalId: string): DecisionRow[] {
      return rows<{ approval_id: string; store_id: string; decider: string; decision: string; reason: string | null; at: number }>(sql, 'SELECT approval_id, store_id, decider, decision, reason, at FROM sl_decisions WHERE store_id = ? AND approval_id = ? ORDER BY seq', storeId, approvalId)
        .map((d) => ({ approvalId: d.approval_id, storeId: d.store_id, decider: d.decider, decision: d.decision as DecisionRow['decision'], ...(d.reason !== null ? { reason: d.reason } : {}), at: d.at }));
    },
    bump(key: string, windowMs: number, now: number): number {
      return tx(() => {
        sql.exec('DELETE FROM sl_counters WHERE key = ? AND at <= ?', key, now - windowMs);
        sql.exec('INSERT INTO sl_counters (key, at) VALUES (?, ?)', key, now);
        return one<{ n: number }>(sql, 'SELECT count(*) AS n FROM sl_counters WHERE key = ?', key)!.n;
      });
    },
    eraseStore(storeId: string): void {
      tx(() => {
        for (const t of ['sl_turns', 'sl_audit', 'sl_previews', 'sl_applied', 'sl_approvals', 'sl_decisions']) sql.exec(`DELETE FROM ${t} WHERE store_id = ?`, storeId);
        sql.exec("DELETE FROM sl_counters WHERE key LIKE ? ESCAPE '\\'", `%${storeId.replace(/[\\%_]/g, '\\$&')}%`);
      });
    },
    eraseUser(storeId: string, userId: string): void {
      tx(() => {
        for (const t of ['sl_turns', 'sl_audit', 'sl_previews', 'sl_applied', 'sl_approvals']) sql.exec(`DELETE FROM ${t} WHERE store_id = ? AND user_id = ?`, storeId, userId);
        sql.exec('DELETE FROM sl_decisions WHERE store_id = ? AND decider = ?', storeId, userId);
      });
    },
    purgeBefore(cutoff: number): number {
      return tx(() => {
        let n = 0;
        for (const [t, col] of [['sl_turns', 'at'], ['sl_audit', 'at'], ['sl_previews', 'created_at'], ['sl_applied', 'applied_at'], ['sl_approvals', 'created_at'], ['sl_decisions', 'at']] as const) {
          n += one<{ n: number }>(sql, `SELECT count(*) AS n FROM ${t} WHERE ${col} < ?`, cutoff)!.n;
          sql.exec(`DELETE FROM ${t} WHERE ${col} < ?`, cutoff);
        }
        sql.exec('DELETE FROM sl_counters WHERE at < ?', cutoff); // rate-limit hits, not records: not counted
        return n;
      });
    },
  };
}
export type SlOps = ReturnType<typeof doStorageOps>;
export type SlOp = keyof SlOps;
export const SL_OPS: readonly SlOp[] = ['appendTurn', 'loadTurns', 'appendAudit', 'loadAudits', 'putPreview', 'getPreview', 'transitionPreview', 'putApplied', 'getApplied', 'markUndone', 'unmarkUndone', 'putApproval', 'getApproval', 'closeApproval', 'claimApproval', 'recordDecision', 'loadDecisions', 'bump', 'eraseStore', 'eraseUser', 'purgeBefore'];

/** Worker-side SmartLayerStorage over the DO RPC `smartLayer(op, args)`. */
export function rpcStorage(call: (op: SlOp, args: unknown[]) => Promise<unknown>): SmartLayerStorage {
  return Object.fromEntries(SL_OPS.map((op) => [op, (...args: unknown[]) => call(op, args)])) as unknown as SmartLayerStorage;
}
