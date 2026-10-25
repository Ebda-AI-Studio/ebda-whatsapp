import { env, runInDurableObject } from 'cloudflare:test';
import { configureCampaignWallet, NO_WALLET, type CampaignWallet, type WalletSettleOutcome } from '../../src/core/campaigns/wallet';
import type { CampaignSteps } from '../../src/core/campaigns/workflows';
import { exec, rows, workspace } from './workspace';

export const PN = 'pn-x';
export const MARKETING = JSON.stringify([{ type: 'BODY', text: 'أهلا {{1}} عرض {{2}}' }]);

export async function seedTemplate(ws: string, o: { name?: string; category?: string; status?: string; components?: string } = {}) {
  await exec(ws, "INSERT OR REPLACE INTO templates (name, language, category, status, components, updated_at) VALUES (?, 'ar', ?, ?, ?, 1)", o.name ?? 'promo', o.category ?? 'MARKETING', o.status ?? 'APPROVED', o.components ?? MARKETING);
}

/** n contacts with a consent on record: 201010000000, 201010000001, ... (ids ascending in that order). */
export async function seedContacts(ws: string, n: number, o: { consent?: boolean; tag?: string; names?: boolean } = {}) {
  for (let i = 0; i < n; i++) {
    const waId = `2010${String(10000000 + i)}`;
    await exec(ws, 'INSERT INTO contacts (wa_id, profile_name, consent_source, consent_at) VALUES (?, ?, ?, ?)', waId, o.names === false ? null : `Cust ${i}`, o.consent === false ? null : 'import:x.csv', o.consent === false ? null : 1);
    if (o.tag) await exec(ws, 'INSERT INTO contact_tags (contact_id, tag) SELECT id, ? FROM contacts WHERE wa_id = ?', o.tag, waId);
  }
}

export const PARAMS = [{ kind: 'name', fallback: 'عميلنا' }, { kind: 'text', value: '50%' }] as const;

export async function makeCampaign(ws: string, o: { criteria?: unknown; dailySendLimit?: number; params?: unknown } = {}) {
  const r = await workspace(ws).createCampaign({
    name: 'Eid sale', template: { name: 'promo', language: 'ar' }, params: (o.params ?? PARAMS) as never,
    audience: { criteria: (o.criteria ?? { everyone: true }) as never }, phoneNumberId: PN, actor: 'u1', ...(o.dailySendLimit ? { dailySendLimit: o.dailySendLimit } : {}),
  });
  if (!r.ok) throw new Error(`campaign not created: ${r.reason} ${r.message ?? ''}`);
  return r.campaign;
}

export const setPageSize = (ws: string, n: number) => runInDurableObject(workspace(ws), (inst) => { (inst as unknown as { campaignPageSize: number }).campaignPageSize = n; });
export const setTier = (ws: string, tier: number) => exec(ws, 'INSERT OR REPLACE INTO number_limits (phone_number_id, tier, mps, tokens, tokens_at, alerted_at) VALUES (?, ?, 80, 80, 0, 0)', PN, tier);
/**
 * Stops this workspace's alarm from running its due tasks, so a test can look at (and move) the scheduler rows it just created.
 * Tests still run tasks themselves with runDueTasks().
 */
export const holdAlarm = (ws: string) => runInDurableObject(workspace(ws), (inst) => { (inst as unknown as { alarm: () => Promise<void> }).alarm = async () => undefined; });
export const campaignMessages = (ws: string) => rows<{ idempotency_key: string; status: string; error_reason: string | null }>(ws, "SELECT idempotency_key, status, error_reason FROM messages WHERE idempotency_key LIKE 'camp:%' ORDER BY id");

export type WalletCalls = { estimate: string[]; reserve: { ref: string; minor: number }[]; settle: { ref: string; outcome: WalletSettleOutcome }[] };
/** Installs a recording wallet for the test; `refuse` decides per reserve call; `perMessage` is the piaster estimate. */
export function installWallet(o: { perMessage?: number; refuse?: (ref: string, n: number) => boolean; reserveDelayMs?: number; onReserve?: () => Promise<void>; failSettleTimes?: number } = {}): WalletCalls {
  const calls: WalletCalls = { estimate: [], reserve: [], settle: [] };
  let settleFails = o.failSettleTimes ?? 0;
  const wallet: CampaignWallet = {
    walletEstimate: (_ws, category) => { calls.estimate.push(category); return o.perMessage ?? 0; },
    walletReserve: async (_ws, ref, minor) => {
      calls.reserve.push({ ref, minor });
      if (o.reserveDelayMs) await new Promise((r) => setTimeout(r, o.reserveDelayMs));
      await o.onReserve?.();
      return o.refuse?.(ref, calls.reserve.length) ? { ok: false, reason: 'wallet_empty' } : { ok: true };
    },
    walletSettle: async (_ws, ref, outcome) => {
      if (settleFails-- > 0) throw new Error('wallet down');
      calls.settle.push({ ref, outcome });
    },
  };
  configureCampaignWallet(wallet);
  return calls;
}
export const resetWallet = () => configureCampaignWallet(NO_WALLET);

type StepCb = (ctx: unknown) => Promise<unknown>;
/** A stand-in for the Workflows step API. `replay` names the steps whose callback is run twice (a step that succeeded, then was retried). */
export function fakeStep(o: { replay?: string[]; onSleep?: (name: string, ts: number) => Promise<void> } = {}) {
  const sleeps: { name: string; ts: number }[] = [];
  const done: string[] = [];
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      const cb = (typeof a === 'function' ? a : b) as StepCb;
      done.push(name);
      const first = await cb({});
      if (o.replay?.includes(name)) await cb({});
      return first;
    },
    sleepUntil: async (name: string, ts: Date | number) => {
      const t = ts instanceof Date ? ts.getTime() : ts;
      sleeps.push({ name, ts: t });
      await o.onSleep?.(name, t);
    },
  };
  return { step: step as never, sleeps, done };
}

export const stepsOf = (ws: string): CampaignSteps => workspace(ws) as unknown as CampaignSteps;

/** Registers the workspace in the control plane (public routes check it before touching a Durable Object). */
export const registerWorkspace = (ws: string) => env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(ws, ws, Date.now()).run();
