/**
 * Explain tools (plan 4 Phase E): a capability that is a RULE or a BEHAVIOUR (a cap, an automatic pause, what a webhook does, what the merchant sees where) has no
 * route of its own, so its tool answers from the capability's own registry text: the steps, the edge cases and the guide, in the registry's words. Read-only, free,
 * typed-source (the text is authored and versioned with the capability, so it may back a claim about limits). `assistant/explain.generated.json` is built from
 * `capabilities/*.capability.json` by `scripts/build-help-corpus.mjs` (a test fails when it is stale).
 */
import { z } from 'zod';
import type { ToolSpec, TurnCtx } from '../../../../foundation/smart-layer/types';
import { schemaOf } from './write';

export type ExplainData = Record<string, { titleAr: string; titleEn: string; steps: string[]; edgeCases: string[]; helpArticle: string | null }>;

/** The behaviour capabilities that get an explain tool. Listed, never derived: a capability with a merchant route gets a real tool instead. */
export const EXPLAIN_IDS: readonly string[] = [
  // inbox, contacts, campaigns (E6)
  'inbox.coexistence-echo', 'inbox.failed-retry', 'inbox.handoff-needs-human', 'inbox.voice-note-transcript',
  'contacts.opt-in-keyword', 'contacts.opt-out',
  // access, numbers, orders, catalogue, billing behaviours (E7)
  'access.language', 'access.sign-out', 'agent.voice-notes', 'agent.location-pin', 'agent.inbound-media', 'catalogue.google-feeds-clash', 'compliance.privacy-terms', 'inbox.realtime', 'notifications.alerts',
  'numbers.coexistence', 'numbers.display-name', 'numbers.history-contacts-sync', 'numbers.meta-payment-method', 'numbers.meta-verification',
  'orders.cart-to-order', 'orders.cod-confirmation', 'orders.instapay-in-chat', 'orders.tracking',
  'templates.shared-number-marketing', 'templates.starter-on-connect', 'wallet.instapay-auto-confirm', 'catalogue.product-cards',
  // behaviour capabilities of the AI agent and the ordering bot
  'agent.customer-memory', 'agent.read-typing-franco', 'agent.store-search', 'agent.store-facts', 'orders.same-address',
  'campaigns.auto-pause', 'campaigns.consent-gating', 'campaigns.content-guard', 'campaigns.freq-cap-131049', 'campaigns.new-workspace-cap', 'campaigns.tracked-links',
];

export const explainToolName = (id: string): string => id.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase();

export function explainTools(data: ExplainData, ids: readonly string[] = EXPLAIN_IDS): ToolSpec[] {
  const none = z.object({}).strict();
  return ids.flatMap((id): ToolSpec[] => {
    const e = data[id];
    if (!e) return [];
    return [{
      name: explainToolName(id), capabilityId: id, policy: 'free', undo: 'none', resultTrust: 'typed-source', args: none, jsonSchema: schemaOf(none),
      description: `Explains how "${e.titleEn}" works in the product: the rules, the limits and what the merchant can and cannot do. Read-only; answer from it and cite the guide.`,
      read: async (ctx: TurnCtx) => ({ feature: ctx.locale === 'ar' ? e.titleAr : e.titleEn, howItWorks: e.steps, limitsAndEdgeCases: e.edgeCases, guide: e.helpArticle }),
    } as unknown as ToolSpec];
  });
}
