import type { WorkspaceDO } from './core/workspace-do';

export type Env = {
  WORKSPACE_DO: DurableObjectNamespace<WorkspaceDO>;
  DB: D1Database;
  /** Static assets (the inbox SPA). `not_found_handling` is "none": an unknown path reaches the Worker, which answers the 404 page (WA-404-1). */
  ASSETS: Fetcher;
  SEND_QUEUE: Queue;
  MEDIA: R2Bucket;
  BACKUPS: R2Bucket;
  USAGE: AnalyticsEngineDataset;
  /** Phase 6.4: one point per tracked-link click (campaign id + buyerKey, no phone). Best effort: absent or failing never blocks the redirect. */
  LINK_CLICKS?: AnalyticsEngineDataset;
  /** Customer Intelligence outcomes (CI-1). Best effort: absent or failing never blocks an order. */
  CI_OUTCOMES?: AnalyticsEngineDataset;
  /** Service Binding to the Store API Worker (RPC entrypoint WhatsAppBridge). Unbound = the Store link is off. */
  STORE_BRIDGE?: Fetcher;
  /** STORE-STANDING-2: '1' = a linked workspace whose Store has been silent for 24 h stops spending. Unset / '0' = off (default). See docs/rulings/STORE-STANDING-2.md. */
  STORE_STANDING_STALE_REFUSE?: string;
  /** Queue `ebda-store-events` (this service produces). Unbound = outcomes go over the bridge only. */
  STORE_EVENTS?: Queue;
  /** Signs the short-lived links the Store uses to fetch a customer's payment screenshot. */
  PROOF_URL_SECRET?: string;
  /** Public origin of this Worker (no trailing slash), used in the signed links the Store fetches payment screenshots from. */
  PUBLIC_BASE_URL?: string;
  /** Workers AI: the agent's default model and the knowledge-base embeddings. Absent = the agent cannot answer (it hands off). */
  AI?: Ai;
  /** The platform number's Meta phone-number id, and the approved AUTHENTICATION template on its WABA: sender of platform account codes (WA-OTP-SENDER-1). Either unset = `PlatformOtp` answers `disabled`. */
  PLATFORM_OTP_PHONE_NUMBER_ID?: string;
  PLATFORM_OTP_TEMPLATE?: string;
  /** Vectorize index `ebda-wa-kb` (knowledge base + catalog search). Unbound = the agent answers without a knowledge base. */
  VECTORIZE?: Vectorize;
  /** Base64 of 32 random bytes: encrypts merchants' own model keys (AES-GCM). Unset = bring-your-own-key is unavailable. */
  AGENT_SECRETS_KEY?: string;
  /** Comma-separated extra hosts merchants may use as their own model endpoint (white-label); the built-in provider list always applies. */
  AGENT_ALLOWED_HOSTS?: string;
  /** Overrides the default Workers AI model of the agent. */
  AGENT_MODEL?: string;
  /** The platform model's price in USD per million tokens (input / output), for the cost-per-credit log and alert (M-084). Unset = cost unknown, no alert. */
  AI_PRICE_INPUT_USD_PER_M?: string;
  AI_PRICE_OUTPUT_USD_PER_M?: string;
  /** Same, for `@cf/openai/gpt-oss-120b` (the agentModel flag, Ruling WA-MODEL-FLAG-1). Unset = cost unknown while that model is on: set both BEFORE flipping. */
  AI_PRICE_INPUT_USD_PER_M_GPT_OSS?: string;
  AI_PRICE_OUTPUT_USD_PER_M_GPT_OSS?: string;
  /** Voice-note transcription: price in USD per audio minute of the speech model (Cloudflare pricing page), and the voice notes one store may have transcribed per UTC day (default 60). */
  AI_STT_PRICE_USD_PER_MIN?: string;
  VOICE_DAILY_CAP?: string;
  /** The public support address shown on the data-deletion page; the brand's supportEmail (pinned to vendor/brand/store-support-email.json). */
  SUPPORT_EMAIL?: string;
  /** Phase 6: contact-import workflow (one instance per uploaded file). */
  IMPORT_WORKFLOW: Workflow<{ workspaceId: string; importId: string }>;
  /** Phase 6: campaign broadcasts (one instance per campaign generation, id `<campaignId>-<attempt>`). */
  CAMPAIGN_WORKFLOW: Workflow<{ workspaceId: string; campaignId: string; attempt: number }>;
  /** Phase 7.4: 'true' turns wallet top-ups on. Anything else (or unset) = off. */
  TOPUPS_ENABLED?: string;
  /** 'true' turns self-serve package checkout on (the routes answer 404 otherwise). Needs the same Kashier settings as top-ups. */
  PACKAGE_CHECKOUT_ENABLED?: string;
  /** Kashier merchant id (var) and Payment API Key (secret). The key signs checkout links and verifies webhooks. */
  KASHIER_MERCHANT_ID?: string;
  KASHIER_API_KEY?: string;
  /** Kashier SECRET key (a different key from the Payment API Key): authenticates the transaction-details call that confirms every webhook before money moves. Unset = webhooks are answered 503 and nothing is applied. */
  KASHIER_SECRET_KEY?: string;
  /** Kashier API origin for that call; default https://api.kashier.io (test: https://test-api.kashier.io). */
  KASHIER_API_URL?: string;
  /** 'true' lets merchants pay packages and top-ups by InstaPay transfer with a proof an operator confirms. Needs the brand's payee settings (EBDA_INSTAPAY_*), else it is unavailable (503). */
  INSTAPAY_BILLING_ENABLED?: string;
  /** Ebda AI Studio's InstaPay address (a secret; the SAME value as ebda-api), its public QR image url (https only; the Store's is https://media.ebda.app/platform/instapay-qr.jpg) and the payee name shown to merchants. */
  EBDA_INSTAPAY_HANDLE?: string;
  EBDA_INSTAPAY_QR_URL?: string;
  EBDA_INSTAPAY_PAYEE_NAME?: string;
  /** InstaPay auto-confirm (plan 2026-11-14). The shared platform-global duplicate index (a D1 database BOTH Ebda Store and Ebda Chat bind): a receipt is claimable once across every merchant and product. Unbound = auto-confirm refuses to run (fail closed). */
  INSTAPAY_DEDUPE_DB?: D1Database;
  /** HMAC secret (at least 16 characters, a Worker secret) shared with the OS brain for this product: signs the digest/waiting notices out and verifies the signed "not received" tap in. */
  INSTAPAY_BRIDGE_SECRET?: string;
  /** Where the signed digest and waiting notices go: the OS brain's `POST /api/instapay/notify` (https). Unset = no notices (auto-confirm refuses to run). */
  BRAIN_BRIDGE_URL?: string;
  /** Overrides the vision model that reads InstaPay proofs for auto-confirm. */
  INSTAPAY_RECEIPT_AI_MODEL?: string;
  /** 'true' sends the card-refundable part of an approved refund to the provider's refund API. Default off: every refund is a manual payout. */
  KASHIER_REFUNDS_ENABLED?: string;
  /** Hosted checkout origin; default https://checkout.kashier.io. */
  KASHIER_CHECKOUT_URL?: string;
  /** The card fee the merchant pays ON TOP of a top-up (WA-TOPUP-FEE-1): basis points of the amount, plus a fixed part in piasters. Set both before enabling. */
  KASHIER_FEE_BPS?: string;
  KASHIER_FEE_FIXED_MINOR?: string;
  /** Service binding to the accounts service: `isRevoked(sessionId)`. A top-up session is refused (fail closed) when it is unbound. */
  ACCOUNTS?: { isRevoked(sessionId: string): Promise<boolean> };
  /** An operator adjustment above this many piasters waits for a second super admin. Default 100000 (1,000 EGP). */
  ADJUSTMENT_APPROVAL_MINOR?: string;
  /** Most adjustments one operator may approve for themselves in a rolling day. Default 20. */
  ADJUSTMENT_DAILY_CAP?: string;
  /** Phase 8.2 switch: "1" or "true" turns on the shared platform number (membership routes, inbound routing by last sender). Unset = the routes answer 404 and the number is unknown to the webhook. */
  SHARED_NUMBER_ENABLED?: string;
  /** Integrator server tokens (identity contract v1.3 r2, DRAFT): "1" or "true" lets a merchant's own server call the API with a scoped client token. Unset = every client token is 401. */
  INTEGRATOR_TOKENS_ENABLED?: string;
  META_APP_SECRET: string;
  META_VERIFY_TOKEN: string;
  /** The platform's own token: the shared number and platform-level calls. A merchant's own number uses its business token (see core/numbers/token.ts). */
  META_SYSTEM_TOKEN: string;
  META_GRAPH_VERSION: string;
  /** Phase 8.1 switch: "1" or "true" turns on connecting a merchant's own number (Embedded Signup). Unset = the numbers routes answer 404. */
  EMBEDDED_SIGNUP_ENABLED?: string;
  /** The Meta app id (Embedded Signup code exchange). Required while the switch is on. */
  META_APP_ID?: string;
  /** Public: the Facebook Login for Business configuration for WhatsApp Embedded Signup (v4+). */
  EMBEDDED_SIGNUP_CONFIG_ID?: string;
  /** Base64 of 32 random bytes: encrypts business tokens and registration PINs (AES-GCM). Required while the switch is on. */
  TOKEN_ENC_KEY?: string;
  /** ERASURE-KEY-1: HMAC key (secret, at least 32 characters) for the erasure subject hash, the offboarding pseudonym, the audit target ids and the view-as record hashes. NEVER rotated (a rotation would orphan every erasure record); independent of TOKEN_ENC_KEY. */
  ERASURE_HMAC_KEY?: string;
  /** M-174: HMAC key (secret, at least 32 characters) that signs backup manifests; PREVIOUS only verifies older backups during a key change. */
  BACKUP_HMAC_KEY?: string;
  BACKUP_HMAC_KEY_PREVIOUS?: string;
  /** M-173: during a TOKEN_ENC_KEY rotation, the key being retired. Reads try it after TOKEN_ENC_KEY; writes never use it. Remove it once the rotation status shows 0 rows on it. */
  TOKEN_ENC_KEY_PREVIOUS?: string;
  COMMIT_SHA?: string;
  IDENTITY_ISSUER: string;
  IDENTITY_JWKS_URL: string;
  IDENTITY_AUDIENCE: string;
  /** Which brand pack this deployment runs (src/brand.ts); unset = the suite brand. */
  BRAND?: string;
  /** `ebda` (default) or `oidc` for a white-label tenant's own identity provider. */
  IDENTITY_MODE?: string;
  /** JSON, see src/core/identity/oidc.ts; required when IDENTITY_MODE=oidc. */
  IDENTITY_OIDC_CONFIG?: string;
  SUITE_BUYER_KEY_SECRET?: string;
  /** Var: comma-separated secret names this deployment must have (checked by /health, see core/secrets-check.ts). */
  REQUIRED_SECRETS?: string;
  SENTRY_DSN?: string;
  /** Secrets for the out-of-band alert channel (core/observability.ts alert()); unset = log + Sentry only. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALERT_CHAT_ID?: string;
  /** Var: label shown in alerts (default "production"). */
  ENVIRONMENT?: string;
  /** Var: the product name shown first in an alert (the brand's, so core code names no brand). */
  ALERT_PRODUCT?: string;
  /** T25: where docs/runbooks/alerts/<name>.md is served from (an https URL); unset = the repo-relative path in the alert text. */
  RUNBOOK_BASE_URL?: string;
};
