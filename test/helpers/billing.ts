import { env } from 'cloudflare:test';
import type { SendJob } from '../../src/core/send-queue';
import { seedTemplate } from './campaigns';
import { openChat, rows, seedNumber, workspace } from './workspace';

/** One number per workspace (D1 keeps number ownership globally, and a test file shares its D1 across tests). */
export const pn = (ws: string) => `pn-${ws.slice(-8)}`;
export const DAY = 86_400_000;
/** USD micros of the test rate card (Egypt): marketing $0.05, utility $0.02, authentication $0.03, service $0.01. */
export const USD = { marketing: 50_000, utility: 20_000, authentication: 30_000, service: 10_000 } as const;
/** 50 EGP per USD, so at 0% margin: marketing 250, utility 100, authentication 150, service 50 piasters. */
export const FX = 50_000_000;
export const PIASTERS = { marketing: 250, utility: 100, authentication: 150, service: 50 } as const;
export const wamidOf = (n: number | string) => `wamid.bill.${n}`;

type Rate = { country?: string; category: keyof typeof USD | string; usd: number; ver?: number; from?: number };
/** Rate card, FX and a funded number in D1, then the workspace pulls them. `funding: null` leaves the number unregistered (merchant_card by default). */
export async function setupBilling(ws: string, o: { funding?: 'platform_line' | 'merchant_card' | null; rates?: Rate[]; fx?: number; fxFrom?: number; settings?: { margin?: number; limit?: number; vat?: number; from?: number } } = {}): Promise<void> {
  await seedNumber(pn(ws), ws);
  const rates: Rate[] = o.rates ?? (Object.entries(USD) as [string, number][]).map(([category, usd]) => ({ category, usd }));
  const stmts = [
    ...rates.map((r) => env.DB.prepare('INSERT OR IGNORE INTO rate_cards (ver, effective_from, country, category, usd_micros, published_at, actor) VALUES (?, ?, ?, ?, ?, 0, ?)').bind(r.ver ?? 1, r.from ?? 0, r.country ?? 'EG', r.category, r.usd, 'test')),
    env.DB.prepare('INSERT OR IGNORE INTO fx_rates (ver, effective_from, egp_per_usd_micros, buffer_bps, published_at, actor) VALUES (1, ?, ?, 0, 0, ?)').bind(o.fxFrom ?? 0, o.fx ?? FX, 'test'),
  ];
  if (o.settings) {
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO pricing_settings (ver, effective_from, margin_bps, credit_limit_minor, fx_buffer_bps, vat_bps, actor, reason, created_at) VALUES (2, ?, ?, ?, 0, ?, ?, ?, 0)')
      .bind(o.settings.from ?? 0, o.settings.margin ?? 0, o.settings.limit ?? 5000, o.settings.vat ?? 0, 'test', 'test'));
  }
  if (o.funding !== null) stmts.push(env.DB.prepare('INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, ?, 0)').bind(pn(ws), o.funding ?? 'platform_line'));
  await env.DB.batch(stmts);
  await workspace(ws).refreshPricing();
}

export const fund = (ws: string, minor: number, ref = `kashier:fund-${minor}-${Math.random()}`) => workspace(ws).postWallet({ kind: 'topup', netMinor: minor, ref });

let n = 0;
const cid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}${String(Date.now() % 1000).padStart(0, '0')}`.slice(0, 36);

/** An approved template in `category` and a conversation with an open window; returns the conversation id. */
export async function chat(ws: string, category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION' = 'MARKETING', waId = '201001234567'): Promise<number> {
  await seedTemplate(ws, { name: 'tpl-m', category: 'MARKETING' });
  await seedTemplate(ws, { name: 'tpl-u', category: 'UTILITY', components: JSON.stringify([{ type: 'BODY', text: 'hi' }]) });
  await seedTemplate(ws, { name: 'tpl-a', category: 'AUTHENTICATION', components: JSON.stringify([{ type: 'BODY', text: 'code {{1}}' }]) });
  void category;
  return openChat(ws, waId);
}

export const TEMPLATE_BY = { MARKETING: { name: 'tpl-m', params: ['a', 'b'] }, UTILITY: { name: 'tpl-u', params: [] as string[] }, AUTHENTICATION: { name: 'tpl-a', params: ['123456'] } } as const;

/** Queues an API template send (what the inbox does) and returns the job, or the refusal. */
export async function queueTemplate(ws: string, conv: number, category: keyof typeof TEMPLATE_BY) {
  const t = TEMPLATE_BY[category];
  return workspace(ws).queueOutbound(conv, pn(ws), { type: 'template', clientId: cid(), name: t.name, language: 'ar', params: [...t.params] });
}
export async function queueText(ws: string, conv: number, text = 'reply') {
  return workspace(ws).queueOutbound(conv, pn(ws), { type: 'text', clientId: cid(), text });
}
export const jobOf = (r: Awaited<ReturnType<typeof queueTemplate>>): SendJob => {
  if (!r.ok || !r.job) throw new Error(`not queued: ${JSON.stringify(r)}`);
  return r.job;
};

/** Claim + Meta accepted: the message now has a wamid. */
export async function sendOut(ws: string, job: SendJob, wamid: string): Promise<string> {
  const claim = await workspace(ws).claimSend(job);
  if (claim !== 'claimed') return claim;
  await workspace(ws).recordOutbound(job.idempotencyKey, { ok: true, wamid });
  return 'sent';
}

export type Pricing = { billable: boolean | null; pricingModel: string | null; category: string | null; type: string | null };
export const pricing = (category: string, billable = true, model = 'PMP'): Pricing => ({ billable, pricingModel: model, category, type: 'regular' });
export const status = (ws: string, wamid: string, s: 'sent' | 'delivered' | 'read' | 'failed', ts: number, p?: Pricing, errorCode?: number) =>
  workspace(ws).applyStatus({ wamid, status: s, ts, ...(p ? { pricing: p } : {}), ...(errorCode ? { errorCode } : {}) });

export const ledger = (ws: string) => rows<{ kind: string; amount_minor: number; net_minor: number; vat_minor: number; balance_after: number; ref: string; category: string | null; rate_ver: number | null; fx_ver: number | null }>(
  ws, 'SELECT kind, amount_minor, net_minor, vat_minor, balance_after, ref, category, rate_ver, fx_ver FROM wallet_ledger ORDER BY id');
export const holds = (ws: string) => rows<{ ref: string; amount_minor: number; state: string; release_reason: string | null; parent_ref: string | null }>(ws, 'SELECT ref, amount_minor, state, release_reason, parent_ref FROM wallet_holds ORDER BY rowid');
export const holdOf = async (ws: string, job: SendJob) => (await rows<{ amount_minor: number; state: string; release_reason: string | null }>(ws, 'SELECT amount_minor, state, release_reason FROM wallet_holds WHERE ref = ?', `msg:${job.idempotencyKey}`))[0];
export const nowS = () => Math.floor(Date.now() / 1000);
