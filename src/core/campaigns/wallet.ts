/**
 * The money side of a campaign, as a hook. The default is the real wallet (holds against the workspace ledger, see billing/engine.ts);
 * tests install recording fakes with `configureCampaignWallet`. A campaign page reserves `estimateMinor` (integer piasters) under a
 * deterministic ref `camp:<campaignId>:p<page>`: the same ref always means the same reservation, so a retried workflow step
 * never reserves twice, and Phase 7's per-message holds for that page's messages draw from it instead of reserving again.
 */
import type { Billing } from '../billing/engine';
import { DEFAULT_COUNTRY } from '../billing/money';
import { countryToDigits } from '../billing/country';
import { fundingOf } from '../billing/pricing';

export type WalletReserveResult = { ok: true } | { ok: false; reason: 'wallet_empty' };
export type WalletSettleOutcome = {
  /** How many messages the page queued. */
  recipients: number;
  /** completed = the campaign dispatched everything; cancelled = stopped by the merchant; abandoned = the page was reserved but never queued. */
  ended: 'completed' | 'cancelled' | 'abandoned';
};

/** What the real wallet needs from the workspace: its ledger, the sending number (who pays Meta) and the recipients' markets. */
export type WalletCtx = { billing: Billing; storage: DurableObjectStorage; phoneNumberId: string; countries?: string[]; now: number };

export interface CampaignWallet {
  /** Estimated cost of ONE message of this template category, in piasters. 0 = nothing is charged. */
  walletEstimate(workspaceId: string, category: string, ctx?: WalletCtx): number | Promise<number>;
  /** Reserves `estimateMinor` under `ref`. Idempotent per ref. A refusal pauses the campaign with reason `wallet_empty`. */
  walletReserve(workspaceId: string, ref: string, estimateMinor: number, ctx?: WalletCtx): Promise<WalletReserveResult>;
  /** Releases what the page did not use. Idempotent per ref; called when the campaign ends or a reservation is abandoned. */
  walletSettle(workspaceId: string, ref: string, outcome: WalletSettleOutcome, ctx?: WalletCtx): Promise<void>;
}

/** No wallet configured: every reservation is allowed and nothing is held. */
export const NO_WALLET: CampaignWallet = {
  walletEstimate: () => 0,
  walletReserve: async () => ({ ok: true }),
  walletSettle: async () => undefined,
};

/**
 * The real wallet. Everything it does is synchronous against the workspace's own ledger (no await between reading the balance and
 * writing the hold), so a page reservation can never exceed what is available. A number the merchant's card pays for reserves nothing.
 */
export const LEDGER_WALLET: CampaignWallet = {
  walletEstimate: (_ws, category, ctx) => {
    if (!ctx || fundingOf(ctx.storage.sql, ctx.phoneNumberId) !== 'platform_line') return 0;
    const countries = ctx.countries?.length ? ctx.countries : [DEFAULT_COUNTRY];
    // One number for the whole page: the dearest market in it, so the reservation is never short.
    return Math.max(...countries.map((c) => ctx.billing.estimateMinor(c === 'ROW' ? '000' : countryToDigits(c), category, ctx.now).minor));
  },
  walletReserve: async (_ws, ref, minor, ctx) => {
    if (!ctx || fundingOf(ctx.storage.sql, ctx.phoneNumberId) !== 'platform_line') return { ok: true };
    return ctx.storage.transactionSync(() => ctx.billing.reserveParent(ref, minor, ctx.now));
  },
  walletSettle: async (_ws, ref, outcome, ctx) => {
    if (ctx) ctx.storage.transactionSync(() => ctx.billing.settleParent(ref, `campaign_${outcome.ended}`, ctx.now));
  },
};

let current: CampaignWallet = LEDGER_WALLET;
export const configureCampaignWallet = (wallet: CampaignWallet): void => { current = wallet; };
export const campaignWallet = (): CampaignWallet => current;
