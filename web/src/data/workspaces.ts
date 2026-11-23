import { z } from 'zod';
import type { InboxSource } from './source';

/** CHAT-SA contract (plan 2026-11-23): a standalone workspace id is `sw_` + 26 base32 chars; a Store id is a UUID. The server decides again on every request. */
export const STANDALONE_ID = /^sw_[a-z2-7]{26}$/;
export const isStandaloneId = (id: string | null | undefined): id is string => !!id && STANDALONE_ID.test(id);

const mineResponse = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(['owner', 'staff']), kind: z.literal('standalone') })).max(50),
  canCreate: z.boolean(),
  needsInvite: z.boolean(),
});
export type MineResponse = z.infer<typeof mineResponse>;

export type CreateResult =
  | { ok: true; id: string }
  | { ok: false; error: 'standalone_off' | 'invite_required' | 'invite_invalid' | 'rate_limited' | 'failed' };

type Fetch = typeof fetch;
const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

/** GET /workspaces/mine: the standalone workspaces this person belongs to, and whether they may create one. Throws on any failure (the caller shows a retry). */
export async function fetchMine(baseUrl: string, getToken: () => Promise<string>, f: Fetch = fetch): Promise<MineResponse> {
  const res = await f(`${baseUrl}/api/v1/workspaces/mine`, { headers: headers(await getToken()) });
  if (!res.ok) throw new Error(`mine_${res.status}`);
  return mineResponse.parse(await res.json());
}

/** POST /workspaces. 409 `already_owns_workspace` is a success for the person (they already have one: open it). */
export async function createWorkspace(baseUrl: string, getToken: () => Promise<string>, input: { name: string; inviteCode?: string }, f: Fetch = fetch): Promise<CreateResult> {
  let res: Response;
  try {
    res = await f(`${baseUrl}/api/v1/workspaces`, { method: 'POST', headers: headers(await getToken()), body: JSON.stringify({ name: input.name, country: 'EG', ...(input.inviteCode ? { inviteCode: input.inviteCode } : {}) }) });
  } catch {
    return { ok: false, error: 'failed' };
  }
  const body = (await res.json().catch(() => null)) as { id?: unknown; error?: unknown; message?: unknown } | null;
  if (res.status === 201 && typeof body?.id === 'string') return { ok: true, id: body.id };
  if (res.status === 409 && body?.error === 'already_owns_workspace' && typeof body.id === 'string') return { ok: true, id: body.id };
  if (res.status === 429) return { ok: false, error: 'rate_limited' };
  if (res.status === 403 && (body?.message === 'standalone_off' || body?.message === 'invite_required' || body?.message === 'invite_invalid')) return { ok: false, error: body.message };
  return { ok: false, error: 'failed' };
}

/** A standalone workspace has no Store: flag the source and drop every API that talks to one (the routes would only 404). Used by the live source and by tests. */
export function markStandalone(source: InboxSource): void {
  source.standalone = true;
  delete source.catalog; delete source.proactiveRecs; delete source.team;
}
