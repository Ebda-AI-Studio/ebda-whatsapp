/**
 * Integrator server tokens (identity contract v1.3 r2, DRAFT): a merchant's own server calls the API with a scoped, per-store client token.
 * ONE place decides what such a token may touch: `ROUTE_SCOPES`. A route is `'METHOD /path'` exactly as registered under /api/v1 and maps to
 *  - a scope the token must hold,
 *  - `'any'`: any valid integration token (identity probe only),
 *  - `'person_only'`: owner / staff / person surfaces; an integration token is always 403.
 * A request whose route is not in the map is 403 (default deny), and `test/integrator-tokens.test.ts` walks every registered store route, so a new
 * route without a scope decision fails CI. `orders:events` is reserved by the contract and unissuable: it is deliberately not in the registry.
 */
export const WHATSAPP_SCOPES = ['conversations:read', 'messages:send', 'templates:read', 'contacts:read', 'contacts:write', 'campaigns:read'] as const;
export type Scope = (typeof WHATSAPP_SCOPES)[number];
export type Gate = Scope | 'any' | 'person_only';

const S = '/stores/:storeId';
export const ROUTE_SCOPES: Readonly<Record<string, Gate>> = {
  [`GET ${S}/me`]: 'any',

  [`GET ${S}/conversations`]: 'conversations:read',
  [`GET ${S}/conversations/:conversationId/messages`]: 'conversations:read',
  [`GET ${S}/messages/:messageId/body`]: 'conversations:read',
  [`GET ${S}/media/:messageId`]: 'conversations:read',
  [`GET ${S}/search`]: 'conversations:read',
  [`GET ${S}/events`]: 'conversations:read', // how a server follows the inbox: polling, with `after`
  [`GET ${S}/throttle`]: 'conversations:read',

  [`POST ${S}/conversations/:conversationId/messages`]: 'messages:send',
  [`POST ${S}/media`]: 'messages:send',

  [`GET ${S}/templates`]: 'templates:read',
  [`GET ${S}/templates/:name/:language`]: 'templates:read',
  [`GET ${S}/templates/shared`]: 'templates:read',
  [`GET ${S}/templates/shared-requests`]: 'person_only',
  [`POST ${S}/templates/check`]: 'templates:read', // free: Meta's rules against a draft, no Meta call

  [`GET ${S}/contacts`]: 'contacts:read',
  [`GET ${S}/contacts/:waId/orders`]: 'contacts:read',
  [`PUT ${S}/contacts/:waId/tags`]: 'contacts:write',

  [`GET ${S}/campaigns`]: 'campaigns:read',
  [`GET ${S}/campaigns/:campaignId`]: 'campaigns:read',
  [`GET ${S}/segments`]: 'campaigns:read',
  [`GET ${S}/segments/:segmentId`]: 'campaigns:read',
  [`GET ${S}/segments/:segmentId/preview`]: 'campaigns:read',
  [`POST ${S}/segments/preview`]: 'campaigns:read', // read-only audience preview

  // A WebSocket outlives the revocation check (made once, at the upgrade), so a server token never gets one: it polls /events.
  [`GET ${S}/ws`]: 'person_only',

  // ---- person / owner only ------------------------------------------------------------------------------------------------------
  [`DELETE ${S}/contacts/:waId`]: 'person_only', // erasure
  [`POST ${S}/contacts/:waId/orders/:orderNumber/cod-outcome`]: 'person_only',
  [`POST ${S}/conversations/:conversationId/assign`]: 'person_only', // staff changes
  [`GET ${S}/conversations/:conversationId/notes`]: 'person_only',
  [`POST ${S}/conversations/:conversationId/notes`]: 'person_only',
  [`POST ${S}/conversations/:conversationId/read`]: 'person_only',
  [`PUT ${S}/conversations/:conversationId/tags`]: 'person_only',
  // Quick replies (A25): a team's canned texts for the composer, used by people in the inbox; no integration token needs them.
  [`GET ${S}/quick-replies`]: 'person_only',
  [`POST ${S}/quick-replies`]: 'person_only',
  [`PUT ${S}/quick-replies/:quickReplyId`]: 'person_only',
  [`DELETE ${S}/quick-replies/:quickReplyId`]: 'person_only',

  [`POST ${S}/assistant/turn`]: 'person_only', // the assistant acts on the merchant's own session: never an integration token
  [`GET ${S}/assistant/conversations/:conversationId`]: 'person_only',
  [`POST ${S}/assistant/feedback`]: 'person_only',
  [`POST ${S}/assistant/previews/:previewId/apply`]: 'person_only', // the merchant's own press on a preview card: never an integration token
  [`POST ${S}/assistant/applied/:appliedId/undo`]: 'person_only',
  [`POST ${S}/assistant/approvals/:approvalId/confirm`]: 'person_only', // the merchant's own press on a confirm card
  [`POST ${S}/assistant/approvals/:approvalId/reject`]: 'person_only',

  [`GET ${S}/digest`]: 'person_only', // the merchant's own usage summary
  [`PUT ${S}/digest`]: 'person_only',

  [`GET ${S}/agent`]: 'person_only',
  [`PUT ${S}/agent`]: 'person_only',
  [`GET ${S}/connectors`]: 'person_only',
  [`PUT ${S}/connectors/:connectorId`]: 'person_only',
  [`DELETE ${S}/connectors/:connectorId`]: 'person_only',
  [`POST ${S}/connectors/:connectorId/test`]: 'person_only',
  [`GET ${S}/store-link/settings`]: 'person_only', // bot settings
  [`PATCH ${S}/store-link/settings`]: 'person_only',
  [`POST ${S}/store-link/settings/preview`]: 'person_only', // confirm token for turning customer sending on
  [`GET ${S}/bot/funnel`]: 'person_only', // bot analytics
  [`GET ${S}/store-link/catalog`]: 'person_only',
  [`POST ${S}/store-link/catalog/provision`]: 'person_only',
  [`POST ${S}/store-link/catalog/resync`]: 'person_only',
  [`PUT ${S}/store-link/catalog/commerce`]: 'person_only',

  [`GET ${S}/numbers`]: 'person_only',
  [`GET ${S}/numbers/signup-config`]: 'person_only',
  [`POST ${S}/numbers/connect`]: 'person_only',
  [`POST ${S}/numbers/notices/:noticeId/dismiss`]: 'person_only',
  [`POST ${S}/numbers/:phoneNumberId/disconnect`]: 'person_only',
  [`POST ${S}/numbers/:phoneNumberId/refresh`]: 'person_only',
  [`POST ${S}/numbers/:phoneNumberId/register`]: 'person_only',
  [`GET ${S}/shared-number`]: 'person_only',
  [`POST ${S}/shared-number/join`]: 'person_only',
  [`POST ${S}/shared-number/leave`]: 'person_only',

  [`GET ${S}/members`]: 'person_only', // the team and its seats (owner only)
  [`PUT ${S}/members/:userId/seat`]: 'person_only',
  [`DELETE ${S}/members/:userId/seat`]: 'person_only',
  [`POST ${S}/members/invite`]: 'person_only', // CHAT-SA-4: standalone team (owner only)
  [`DELETE ${S}/members/:userId`]: 'person_only',
  [`GET ${S}/offboarding`]: 'person_only', // workspace deletion
  [`POST ${S}/offboarding`]: 'person_only',
  [`DELETE ${S}/offboarding`]: 'person_only',
  [`GET ${S}/retention`]: 'person_only', // message retention window
  [`PUT ${S}/retention`]: 'person_only',
  [`GET ${S}/proactive-recs`]: 'person_only', // proactive post-order suggestions switch (owner)
  [`PUT ${S}/proactive-recs`]: 'person_only',
  [`GET ${S}/contacts/:waId/export`]: 'person_only', // data-subject export
  [`GET ${S}/contacts/consent-evidence`]: 'person_only', // per-customer consent record (phone numbers): the owner's file, never a server token
  [`GET ${S}/campaigns/:campaignId/report`]: 'person_only', // compliance report: the owner's proof for Meta
  [`GET ${S}/audit`]: 'person_only', // who changed what in the workspace
  [`PATCH ${S}/contacts/:waId`]: 'person_only', // contact edit
  [`POST ${S}/contacts/merge`]: 'person_only',

  [`GET ${S}/wallet`]: 'person_only',
  [`GET ${S}/wallet/estimate`]: 'person_only',
  [`GET ${S}/wallet/statement`]: 'person_only',
  [`GET ${S}/wallet/refund-requests`]: 'person_only',
  [`POST ${S}/wallet/refund-requests`]: 'person_only',
  [`POST ${S}/wallet/topups`]: 'person_only',
  [`GET ${S}/wallet/topups/:orderId`]: 'person_only',
  [`GET ${S}/wallet/instapay`]: 'person_only',
  [`POST ${S}/wallet/instapay`]: 'person_only',
  [`PUT ${S}/wallet/instapay/:requestId/proof`]: 'person_only',
  [`GET ${S}/wallet/yearly-refund`]: 'person_only', // money surfaces (self-service A9, A21, A22): owner screens, never an integration's
  [`POST ${S}/wallet/yearly-refund/preview`]: 'person_only',
  [`POST ${S}/wallet/yearly-refund/requests`]: 'person_only',
  [`GET ${S}/wallet/credit-packs`]: 'person_only',
  [`POST ${S}/wallet/credit-packs/preview`]: 'person_only',
  [`POST ${S}/wallet/credit-packs/orders`]: 'person_only',
  [`GET ${S}/wallet/credit-packs/orders/:orderId`]: 'person_only',
  [`POST ${S}/numbers/:phoneNumberId/funding/preview`]: 'person_only',
  [`PUT ${S}/numbers/:phoneNumberId/funding`]: 'person_only',
  [`GET ${S}/packages`]: 'person_only',
  [`POST ${S}/packages/:packageId/checkout`]: 'person_only',
  [`GET ${S}/packages/orders/:orderId`]: 'person_only',

  [`POST ${S}/templates`]: 'person_only',
  [`POST ${S}/templates/sync`]: 'person_only',
  [`POST ${S}/templates/install-defaults`]: 'person_only',
  [`POST ${S}/templates/install-seasonal`]: 'person_only',
  [`POST ${S}/templates/cod-v2/resubmit`]: 'person_only',
  [`POST ${S}/templates/shared-requests`]: 'person_only',
  [`PUT ${S}/templates/:name/:language`]: 'person_only',
  [`DELETE ${S}/templates/:name/:language`]: 'person_only',
  [`POST ${S}/campaigns`]: 'person_only',
  [`DELETE ${S}/campaigns/:campaignId`]: 'person_only',
  [`POST ${S}/campaigns/:campaignId/cancel`]: 'person_only',
  [`POST ${S}/campaigns/:campaignId/pause`]: 'person_only',
  [`POST ${S}/campaigns/:campaignId/resume`]: 'person_only',
  [`POST ${S}/campaigns/:campaignId/send`]: 'person_only',
  [`POST ${S}/segments`]: 'person_only',
  [`PUT ${S}/segments/:segmentId`]: 'person_only',
  [`DELETE ${S}/segments/:segmentId`]: 'person_only',
  [`GET ${S}/imports`]: 'person_only',
  [`POST ${S}/imports`]: 'person_only',
  [`GET ${S}/imports/:importId`]: 'person_only',
  [`GET ${S}/imports/:importId/rejects`]: 'person_only',
};

const compiled = Object.entries(ROUTE_SCOPES)
  .map(([key, gate]) => {
    const [method, pattern] = key.split(' ') as [string, string];
    return { method, gate, params: (pattern.match(/:/g) ?? []).length, re: new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, '[^/]+')}$`) };
  })
  .sort((a, b) => a.params - b.params); // a literal segment (`/segments/preview`) beats a parameter (`/segments/:segmentId`)

/** The gate for a request (`path` relative to /api/v1), or null when no route in the map matches (the caller then refuses: default deny). */
export function gateFor(method: string, path: string): Gate | null {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return compiled.find((r) => r.method === m && r.re.test(path))?.gate ?? null;
}

/** The gate for a ROUTED pattern (`/stores/:storeId/...`, as Hono matched it): the request's raw URL never decides anything. Null = no route in the map (default deny). */
export function gateForRoute(method: string, pattern: string): Gate | null {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return ROUTE_SCOPES[`${m} ${pattern}`] ?? null;
}

/**
 * Store READS that re-check the session like a write (a revoked token must not read this). Every other store read is listed in SESSION_UNCHECKED_READS with its reason;
 * `test/route-decisions.test.ts` fails when a read route is in neither, so a new read cannot be added without a decision. (Operator routes are the opposite and cheaper
 * to get right: checked unless listed.)
 */
export const SESSION_CHECKED_READS: ReadonlySet<string> = new Set(['GET /stores/:storeId/contacts/:waId/export', 'GET /stores/:storeId/contacts/consent-evidence', 'GET /stores/:storeId/campaigns/:campaignId/report', 'GET /stores/:storeId/audit', 'GET /stores/:storeId/offboarding', 'GET /stores/:storeId/members']); // the deletion status names the balance being given up; the team list names people
export const SESSION_UNCHECKED_READS: Readonly<Record<string, string>> = {
  'GET /stores/:storeId/assistant/conversations/:conversationId': "the caller's own masked assistant turns (secrets and phones masked before storage): the merchant's own text; a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/digest': "the weekly usage summary: counts only, no personal data; low-risk aggregate (Ruling READ-SESSION-1: a revoked token expires within minutes)",
  'GET /stores/:storeId/me': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/conversations': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/conversations/:conversationId/messages': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/messages/:messageId/body': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/media/:messageId': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/search': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/events': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/throttle': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/templates': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/templates/shared': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/templates/shared-requests': "settings read of the merchant's own configuration: no customer data",
  'GET /stores/:storeId/templates/:name/:language': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/contacts': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/contacts/:waId/orders': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/campaigns': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/campaigns/:campaignId': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/segments': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/segments/:segmentId': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/segments/:segmentId/preview': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/ws': "WebSocket upgrade: the token is verified once at the upgrade; a revoked session's socket is closed by the realtime layer",
  'GET /stores/:storeId/conversations/:conversationId/notes': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/quick-replies': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/agent': "settings read of the merchant's own configuration: no customer data",
  'GET /stores/:storeId/connectors': "settings read of the merchant's own configuration: no customer data",
  'GET /stores/:storeId/store-link/settings': "settings read of the merchant's own configuration: no customer data",
  'GET /stores/:storeId/bot/funnel': "settings read of the merchant's own configuration: no customer data",
  'GET /stores/:storeId/store-link/catalog': "settings read of the merchant's own configuration: no customer data",
  'GET /stores/:storeId/numbers': "settings read of the merchant's own configuration: no customer data",
  'GET /stores/:storeId/numbers/signup-config': "settings read of the merchant's own configuration: no customer data",
  'GET /stores/:storeId/shared-number': "settings read of the merchant's own configuration: no customer data",
  'GET /stores/:storeId/retention': "settings read of the merchant's own configuration: no customer data",
  'GET /stores/:storeId/proactive-recs': "settings read of the merchant's own configuration: no customer data",
  'GET /stores/:storeId/wallet': "the merchant's own balance, statement or plan: not another person's data; money WRITES re-check the session",
  'GET /stores/:storeId/wallet/estimate': "the merchant's own balance, statement or plan: not another person's data; money WRITES re-check the session",
  'GET /stores/:storeId/wallet/statement': "the merchant's own balance, statement or plan: not another person's data; money WRITES re-check the session",
  'GET /stores/:storeId/wallet/refund-requests': "the merchant's own balance, statement or plan: not another person's data; money WRITES re-check the session",
  'GET /stores/:storeId/wallet/topups/:orderId': "the merchant's own balance, statement or plan: not another person's data; money WRITES re-check the session",
  'GET /stores/:storeId/wallet/yearly-refund': "the merchant's own balance, statement or plan: not another person's data; money WRITES re-check the session",
  'GET /stores/:storeId/wallet/credit-packs': "the merchant's own balance, statement or plan: not another person's data; money WRITES re-check the session",
  'GET /stores/:storeId/wallet/credit-packs/orders/:orderId': "the merchant's own balance, statement or plan: not another person's data; money WRITES re-check the session",
  'GET /stores/:storeId/wallet/instapay': "the merchant's own balance, statement or plan: not another person's data; money WRITES re-check the session",
  'GET /stores/:storeId/packages': "the merchant's own balance, statement or plan: not another person's data; money WRITES re-check the session",
  'GET /stores/:storeId/packages/orders/:orderId': "the merchant's own balance, statement or plan: not another person's data; money WRITES re-check the session",
  'GET /stores/:storeId/imports': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/imports/:importId': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
  'GET /stores/:storeId/imports/:importId/rejects': "inbox or catalogue read: high volume, and a revoked token expires within minutes (Ruling READ-SESSION-1)",
};
