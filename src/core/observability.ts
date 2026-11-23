import * as Sentry from '@sentry/cloudflare';
import type { ErrorEvent } from '@sentry/cloudflare';
import { fetchWithTimeout } from './net/fetch-with-timeout';

import { errClass, maskPhones, memoryThrottle, renderFields as renderAlertFields, runbookUrl as foundationRunbookUrl, safeMessage, scrubEvent as scrubFoundationEvent, telegramAlert, type EventLike } from '../../foundation/observe';

// Masks, errClass, safeMessage and the Sentry scrub are the foundation's (F6, Ruling FDN-OBSERVE-1): one implementation for every product in the suite.
export { errClass, maskPhones, safeMessage };
/** Sentry beforeSend: no bodies, cookies, query strings, extra/contexts/tags or non-allowlisted headers; no user; phones, e-mails and path secrets masked. */
export const scrubEvent = (event: ErrorEvent): ErrorEvent => scrubFoundationEvent(event as unknown as EventLike) as unknown as ErrorEvent;

// ---- Alerts that reach a human (iceberg E1/E2, W1-OBS) ---------------------------------------------------------------------------------

export type AlertSeverity = 'P0' | 'P1' | 'info';
export type AlertFields = { severity?: AlertSeverity; workspace?: string } & Record<string, unknown>;
export type AlertEnv = { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_ALERT_CHAT_ID?: string; RUNBOOK_BASE_URL?: string; ENVIRONMENT?: string; ALERT_PRODUCT?: string; [k: string]: unknown };
type SentryLevel = 'error' | 'warning';
type AlertDeps = {
  env: AlertEnv;
  /** Hands a promise to the runtime so it outlives the response (ctx.waitUntil). */
  waitUntil: (p: Promise<unknown>) => void;
  captureMessage: (message: string, level: SentryLevel) => void;
  captureException: (err: unknown) => void;
};

/** P0 = wake someone (money or consent integrity). P1 = degraded, a human must look today. Everything else is `info` (logs only) unless the caller says otherwise. */
const P0_ALERTS = new Set([
  'ledger_mirror_mismatch', 'refund_debit_incomplete', 'card_refund_over_refundable', 'package_paid_not_granted', 'instapay_confirmed_not_granted',
  'duplicate_success', 'package_amount_mismatch', 'topup_amount_mismatch', 'credit_pack_amount_mismatch', 'shared_sent_not_recorded', 'number_restricted',
]);
const P1_ALERTS = new Set([
  'search_fold_rebuild_failed', // SEARCH_FOLD=v2 re-index threw on a workspace wake; rolled back, old index serving, retried next wake
  'proactive_recs_enqueue_failed', // a customer message failed to queue (CHAT-RECS-SWITCH-1); the order is marked failed:enqueue
  'agent_reply_blocked_rate', 'ai_cost_per_1k_over_threshold',
  'send_dlq', 'unhandled_error', 'secret_misconfigured', 'binding_missing', 'entitlement_push_failed', 'entitlement_reconcile_failed', 'entitlement_event_not_queued', 'webhook_reconfirm_failed',
  'webhook_unconfirmed_abandoned', 'webhook_unconfirmed_aged', 'topup_repair_failed', 'package_repair_failed', 'instapay_repair_failed', 'card_refund_reconcile_failed', 'card_refund_stuck',
  'refund_abandon_sweep_failed', 'instapay_expiry_failed', 'instapay_overdue_check_failed', 'instapay_grant_failed', 'instapay_auto_digest_stale', 'instapay_auto_not_ready', 'instapay_proof_overdue', 'instapay_amount_mismatch', 'send_enqueue_failed',
  'store_event_failed', 'cod_v2_submit_failed', 'business_token_unavailable', 'campaign_launch_failed', 'campaign_paused_internal_error', 'campaign_wallet_settle_failed', 'campaign_wallet_unavailable',
  'shared_sweep_failed', 'shared_template_refresh_failed', 'shared_trueup_not_published', 'fx_fetch_failed', 'fx_rate_rejected', 'fx_large_move_accepted', 'fx_rate_stale', 'pricing_pull_failed', 'pricing_copy_missing', 'queued_period_roll_failed',
  'store_plan_fallback_failed', 'r2_deletes_still_owed', 'scheduled_task_invalid', 'otp_failed', 'import_start_failed', 'import_workflow_failed', 'refund_id_conflict', 'refund_held',
  'refund_held_debited', 'refund_unmatched_no_credit', 'refund_excess_for_review', 'refund_reversal_blocked', 'package_refund_contention', 'package_refund_unmatched', 'package_chargeback',
  'funding_unknown', 'rate_unavailable', 'billing_unpriced_model', 'rate_missing_no_estimate', 'bot_turn_abandoned', 'media_fetch_abandoned', 'agent_model_failed', 'voice_transcribe_failed', 'wallet_wait_expired', 'wallet_debt_suspended', 'offboarding_debt_outstanding',
  'topup_webhook_failed', 'package_webhook_failed', 'cod_outcome_push_failed', 'inquiry_multiple_success', 'topup_unknown_order', 'topup_refunded_by_provider', 'signup_not_configured',
  'business_id_unverified', 'refund_refused', 'refund_id_conflict',
  // AI credit packs (self-service A9): money in, so the same classes as the top-up alerts.
  'credit_pack_refunded', 'credit_pack_repair_failed', 'credit_pack_webhook_failed',
  // Added in review: each of these was silently `info` and a human must see it.
  'instapay_sla_not_scheduled', 'proof_url_not_configured', 'catalog_mass_delete_refused', 'catalog_business_mismatch', 'catalog_sync_stuck', 'catalog_permission_missing', 'rate_missing_estimate_charged', 'bot_buyer_key_unavailable',
  'package_refunded', 'package_partial_refund', 'number_quality_flagged', 'number_error_spike', 'number_member_abuse', 'shared_health_push_failed',
  'switch_order_stale', 'store_plan_incomplete', 'upgrade_refund_not_reverted', 'upgrade_stranded_by_owner_refund', 'yearly_refund_debt_not_posted', 'backup_export_mismatch', 'ai_cost_over_threshold', 'meta_deletion_needs_review', 'meta_user_removed_app', 'offboarding_failed', 'offboarding_held', 'offboarding_backlog', 'credit_after_offboard', 'audit_write_failed', 'erasure_record_failed', 'instapay_duplicate_proof', 'billing_pass_backlog', 'billing_pass_row_failed', 'instapay_proof_purge_failed', 'refund_exceeds_charge',
]);
/** Known and deliberately log-only. A NEW alert name must be added to exactly one of P0_ALERTS / P1_ALERTS / INFO_ALERTS (test/guards.test.ts fails otherwise). */
export const INFO_ALERTS = new Set([
  'instapay_auto_error', // a request waits for a person after an unexpected error in the auto-confirm attempt; read in the weekly log pass
  'agent_no_credits', 'agent_model_timeout', 'assistant_handoff', 'assistant_help_index_failed', 'assistant_status_failed', 'agent_tool_failed', 'agent_turn_cap', 'agent_reply_blocked', 'campaign_content_blocked', 'ai_overdraw_refused', 'catalog_not_linked', 'catalog_provision_failed', 'catalog_items_rejected', 'catalog_vector_search_failed', 'cod_outcome_refused', 'ai_credits_low',
  'cod_request_details_missing', 'connector_call_crashed', 'connector_call_failed', 'kb_index_unavailable', 'kb_retrieve_failed', 'r2_delete_failed', 'rate_missing_pending',
  'send_tier_exhausted', 'shared_pick_id_refused', 'shared_trueup_no_rebate', 'topup_inquiry_unsupported', 'wallet_low_balance', 'webhook_unconfirmed',
  'seats_over_limit', // WA-SEATS-1: a downgrade left more seated staff than the package allows; nothing is deleted, the owner sees it on the Team screen
  // Chat agent context (Rulings CHAT-AGENT-2/4): each is a degraded answer or a notice that could not be delivered, never a stopped service; the customer is still answered.
  'agent_model_flag_unreadable', // WA-MODEL-FLAG-1: the agentModel flag could not be read; the turn used the default model
  'agent_policies_unavailable', 'agent_profile_unavailable', 'agent_faq_not_indexed', 'handoff_owner_unreachable', 'handoff_owner_notice_failed', 'handoff_digest_failed',
  'starter_templates_failed', // the brand's starter templates could not be put in place on connect (Meta slow or refused); the Templates screen retries by itself and has a retry button
  'instapay_no_reference', // DUP-REF-REQUIRED-1: an operator confirmed an InstaPay transfer with the audited "no reference" box ticked; review the weekly count
]);

export const severityOf = (name: string, explicit?: AlertSeverity): AlertSeverity => explicit ?? (P0_ALERTS.has(name) ? 'P0' : P1_ALERTS.has(name) ? 'P1' : 'info');

const THROTTLE_MS = 10 * 60_000;
const defaultDeps = (): AlertDeps => ({
  env: {},
  waitUntil: () => undefined,
  captureMessage: (message, level) => { Sentry.captureMessage(message, { level, fingerprint: [message.split(' ')[0] ?? 'alert'] }); },
  captureException: (err) => { Sentry.captureException(err); },
});
let deps: AlertDeps = defaultDeps();
const throttle = memoryThrottle();

/** Called at every entry point (request, queue batch, cron, Durable Object) so alert() knows the secrets and how to outlive the response. */
export function bindAlerts(d: Partial<AlertDeps> & { env: AlertEnv }): void {
  // Merge, don't reset: a later entry point (a request, a DO constructor) refreshes env / waitUntil but keeps an injected capture.
  deps = { ...deps, ...d };
}
export function resetAlerts(): void {
  deps = defaultDeps();
  throttle.reset();
}

const publicFields = (fields: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'severity' && k !== 'workspace'));
const renderFields = (fields: Record<string, unknown>): string[] => renderAlertFields(publicFields(fields));
/** T25: the incident runbook of ONE alert (docs/runbooks/alerts/<name>.md; test/alert-runbooks.test.ts proves every P0/P1 name has one). Base URL = var RUNBOOK_BASE_URL; unset = the repo-relative path. */
const runbookUrl = (name: string, env: AlertEnv): string => foundationRunbookUrl(name, typeof env.RUNBOOK_BASE_URL === 'string' ? env.RUNBOOK_BASE_URL : undefined);
const shortWorkspace = (ws: string): string => (ws.length > 8 ? `${ws.slice(0, 8)}…` : ws);

/**
 * THE way a code path says "a human should know". Always writes the JSON log line (the existing `{ alert: name, ...fields }` shape). For P0/P1 it also
 * records a Sentry EVENT (captureMessage, not a breadcrumb) and sends one Telegram message to TELEGRAM_ALERT_CHAT_ID, both fire-and-forget through waitUntil
 * and throttled per (name, workspace) for 10 minutes per isolate (the count it swallowed is stated in the next message). Secrets unset = log + Sentry only.
 * It NEVER throws into the caller, and never puts a phone, a body or a credential in Telegram or Sentry (maskPhones + a denied-key list).
 */
export function alert(name: string, fields: AlertFields = {}): void {
  try {
    console.error(JSON.stringify({ alert: name, ...fields }));
  } catch { /* an unserialisable field must not lose the alert */ }
  try {
    const sev = severityOf(name, fields.severity);
    if (sev === 'info') return;
    const workspace = typeof fields.workspace === 'string' ? fields.workspace : undefined;
    const claim = throttle.claim(`${name}|${workspace ?? ''}`, THROTTLE_MS); // sync: throttles Sentry and Telegram alike
    if (!claim.send) return;
    const d = deps;
    const rendered = renderFields(fields);
    const message = `${name} [${sev}]${workspace ? ` workspace=${shortWorkspace(workspace)}` : ''}${rendered.length ? ` ${rendered.join(' ')}` : ''}`;
    try {
      d.captureMessage(maskPhones(message) ?? name, sev === 'P0' ? 'error' : 'warning');
    } catch { /* Sentry must never break the caller */ }
    // Telegram: the foundation builds the message (same header as the Store's) and sends it; this file only supplies the transport rule (Ruling PERF-TIMEOUTS-1).
    const send = telegramAlert(
      { token: d.env.TELEGRAM_BOT_TOKEN, chatId: d.env.TELEGRAM_ALERT_CHAT_ID, fetch: (u, init) => fetchWithTimeout(u, init, { label: 'telegram.alert', timeoutMs: 5000 }) },
      {
        product: d.env.ALERT_PRODUCT ?? 'WhatsApp', level: sev === 'P0' ? 'p0' : 'p1', scope: workspace ? 'workspace' : 'platform', ...(workspace ? { scopeLine: shortWorkspace(workspace) } : {}),
        title: name, env: d.env.ENVIRONMENT ?? 'production', runbook: runbookUrl(name, d.env), fields: publicFields(fields), suppressed: claim.suppressed,
      },
    ).then(() => undefined, () => undefined);
    try {
      d.waitUntil(send);
    } catch { /* a stale execution context: the promise still runs, just unowned */ }
  } catch { /* never throws into the caller */ }
}

/** Reports a caught exception to Sentry (text masked by scrubEvent) without ever throwing. */
export function captureError(err: unknown): void {
  try {
    deps.captureException(err);
  } catch { /* ignore */ }
}
