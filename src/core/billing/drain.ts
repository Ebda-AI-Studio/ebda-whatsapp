import { alert } from '../observability';

/**
 * M-178. A daily pass that read `LIMIT 100` and stopped left every row after the hundredth for ever. `drainKeyset` reads page after page until a page comes back short,
 * with a KEYSET cursor (the last row's sort key), so a row that keeps failing is visited once per pass and never starves the rows behind it. A pass is bounded:
 * after `maxBatches` pages it stops, raises `billing_pass_backlog` (P1) and the next daily pass continues from the top of whatever is still undone (the queries select
 * by state, so finished rows drop out by themselves).
 */
export const DRAIN_PAGE = 100;
export const DRAIN_MAX_BATCHES = 50;

export async function drainKeyset<R, C>(a: {
  name: string;
  pageSize: number;
  maxBatches?: number;
  /** The next page after `after` (null = the first page), at most `pageSize` rows, ordered by the cursor. */
  page: (after: C | null) => Promise<R[]>;
  cursorOf: (row: R) => C;
  handle: (row: R) => Promise<void>;
}): Promise<{ handled: number; capped: boolean }> {
  const max = a.maxBatches ?? DRAIN_MAX_BATCHES;
  let after: C | null = null;
  let handled = 0;
  for (let i = 0; i < max; i++) {
    const rows = await a.page(after);
    for (const r of rows) {
      try {
        await a.handle(r);
      } catch (err) {
        alert('billing_pass_row_failed', { severity: 'P1', pass: a.name, error: err instanceof Error ? err.name : 'error' }); // one bad row never stops the rows behind it
      }
      handled++;
    }
    if (rows.length < a.pageSize) return { handled, capped: false };
    after = a.cursorOf(rows[rows.length - 1]!);
  }
  alert('billing_pass_backlog', { severity: 'P1', pass: a.name, handled });
  return { handled, capped: true };
}

export type PassOpts = { page?: number; maxBatches?: number };
