/**
 * CHAT-SA-5: tools that only make sense when the workspace has a Store behind it (catalogue, orders, COD, the ordering bot's store settings, store sign-in codes,
 * product recommendations). A standalone workspace (`sw_...`) has no Store bridge, so these routes answer `store_link_off`; the assistant must not offer them at all,
 * or it would promise something the screen cannot do. `foundation/` is vendored (FDN-VENDOR-1), so the declaration lives here, by tool name;
 * `test/standalone-smart-layer.test.ts` fails when a tool whose capability calls a Store-coupled route is missing from this list.
 */
import type { ToolSpec } from '../../../foundation/smart-layer/types';
import { isStandaloneId } from '../workspace-kind';

export const NEEDS_STORE: ReadonlySet<string> = new Set([
  'catalogue_status', 'catalogue_left_out', 'catalogue_resync', 'catalogue_toggles_set', 'catalogue_link_existing', 'catalogue_provision',
  'storelink_bridge_health', 'bot_funnel', 'bot_ordering_toggle', 'bot_order_confirmations_toggle', 'otp_toggle',
  'bot_menu_set', 'bot_hours_set', 'bot_location_set',
  'agent_recommendations_toggle', 'inbox_cod_outcome', 'inbox_customer_orders', 'store_top_products', 'store_create_coupon',
]);

/** Every tool for a Store workspace; for a standalone one, without the Store-coupled ones. */
export const toolsForWorkspace = (tools: readonly ToolSpec[], workspaceId: string): ToolSpec[] => (isStandaloneId(workspaceId) ? tools.filter((t) => !NEEDS_STORE.has(t.name)) : [...tools]);
