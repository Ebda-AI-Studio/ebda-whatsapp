import { env } from 'cloudflare:test';
import { createInstapayRequest, storeProof } from '../../src/core/billing/instapay';
import { setAutoMode, type AutoMode } from '../../src/core/billing/instapay-auto';
import { configureSessionCheck } from '../../src/core/identity/session';
import { exec, seedNumber } from './workspace';

export const PAYEE = { handle: 'ebda@instapay', name: 'Ebda AI Studio', qrUrl: 'https://media.ebda.app/platform/instapay-qr.jpg' };
export const HOUR = 3_600_000;
let counter = 0;
/** A fresh 12-digit bank reference per call. */
export const nextRef = () => `7${String(++counter).padStart(7, '0')}${String(Math.floor(Math.random() * 9000) + 1000)}`;

/** Cairo wall-clock date and time of an instant (what the receipt prints). */
export function cairoParts(ms: number): { date: string; time: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

export type Answer = Record<string, unknown>;
/** The model's answer for a receipt that matches `amountMinor` exactly and is one hour old. */
export function goodAnswer(amountMinor: number, o: { now?: number; ageMs?: number; reference?: string } = {}): Answer {
  const { date, time } = cairoParts((o.now ?? Date.now()) - (o.ageMs ?? HOUR));
  return { amount: (amountMinor / 100).toFixed(2), recipientHandle: PAYEE.handle, date, time, reference: o.reference ?? nextRef(), looksEdited: false, confidence: 0.95 };
}
/** An env whose `AI` returns the scripted answer ("throw" = the model fails). Everything else (D1, DOs, R2, the dedupe D1) is the real binding. */
export function aiEnv(answer: Answer | 'throw' | ((req: number) => Answer), base: typeof env = env): typeof env {
  let calls = 0;
  const e = { ...base, AI: { run: async () => {
    calls++;
    if (answer === 'throw') throw new Error('model down');
    return { response: JSON.stringify(typeof answer === 'function' ? answer(calls) : answer) };
  } } } as unknown as typeof env;
  (e as unknown as { aiCalls: () => number }).aiCalls = () => calls;
  return e;
}
export const aiCalls = (e: typeof env) => (e as unknown as { aiCalls: () => number }).aiCalls();

export async function seedGold(): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)").run();
  await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at, period_months) VALUES ('gold-yearly', 'Gold yearly', 500000, 300, 1, 1, 12)").run();
}
/** A running paid plan in D1 (what a top-up's first-payment cap is measured against). */
export async function seedSub(ws: string, packageId = 'gold', now = Date.now()): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(ws, ws, now).run();
  await env.DB.prepare("INSERT OR REPLACE INTO workspace_subscriptions (workspace_id, package_id, status, period_start, period_end, version, updated_at, source, queued_periods) VALUES (?, ?, 'active', ?, ?, 1, ?, 'purchase', 0)").bind(ws, packageId, now - 1000, now + 25 * 24 * HOUR, now).run();
}
export const setMode = async (mode: AutoMode) => { await setAutoMode(env, { mode, actor: 'op-test', reason: 'test setup' }); };
export const sessionOk = () => configureSessionCheck(async () => false);

let seq = 0;
const png = (tag: string) => { const b = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(`${tag}-${Date.now()}-${++seq}-${Math.random()}`)]); return b.buffer.slice(0) as ArrayBuffer; };

/** A request with its proof uploaded (the auto attempt triggered by the upload runs with `e`; use mode off to keep it for the test to call). */
export async function request(ws: string, kind: 'package' | 'topup', o: { amountMinor?: number; packageId?: string; e?: typeof env; bytes?: ArrayBuffer } = {}): Promise<{ id: string; amountMinor: number }> {
  if (!ws.startsWith('sw_')) await seedNumber(`pn-ia-${ws.slice(-8)}`, ws); // a standalone workspace already exists (createStandaloneWorkspace); seedNumber would insert it as a Store row, which the kind trigger refuses
  const r = await createInstapayRequest(env, { workspaceId: ws, userId: 'merchant-1', sessionId: 's1', input: kind === 'package' ? { kind, packageId: o.packageId ?? 'gold' } : { kind, amountMinor: o.amountMinor ?? 20_000 }, payee: PAYEE });
  if (!r.ok) throw new Error(r.reason);
  // The upload would trigger the auto attempt: keep the mode off while uploading (unless the test passes its own env to exercise the trigger), so the test calls it itself.
  const prior = await env.DB.prepare("SELECT value FROM instapay_auto_settings WHERE key = 'mode'").first<{ value: string }>();
  if (!o.e) await env.DB.prepare("INSERT INTO instapay_auto_settings (key, value, updated_by, updated_at) VALUES ('mode', 'off', 't', 0) ON CONFLICT(key) DO UPDATE SET value = 'off'").run();
  const p = await storeProof(o.e ?? env, { workspaceId: ws, requestId: r.request.id, sessionId: 's1', bytes: o.bytes ?? png('proof'), contentType: 'image/png' });
  if (!o.e && prior) await env.DB.prepare("UPDATE instapay_auto_settings SET value = ? WHERE key = 'mode'").bind(prior.value).run();
  if (!p.ok) throw new Error(p.reason);
  return { id: r.request.id, amountMinor: r.request.amountMinor };
}
export const reqRow = (id: string) => env.DB.prepare('SELECT state, decided_by, granted_at, bank_ref, reverted_at, held_reason FROM instapay_requests WHERE id = ?').bind(id).first<{ state: string; decided_by: string | null; granted_at: number | null; bank_ref: string | null; reverted_at: number | null; held_reason: string | null }>();
export const autoRow = (id: string) => env.DB.prepare('SELECT * FROM instapay_auto_confirmations WHERE request_id = ?').bind(id).first<Record<string, unknown>>();
export const events = async (ws: string) => (await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE workspace_id = ? AND action = 'instapay_auto_confirmed'").bind(ws).first<{ n: number }>())!.n;
export { exec };
