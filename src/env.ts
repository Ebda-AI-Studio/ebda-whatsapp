import type { WorkspaceDO } from './core/workspace-do';

export type Env = {
  WORKSPACE_DO: DurableObjectNamespace<WorkspaceDO>;
  DB: D1Database;
  SEND_QUEUE: Queue;
  MEDIA: R2Bucket;
  BACKUPS: R2Bucket;
  USAGE: AnalyticsEngineDataset;
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
  META_APP_SECRET: string;
  META_VERIFY_TOKEN: string;
  META_SYSTEM_TOKEN: string;
  META_GRAPH_VERSION: string;
  COMMIT_SHA?: string;
  IDENTITY_ISSUER: string;
  IDENTITY_JWKS_URL: string;
  IDENTITY_AUDIENCE: string;
  SUITE_BUYER_KEY_SECRET?: string;
  SENTRY_DSN?: string;
};
