/**
 * The money side of a campaign, as a hook. Phase 7 replaces the no-op below with the real wallet (holds against a ledger);
 * until then nothing is charged and everything is allowed. A campaign page reserves `estimateMinor` (integer piasters) under a
 * deterministic ref `camp:<campaignId>:p<page>`: the same ref always means the same reservation, so a retried workflow step
 * never reserves twice, and Phase 7's per-message holds for that page's messages draw from it instead of reserving again.
 */
export type WalletReserveResult = { ok: true } | { ok: false; reason: 'wallet_empty' };
export type WalletSettleOutcome = {
  /** How many messages the page queued. */
  recipients: number;
  /** completed = the campaign dispatched everything; cancelled = stopped by the merchant; abandoned = the page was reserved but never queued. */
  ended: 'completed' | 'cancelled' | 'abandoned';
};

export interface CampaignWallet {
  /** Estimated cost of ONE message of this template category, in piasters. 0 = nothing is charged. */
  walletEstimate(workspaceId: string, category: string): number | Promise<number>;
  /** Reserves `estimateMinor` under `ref`. Idempotent per ref. A refusal pauses the campaign with reason `wallet_empty`. */
  walletReserve(workspaceId: string, ref: string, estimateMinor: number): Promise<WalletReserveResult>;
  /** Releases what the page did not use. Idempotent per ref; called when the campaign ends or a reservation is abandoned. */
  walletSettle(workspaceId: string, ref: string, outcome: WalletSettleOutcome): Promise<void>;
}

/** No wallet configured: every reservation is allowed and nothing is held. */
export const NO_WALLET: CampaignWallet = {
  walletEstimate: () => 0,
  walletReserve: async () => ({ ok: true }),
  walletSettle: async () => undefined,
};

let current: CampaignWallet = NO_WALLET;
export const configureCampaignWallet = (wallet: CampaignWallet): void => { current = wallet; };
export const campaignWallet = (): CampaignWallet => current;
