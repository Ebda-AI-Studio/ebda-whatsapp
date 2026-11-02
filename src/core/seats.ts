/**
 * Team seats by explicit assignment (Ruling WA-SEATS-1, plan P1b). The package allows `memberLimit` people on the team, the owner included, so
 * `memberLimit - 1` staff seats. A staff member works only while they hold a seat (deny by default). Membership itself lives in the Store; this table
 * only says WHICH of its staff the owner chose to seat. The owner never has a row and always counts as one.
 *
 * Order is the tie-break when a downgrade leaves more rows than seats: the earliest assignments keep working (by assigned_at, then user_id), the later
 * ones become 'over_limit' and are refused until the owner removes someone or upgrades. Nothing is deleted by a downgrade.
 */
import { memberLimit } from './billing/entitlements';

type Sql = DurableObjectStorage['sql'];
export type SeatState = 'seated' | 'over_limit' | 'none';
export type SeatRow = { userId: string; assignedAt: number; assignedBy: string; state: Exclude<SeatState, 'none'> };

const ordered = (sql: Sql) => sql.exec<{ user_id: string; assigned_at: number; assigned_by: string }>('SELECT user_id, assigned_at, assigned_by FROM seats ORDER BY assigned_at, user_id').toArray();

/** Every seat row with whether it is inside the package's capacity. */
export function listSeats(sql: Sql, now: number = Date.now()): { limit: number; seats: SeatRow[] } {
  const limit = memberLimit(sql, now);
  const cap = limit - 1;
  return { limit, seats: ordered(sql).map((r, i) => ({ userId: r.user_id, assignedAt: r.assigned_at, assignedBy: r.assigned_by, state: i < cap ? 'seated' : 'over_limit' })) };
}

/** The seat of one user. No row = 'none'. A plan that is not in effect has limit 1 (the owner alone), so every row is over_limit: deny by default. */
export function seatState(sql: Sql, userId: string, now: number = Date.now()): SeatState {
  return listSeats(sql, now).seats.find((s) => s.userId === userId)?.state ?? 'none';
}

export type AssignResult = { ok: true; created: boolean } | { ok: false; reason: 'seat_limit'; limit: number };

/** Seats `userId` if the package has room (idempotent: an existing row is kept as it is). Run inside one DO call, so two assigns cannot both take the last seat. */
export function assignSeat(sql: Sql, userId: string, by: string, now: number = Date.now()): AssignResult {
  const { limit, seats } = listSeats(sql, now);
  if (seats.some((s) => s.userId === userId)) return { ok: true, created: false };
  if (seats.length >= limit - 1) return { ok: false, reason: 'seat_limit', limit };
  sql.exec('INSERT INTO seats (user_id, assigned_at, assigned_by) VALUES (?, ?, ?)', userId, now, by);
  return { ok: true, created: true };
}

export function removeSeat(sql: Sql, userId: string): boolean {
  return sql.exec('DELETE FROM seats WHERE user_id = ?', userId).rowsWritten > 0;
}

/** Drops seat rows whose user is no longer an active member in the Store (removed or suspended), so a leaver never holds a seat. Returns how many were dropped. */
export function pruneSeats(sql: Sql, activeStaffIds: readonly string[]): number {
  const keep = new Set(activeStaffIds);
  let dropped = 0;
  for (const r of ordered(sql)) if (!keep.has(r.user_id)) dropped += removeSeat(sql, r.user_id) ? 1 : 0;
  return dropped;
}

/** True when more staff hold rows than the package now has seats (after a downgrade). */
export function seatsOverLimit(sql: Sql, now: number = Date.now()): boolean {
  return listSeats(sql, now).seats.some((s) => s.state === 'over_limit');
}
