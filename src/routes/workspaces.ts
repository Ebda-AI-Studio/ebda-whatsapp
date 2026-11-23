import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import type { AuthVars } from '../core/identity/middleware';
import { clientKey } from '../core/request-guards';
import { subjectHash } from '../core/erasure';
import { recordAudit } from '../core/audit';
import { alert } from '../core/observability';
import { createStandaloneWorkspace, type CreateStandaloneResult } from '../core/workspace-registry';
import { inviteHash, standaloneMode } from '../core/standalone/invites';

type E = { Bindings: Env; Variables: AuthVars };
/** /api/v1/workspaces/*: routes of a PERSON (not of one workspace), mounted behind requirePerson (CHAT-SA-3, CHAT-SA-8). */
export const workspacesRoutes = new Hono<E>();

const DAY_MS = 86_400_000;
const PER_USER_PER_DAY = 3;
const PER_IP_PER_DAY = 10;

/** Name: control characters stripped, then trimmed, 1..100. Country: Egypt only tonight (EGP wallet + InstaPay). */
export const createWorkspaceBody = z.object({
  name: z.string().max(400).transform((s) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim()).pipe(z.string().min(1).max(100)),
  country: z.literal('EG'),
  inviteCode: z.string().max(64).optional(),
}).strict();

async function ownedWorkspaceId(env: Env, userId: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT m.workspace_id AS id FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND m.role = 'owner' AND m.status = 'active' AND w.kind = 'standalone' LIMIT 1").bind(userId).first<{ id: string }>();
  return r?.id ?? null;
}

workspacesRoutes.get('/workspaces/mine', async (c) => {
  const p = c.get('principal');
  const mode = standaloneMode(c.env);
  try {
    const { results } = await c.env.DB.prepare("SELECT w.id AS id, w.name AS name, m.role AS role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND m.status = 'active' AND w.kind = 'standalone' ORDER BY w.created_at, w.id LIMIT 50")
      .bind(p.userId).all<{ id: string; name: string; role: 'owner' | 'staff' }>();
    const owns = results.some((r) => r.role === 'owner');
    return c.json({ items: results.map((r) => ({ id: r.id, name: r.name, role: r.role, kind: 'standalone' as const })), canCreate: mode !== 'off' && !owns, needsInvite: mode === 'invite' });
  } catch {
    return c.json({ error: 'unavailable', message: 'membership_unavailable' }, 503);
  }
});

workspacesRoutes.post('/workspaces', async (c) => {
  const p = c.get('principal');
  const mode = standaloneMode(c.env);
  if (mode === 'off') return c.json({ error: 'forbidden', message: 'standalone_off' }, 403);

  // Rate limit FIRST and on every attempt (a refused one counts too), so a guessed-code loop is bounded as well. IP is hashed under the erasure key, never stored plain.
  const ipHash = await subjectHash(c.env, 'workspace-create', clientKey(c.req.header('cf-connecting-ip') ?? null));
  if (!ipHash) return c.json({ error: 'unavailable', message: 'creation_unavailable' }, 503);
  const now = Date.now();
  try {
    await c.env.DB.prepare('INSERT INTO workspace_creations (user_id, ip_hash, at) VALUES (?, ?, ?)').bind(p.userId, ipHash, now).run();
    const [u, i] = await c.env.DB.batch<{ n: number }>([
      c.env.DB.prepare('SELECT count(*) AS n FROM workspace_creations WHERE user_id = ? AND at > ?').bind(p.userId, now - DAY_MS),
      c.env.DB.prepare('SELECT count(*) AS n FROM workspace_creations WHERE ip_hash = ? AND at > ?').bind(ipHash, now - DAY_MS),
    ]);
    if ((u!.results[0]?.n ?? 0) > PER_USER_PER_DAY || (i!.results[0]?.n ?? 0) > PER_IP_PER_DAY) {
      c.header('retry-after', '3600');
      return c.json({ error: 'rate_limited' }, 429);
    }
  } catch {
    return c.json({ error: 'unavailable', message: 'creation_unavailable' }, 503); // fail closed: no counter, no creation
  }

  const b = createWorkspaceBody.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: 'invalid_request', message: b.error.issues[0]?.path.join('.') || 'body' }, 400);

  // One owned standalone workspace per person: answer with the existing id (the web opens it) before any invite is touched, so a code is never burnt on a refusal.
  const existing = await ownedWorkspaceId(c.env, p.userId).catch(() => null);
  if (existing) return c.json({ error: 'already_owns_workspace', id: existing }, 409);

  let codeHash: string | null = null;
  if (mode === 'invite') {
    if (!b.data.inviteCode) return c.json({ error: 'forbidden', message: 'invite_required' }, 403);
    codeHash = await inviteHash(c.env, b.data.inviteCode);
    if (!codeHash) return c.json({ error: 'forbidden', message: 'invite_invalid' }, 403); // malformed (or no key): the one message for every bad code
  }

  let outcome: CreateStandaloneResult;
  try {
    outcome = await createStandaloneWorkspace(c.env, { ownerUserId: p.userId, name: b.data.name, country: b.data.country, inviteCodeHash: codeHash }, now);
  } catch (e) {
    alert('standalone_create_failed', { reason: e instanceof Error ? e.message.slice(0, 80) : 'unknown' });
    return c.json({ error: 'unavailable', message: 'creation_unavailable' }, 503);
  }
  if (outcome.status === 'invite_invalid') return c.json({ error: 'forbidden', message: 'invite_invalid' }, 403);
  if (outcome.status === 'already_owns') {
    const owned = await ownedWorkspaceId(c.env, p.userId).catch(() => null);
    return owned ? c.json({ error: 'already_owns_workspace', id: owned }, 409) : c.json({ error: 'unavailable', message: 'creation_unavailable' }, 503);
  }
  const id = outcome.id;
  await recordAudit(c.env, { workspaceId: id, actor: p.userId, role: 'owner', action: 'workspace.created', targetType: 'workspace', targetId: id, detail: { mode, invite: codeHash !== null }, status: 201 }, now);
  if (codeHash) await recordAudit(c.env, { workspaceId: id, actor: p.userId, role: 'owner', action: 'invite.consumed', targetType: 'invite', targetId: codeHash, status: 201 }, now);
  return c.json({ id, name: b.data.name }, 201);
});
