import { z } from 'zod';
import type { OpsStatusDto, StatementDto, WalletDto } from '../../../src/core/api/contract';
import { auditLogItemDto, changeLogItemDto, offboardingDto, operatorOffboardingDto, costEstimateDto, instapayCreatedDto, instapayRequestDto, instapayViewDto, operatorInstapayDto, packageDto, packageOrderDto, pricingSettingsDto, refundRequestDto, topupDto } from '../../../src/core/api/contract';

export type { OpsStatusDto, StatementDto, WalletDto };
export type CostEstimateDto = z.infer<typeof costEstimateDto>;
export type TopupDto = z.infer<typeof topupDto>;
export type PackageDto = z.infer<typeof packageDto>;
export type PackageOrderDto = z.infer<typeof packageOrderDto>;
export type RefundRequest = z.infer<typeof refundRequestDto>;
export type InstapayRequest = z.infer<typeof instapayRequestDto>;
export type InstapayView = z.infer<typeof instapayViewDto>;
export type InstapayCreated = z.infer<typeof instapayCreatedDto>;
export type OperatorInstapay = z.infer<typeof operatorInstapayDto>;
export type PricingSettings = z.infer<typeof pricingSettingsDto>;
export type ChangeLogItem = z.infer<typeof changeLogItemDto>;
export type AuditLogItem = z.infer<typeof auditLogItemDto>;
export type AuditFilter = { workspaceId?: string; actor?: string; action?: string; before?: number };

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
export type OffboardingView = z.infer<typeof offboardingDto>;
export type OperatorOffboarding = z.infer<typeof operatorOffboardingDto>;
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
  /** InstaPay billing (owner). Rejects with a 404 ApiError while the server has it switched off. `payee` is null when the brand has no InstaPay account configured. */
  instapay(): Promise<InstapayView>;
  /** The server computes the amount: a package's price, or the top-up amount within the card top-up limits. */
  createInstapay(input: { kind: 'package'; packageId: string } | { kind: 'topup'; amountMinor: number }): Promise<InstapayCreated>;
  /** Uploads the transfer proof (jpeg / png / webp / pdf, up to 5 MB). */
  uploadInstapayProof(requestId: string, file: File): Promise<InstapayRequest>;
  refundRequests(): Promise<RefundRequest[]>;
  requestRefund(amountMinor: number, note: string): Promise<RefundRequest>;
  /** OFFBOARD-1 (owner): delete the workspace after a 14-day cooling-off. A wallet balance has to be given up explicitly (`acceptWriteOff`), else 409 `wallet_balance_remains`. */
  offboarding(): Promise<OffboardingView>;
  requestOffboarding(opts: { acceptWriteOff?: true }): Promise<OffboardingView>;
  /** Only while pending and only if the owner asked: an operator-started deletion answers 403 `operator_requested`. */
  cancelOffboarding(): Promise<void>;
}

export type PricingSettingsInput = { effectiveFrom: number; marginBps: number; creditLimitMinor: number; fxBufferBps: number; vatBps: number; reason: string };

/** The super-admin console (/api/v1/operator/*). Every write may answer 503 until the accounts binding exists. */
export type KillSwitchAction = 'suspend' | 'unsuspend' | 'campaigns/pause' | 'shared-number/evict' | 'shared-number/readmit' | 'integrations/revoke' | 'integrations/restore';
export interface OperatorApi {
  /** W2-OPS: the kill-switch card. Every action needs a reason of 5+ characters and is audited with the operator's id. */
  opsStatus(workspaceId: string): Promise<OpsStatusDto>;
  killSwitch(workspaceId: string, action: KillSwitchAction, reason: string): Promise<void>;
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
  /** Two operators: the first call records the request (`needsSecond`), a different operator's call executes it. */
  abandonRefund(id: string): Promise<{ needsSecond?: true }>;
  /** The card was refunded in the provider's dashboard to pay this manual payout: links that refund so its webhook never debits again. */
  linkDashboardRefund(id: string, kashierRefundId: string, amountMinor: number): Promise<void>;
  instapayQueue(): Promise<OperatorInstapay[]>;
  /** A signed link that opens the proof for a couple of minutes. */
  instapayProofLink(id: string): Promise<{ url: string; expiresAt: number }>;
  /** `bankRef` = the bank's own transaction reference read from the proof (REQUIRED for every amount; DUP-REF-REQUIRED-1). A proof that truly shows none is confirmed with `noReferenceReason` (5+ characters, audited; sends `noReference: true`). A re-used one answers 409 `duplicate_reference` and holds the request; a held request answers 409 `held`. */
  confirmInstapay(id: string, bankRef?: string, noReferenceReason?: string): Promise<OperatorInstapay & { needsSecond?: true }>;
  /** C2: lifts a duplicate hold after a person compared both transfers (a reason of 5+ characters; audited). */
  releaseInstapay(id: string, reason: string): Promise<OperatorInstapay>;
  rejectInstapay(id: string, reason: string): Promise<OperatorInstapay>;
  adjustments(): Promise<Adjustment[]>;
  createAdjustment(workspaceId: string, amountMinor: number, reason: string): Promise<Adjustment>;
  decideAdjustment(id: string, decision: 'approve' | 'reject'): Promise<Adjustment>;
  changeLog(): Promise<ChangeLogItem[]>;
  /** OFFBOARD-1: every workspace deletion asked for (newest first), one with its audit trail, request (a reason is required; `immediate` skips the 14-day wait), cancel. */
  offboardings(): Promise<OperatorOffboarding[]>;
  offboarding(workspaceId: string): Promise<OperatorOffboarding>;
  /** 409 `write_off_required` carries `amountMinor`: resend with `acceptWriteOff` to give up that balance. */
  requestOffboarding(workspaceId: string, body: { reason: string; immediate?: true; acceptWriteOff?: true }): Promise<OperatorOffboarding>;
  cancelOffboarding(workspaceId: string, reason: string): Promise<void>;
  /** OFFBOARD-2ND-APPROVER-1: a second operator approves an immediate deletion that writes off >= 1,000 EGP. */
  approveOffboarding(workspaceId: string, reason: string): Promise<void>;
  /** OFFBOARD-ABUSE-1: lifts the abuse hold with a reason. */
  releaseOffboardingHold(workspaceId: string, reason: string): Promise<void>;
  /** T8: who did what to which ids (append-only). Newest first; pass `before` (the smallest id seen) for the next page. */
  auditLog(filter: AuditFilter): Promise<AuditLogItem[]>;
  /** A yearly package order: what can be refunded now (unused whole months x price/12, current month kept, wallet debt settled first). */
  yearlyRefundQuote(orderId: string): Promise<YearlyRefundQuoteView>;
  /** Cancels the yearly plan at the end of the current month and settles the wallet debt first. Idempotent: a replay returns the same figures. */
  yearlyRefundExecute(orderId: string, reason: string): Promise<YearlyRefundDone>;
}
export type YearlyRefundQuoteView = { orderId: string; packageId: string; periodMonths: number; monthlyMinor: number; unusedMonths: number; grossMinor: number; debtMinor: number; debtSettledMinor: number; refundMinor: number };
export type YearlyRefundDone = { orderId: string; shortenedMonths: number; debtSettledMinor: number; cashRefundMinor: number; noMoneyOut: boolean; periodEnd: number };
