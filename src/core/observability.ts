import * as Sentry from '@sentry/cloudflare';
import type { ErrorEvent } from '@sentry/cloudflare';
import { fetchWithTimeout } from './net/fetch-with-timeout';

// A run of 8+ digits (ASCII, Arabic-Indic or Persian), optionally with +, spaces, dashes, dots or parentheses between them.
const DIGIT = '[0-9\\u0660-\\u0669\\u06f0-\\u06f9]';
// Separators include Unicode format characters (\p{Cf}: bidi marks, zero-width joiners) so they cannot split a number past the mask.
const PHONE_LIKE = new RegExp(`\\+?${DIGIT}(?:[\\s\\-().\\p{Cf}]*${DIGIT}){7,}`, 'gu');
// Allowlist: anything else (auth, cookies, signatures, client IPs) never leaves the worker.
const SAFE_HEADERS = new Set(['user-agent', 'content-type', 'content-length', 'cf-ray', 'accept']);

export const maskPhones = (s: string | undefined) => s?.replace(PHONE_LIKE, '[phone]');

function scrubUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    // The segment after /contacts/ is a phone number by position, whatever its encoding.
    const path = u.pathname.replace(/(\/contacts\/)[^/]+/, '$1__PHONE__');
    return maskPhones(decodeURI(`${u.origin}${path}`))?.replace('__PHONE__', '[phone]');
  } catch {
    return undefined;
  }
}

/** Sentry beforeSend: no bodies, cookies, query strings, extra/contexts/tags or non-allowlisted headers; no user; phones masked. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.headers) {
      event.request.headers = Object.fromEntries(Object.entries(event.request.headers).filter(([k]) => SAFE_HEADERS.has(k.toLowerCase())));
    }
    if (event.request.url) {
      const url = scrubUrl(event.request.url);
      if (url) event.request.url = url;
      else delete event.request.url;
    }
  }
  delete event.user;
  delete event.extra;
  delete event.tags;
  delete event.contexts;
  if (event.message) event.message = maskPhones(event.message);
  for (const v of event.exception?.values ?? []) if (v.value) v.value = maskPhones(v.value);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(({ data: _data, message, ...rest }) => ({ ...rest, ...(message ? { message: maskPhones(message) } : {}) }));
  }
  return event;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

/**
 * What may be logged about a caught value: its class (and a short machine code if it has one), never its text. Error
 * messages routinely echo input (a phone number, an e-mail, a body), and `throw "string"` has no class at all.
 */
export function errClass(err: unknown): string {
  const name = err instanceof Error ? (err.constructor?.name || err.name || 'Error') : err === null ? 'null' : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' || (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(code)) ? `${name}:${code}` : name;
}

/** An error's text for storage next to a task (operators read it): phones and e-mails masked, bounded. Never for logs. */
export function safeMessage(err: unknown, max = 200): string {
  const raw = String((err as { message?: unknown } | null)?.message ?? err);
  return (maskPhones(raw) ?? '').replace(EMAIL, '[email]').slice(0, max);
}

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
  'send_dlq', 'unhandled_error', 'secret_misconfigured', 'binding_missing', 'entitlement_push_failed', 'entitlement_reconcile_failed', 'entitlement_event_not_queued', 'webhook_reconfirm_failed',
  'webhook_unconfirmed_abandoned', 'webhook_unconfirmed_aged', 'topup_repair_failed', 'package_repair_failed', 'instapay_repair_failed', 'card_refund_reconcile_failed', 'card_refund_stuck',
  'refund_abandon_sweep_failed', 'instapay_expiry_failed', 'instapay_overdue_check_failed', 'instapay_grant_failed', 'instapay_auto_digest_stale', 'instapay_auto_not_ready', 'instapay_proof_overdue', 'instapay_amount_mismatch', 'send_enqueue_failed',
  'store_event_failed', 'business_token_unavailable', 'campaign_launch_failed', 'campaign_paused_internal_error', 'campaign_wallet_settle_failed', 'campaign_wallet_unavailable',
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
  'agent_no_credits', 'assistant_handoff', 'assistant_help_index_failed', 'assistant_status_failed', 'agent_tool_failed', 'agent_turn_cap', 'agent_reply_blocked', 'campaign_content_blocked', 'ai_overdraw_refused', 'catalog_not_linked', 'catalog_provision_failed', 'catalog_items_rejected', 'catalog_vector_search_failed', 'cod_outcome_refused', 'ai_credits_low',
  'cod_request_details_missing', 'connector_call_crashed', 'connector_call_failed', 'kb_index_unavailable', 'kb_retrieve_failed', 'r2_delete_failed', 'rate_missing_pending',
  'send_tier_exhausted', 'shared_pick_id_refused', 'shared_trueup_no_rebate', 'topup_inquiry_unsupported', 'wallet_low_balance', 'webhook_unconfirmed',
  'seats_over_limit', // WA-SEATS-1: a downgrade left more seated staff than the package allows; nothing is deleted, the owner sees it on the Team screen
  // Chat agent context (Rulings CHAT-AGENT-2/4): each is a degraded answer or a notice that could not be delivered, never a stopped service; the customer is still answered.
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
const lastSent = new Map<string, { at: number; suppressed: number }>();

/** Called at every entry point (request, queue batch, cron, Durable Object) so alert() knows the secrets and how to outlive the response. */
export function bindAlerts(d: Partial<AlertDeps> & { env: AlertEnv }): void {
  // Merge, don't reset: a later entry point (a request, a DO constructor) refreshes env / waitUntil but keeps an injected capture.
  deps = { ...deps, ...d };
}
export function resetAlerts(): void {
  deps = defaultDeps();
  lastSent.clear();
}

// Keys whose values can be a person's data or a credential: never rendered, whatever the caller passed.
const DENIED_KEY = /^(to|from|body|text|code|email|caption|address|message|name|customer\w*)$|phone|wa_?id|token|secret|password|authorization/i;
function renderFields(fields: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'severity' || k === 'workspace' || DENIED_KEY.test(k)) continue;
    const raw = Array.isArray(v) ? v.filter((x) => ['string', 'number', 'boolean'].includes(typeof x)).join(',') : ['string', 'number', 'boolean'].includes(typeof v) ? String(v) : '';
    if (!raw) continue;
    out.push(`${k}=${(maskPhones(raw) ?? '').replace(PHONE_ANYWHERE, '[phone]').slice(0, 80)}`);
  }
  return out.slice(0, 12);
}
// Belt and braces on top of maskPhones: any run of 8+ digits that survived is hidden too.
const PHONE_ANYWHERE = /[0-9\u0660-\u0669\u06f0-\u06f9]{8,}/g;

const shortWorkspace = (ws: string): string => (ws.length > 8 ? `${ws.slice(0, 8)}…` : ws);

/** T25: the incident runbook of ONE alert, as a URL a phone can open (docs/runbooks/alerts/<name>.md; test/alert-runbooks.test.ts proves every P0/P1 name has one). The base URL is the var RUNBOOK_BASE_URL (wrangler.jsonc); unset = the repo-relative path. */
const runbookUrl = (name: string, env: AlertEnv): string =>
  `${typeof env.RUNBOOK_BASE_URL === 'string' && /^https:\/\//.test(env.RUNBOOK_BASE_URL) ? env.RUNBOOK_BASE_URL.replace(/\/$/, '') : 'docs/runbooks/alerts'}/${name}.md`;

function telegramText(name: string, sev: AlertSeverity, workspace: string | undefined, fields: string[], suppressed: number, env: AlertEnv): string {
  const lines = [
    `${sev === 'P0' ? '🔴' : '🟠'} ${env.ALERT_PRODUCT ?? 'WhatsApp'}: ${name}`,
    `[${sev} ${workspace ? 'WORKSPACE' : 'PLATFORM'}]`,
    ...(workspace ? [`workspace=${shortWorkspace(workspace)}`] : []),
    `env=${env.ENVIRONMENT ?? 'production'} · runbook=${runbookUrl(name, env)}`,
    ...fields,
    ...(suppressed > 0 ? [`(suppressed ${suppressed} more since the last alert)`] : []),
  ];
  return lines.join('\n').slice(0, 4000);
}

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
    const key = `${name}|${workspace ?? ''}`;
    const now = Date.now();
    const seen = lastSent.get(key);
    if (seen && now - seen.at < THROTTLE_MS) {
      seen.suppressed++;
      return;
    }
    const suppressed = seen?.suppressed ?? 0;
    lastSent.set(key, { at: now, suppressed: 0 });
    const d = deps;
    const rendered = renderFields(fields);
    const message = `${name} [${sev}]${workspace ? ` workspace=${shortWorkspace(workspace)}` : ''}${rendered.length ? ` ${rendered.join(' ')}` : ''}`;
    try {
      d.captureMessage(maskPhones(message) ?? name, sev === 'P0' ? 'error' : 'warning');
    } catch { /* Sentry must never break the caller */ }
    const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_ALERT_CHAT_ID: chat } = d.env;
    if (!token || !chat) return;
    const send = fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: telegramText(name, sev, workspace, rendered, suppressed, d.env) }),
    }, { label: 'telegram.alert', timeoutMs: 5000 }).then(() => undefined, () => undefined);
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
