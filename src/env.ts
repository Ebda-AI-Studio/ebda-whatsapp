import type { WorkspaceDO } from './core/workspace-do';

export type Env = {
  WORKSPACE_DO: DurableObjectNamespace<WorkspaceDO>;
  DB: D1Database;
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
  /** Queue `ebda-store-events` (this service produces). Unbound = outcomes go over the bridge only. */
  STORE_EVENTS?: Queue;
  /** Signs the short-lived links the Store uses to fetch a customer's payment screenshot. */
  PROOF_URL_SECRET?: string;
  /** Public origin of this Worker (no trailing slash), used in the signed links the Store fetches payment screenshots from. */
  PUBLIC_BASE_URL?: string;
  /** Workers AI: the agent's default model and the knowledge-base embeddings. Absent = the agent cannot answer (it hands off). */
  AI?: Ai;
  /** Vectorize index `ebda-wa-kb` (knowledge base + catalog search). Unbound = the agent answers without a knowledge base. */
  VECTORIZE?: Vectorize;
  /** Base64 of 32 random bytes: encrypts merchants' own model keys (AES-GCM). Unset = bring-your-own-key is unavailable. */
  AGENT_SECRETS_KEY?: string;
  /** Comma-separated extra hosts merchants may use as their own model endpoint (white-label); the built-in provider list always applies. */
  AGENT_ALLOWED_HOSTS?: string;
  /** Overrides the default Workers AI model of the agent. */
  AGENT_MODEL?: string;
  /** Phase 6: contact-import workflow (one instance per uploaded file). */
  IMPORT_WORKFLOW: Workflow<{ workspaceId: string; importId: string }>;
  /** Phase 6: campaign broadcasts (one instance per campaign generation, id `<campaignId>-<attempt>`). */
  CAMPAIGN_WORKFLOW: Workflow<{ workspaceId: string; campaignId: string; attempt: number }>;
  /** Phase 7.4: 'true' turns wallet top-ups on. Anything else (or unset) = off. */
  TOPUPS_ENABLED?: string;
  /** Kashier merchant id (var) and Payment API Key (secret). The key signs checkout links and verifies webhooks. */
  KASHIER_MERCHANT_ID?: string;
  KASHIER_API_KEY?: string;
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
  SENTRY_DSN?: string;
};
