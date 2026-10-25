import { z } from 'zod';
import type { StatementDto, WalletDto } from '../../../src/core/api/contract';
import { changeLogItemDto, costEstimateDto, packageDto, packageOrderDto, pricingSettingsDto, refundRequestDto, topupDto } from '../../../src/core/api/contract';

export type { StatementDto, WalletDto };
export type CostEstimateDto = z.infer<typeof costEstimateDto>;
export type TopupDto = z.infer<typeof topupDto>;
export type PackageDto = z.infer<typeof packageDto>;
export type PackageOrderDto = z.infer<typeof packageOrderDto>;
export type RefundRequest = z.infer<typeof refundRequestDto>;
export type PricingSettings = z.infer<typeof pricingSettingsDto>;
export type ChangeLogItem = z.infer<typeof changeLogItemDto>;

// The operator lists below have no shared DTO in contract.ts (the server builds them inline), so the web client pins their shape here
// and validates every response against it, exactly like it does for the shared DTOs.
export const rateCardVersionDto = z.object({ ver: z.number().int(), effectiveFrom: z.number().int(), rows: z.number().int(), publishedAt: z.number().int(), actor: z.string() });
export const fxRateDto = z.object({ ver: z.number().int(), effectiveFrom: z.number().int(), egpPerUsdMicros: z.number().int(), bufferBps: z.number().int(), publishedAt: z.number().int(), actor: z.string() });
export const marginOverrideDto = z.object({ ver: z.number().int(), effectiveFrom: z.number().int(), marginBps: z.number().int(), actor: z.string(), reason: z.string() });
export const adjustmentDto = z.object({
  id: z.string(), workspaceId: z.string(), amountMinor: z.number().int(), reason: z.string(), requestedBy: z.string(),
  state: z.enum(['pending', 'approved', 'rejected']), approvedBy: z.string().nullable(), createdAt: z.number().int(), decidedAt: z.number().int().nullable(),
});
export type RateCardVersion = z.infer<typeof rateCardVersionDto>;
export type FxRate = z.infer<typeof fxRateDto>;
export type MarginOverride = z.infer<typeof marginOverrideDto>;
export type Adjustment = z.infer<typeof adjustmentDto>;

export type BillingCategory = 'marketing' | 'utility' | 'authentication' | 'service';

/** The merchant's wallet (Phase 7). Reads are open to every role; topping up and refunds are the owner's. */
export interface WalletApi {
  wallet(): Promise<WalletDto>;
  /** `month` = YYYY-MM. Owner and operator only (the server answers 403 to staff). */
  statement(month: string): Promise<StatementDto>;
  /** A URL the browser can download the month's CSV from: fetched with the token (like media), never a bare link. */
  statementCsv(month: string): Promise<string>;
  estimate(category: BillingCategory, count: number): Promise<CostEstimateDto>;
  /** Starts a top-up: returns the pending order with the card fee and the hosted checkout URL. The wallet is only credited by the server's webhook. */
  topup(amountMinor: number): Promise<TopupDto>;
  topupState(orderId: string): Promise<TopupDto>;
  /** Packages on sale. Rejects with a 404 ApiError while the server has package checkout switched off. Owner and staff may read. */
  packages(): Promise<PackageDto[]>;
  /** Starts a checkout for a package (owner only). Only the id goes up: the server owns the price. The plan changes only when the server's webhook says paid. */
  buyPackage(packageId: string): Promise<PackageOrderDto>;
  packageOrderState(orderId: string): Promise<PackageOrderDto>;
  refundRequests(): Promise<RefundRequest[]>;
  requestRefund(amountMinor: number, note: string): Promise<RefundRequest>;
}

export type PricingSettingsInput = { effectiveFrom: number; marginBps: number; creditLimitMinor: number; fxBufferBps: number; vatBps: number; reason: string };

/** The super-admin console (/api/v1/operator/*). Every write may answer 503 until the accounts binding exists. */
export interface OperatorApi {
  pricingSettings(): Promise<PricingSettings[]>;
  publishPricingSettings(input: PricingSettingsInput): Promise<PricingSettings>;
  rateCards(): Promise<RateCardVersion[]>;
  publishRateCard(input: { effectiveFrom: number; rates: { country: string; category: string; usdMicros: number }[]; reason: string }): Promise<void>;
  fxRates(): Promise<FxRate[]>;
  publishFx(input: { effectiveFrom: number; egpPerUsdMicros: number; bufferBps: number; reason: string }): Promise<void>;
  overrides(workspaceId: string): Promise<MarginOverride[]>;
  publishOverride(workspaceId: string, input: { effectiveFrom: number; marginBps: number; reason: string }): Promise<void>;
  setFunding(phoneNumberId: string, funding: 'merchant_card' | 'platform_line', reason: string): Promise<void>;
  refundQueue(): Promise<RefundRequest[]>;
  decideRefund(id: string, decision: 'approve' | 'reject', note: string): Promise<RefundRequest>;
  markRefundPaid(id: string): Promise<void>;
  /** The card was refunded in the provider's dashboard to pay this manual payout: links that refund so its webhook never debits again. */
  linkDashboardRefund(id: string, kashierRefundId: string, amountMinor: number): Promise<void>;
  adjustments(): Promise<Adjustment[]>;
  createAdjustment(workspaceId: string, amountMinor: number, reason: string): Promise<Adjustment>;
  decideAdjustment(id: string, decision: 'approve' | 'reject'): Promise<Adjustment>;
  changeLog(): Promise<ChangeLogItem[]>;
}
