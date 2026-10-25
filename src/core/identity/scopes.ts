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

  [`GET ${S}/agent`]: 'person_only',
  [`PUT ${S}/agent`]: 'person_only',
  [`GET ${S}/connectors`]: 'person_only',
  [`PUT ${S}/connectors/:connectorId`]: 'person_only',
  [`DELETE ${S}/connectors/:connectorId`]: 'person_only',
  [`POST ${S}/connectors/:connectorId/test`]: 'person_only',
  [`GET ${S}/store-link/settings`]: 'person_only', // bot settings
  [`PATCH ${S}/store-link/settings`]: 'person_only',
  [`GET ${S}/bot/funnel`]: 'person_only', // bot analytics
  [`GET ${S}/store-link/catalog`]: 'person_only',
  [`POST ${S}/store-link/catalog/provision`]: 'person_only',

  [`GET ${S}/numbers`]: 'person_only',
  [`GET ${S}/numbers/signup-config`]: 'person_only',
  [`POST ${S}/numbers/connect`]: 'person_only',
  [`POST ${S}/numbers/:phoneNumberId/disconnect`]: 'person_only',
  [`POST ${S}/numbers/:phoneNumberId/refresh`]: 'person_only',
  [`POST ${S}/numbers/:phoneNumberId/register`]: 'person_only',
  [`GET ${S}/shared-number`]: 'person_only',
  [`POST ${S}/shared-number/join`]: 'person_only',
  [`POST ${S}/shared-number/leave`]: 'person_only',

  [`GET ${S}/wallet`]: 'person_only',
  [`GET ${S}/wallet/estimate`]: 'person_only',
  [`GET ${S}/wallet/statement`]: 'person_only',
  [`GET ${S}/wallet/refund-requests`]: 'person_only',
  [`POST ${S}/wallet/refund-requests`]: 'person_only',
  [`POST ${S}/wallet/topups`]: 'person_only',
  [`GET ${S}/wallet/topups/:orderId`]: 'person_only',
  [`GET ${S}/packages`]: 'person_only',
  [`POST ${S}/packages/:packageId/checkout`]: 'person_only',
  [`GET ${S}/packages/orders/:orderId`]: 'person_only',

  [`POST ${S}/templates`]: 'person_only',
  [`POST ${S}/templates/sync`]: 'person_only',
  [`POST ${S}/templates/install-defaults`]: 'person_only',
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
