import type { AgentCopy } from './core/ai/config';
import type { StoreLinkConfig } from './core/store-link';
import type { TemplateSeed } from './routes/templates';
import { DEMO_PACK } from './addons/demo/pack';
import { EBDA_PACK } from './addons/ebda/pack';

/** What a customer reads from the shared platform number itself (never from a store): the "which store?" list and the no-route reply. */
export type SharedNumberCopy = {
  /** List body (at most 1024 characters). */
  pickBody: string;
  /** The button that opens the list (at most 20 characters). */
  pickButton: string;
  /** Small text under the list (at most 60 characters). */
  pickFooter: string;
  /** Sent once a day to a customer who writes to the platform number without any store having written to them first. */
  noRoute: string;
};

/** Everything brand-specific the Worker needs: copy, starter templates, opt-in words, the AI agent's words, and an optional Store link. */
export type BrandPack = {
  id: string;
  /** The first reply a new customer gets while the inbox has no other answer configured. */
  autoReply: string;
  optInKeywords: readonly string[];
  templates: readonly TemplateSeed[];
  agentCopy: AgentCopy;
  /** Words of the shared platform number (Phase 8.2). */
  sharedNumber: SharedNumberCopy;
  /** Only the suite brand links to a Store; a white-label pack leaves it out (the ordering bot stays silent). */
  storeLink?: Pick<StoreLinkConfig, 'bridge' | 'events' | 'copy' | 'otp'>;
};

const BRANDS: Record<string, BrandPack> = { ebda: EBDA_PACK, demo: DEMO_PACK };

/** The pack named by the BRAND var (unset = the suite brand). An unknown name throws: never show a tenant someone else's brand. */
export function brandPack(id: string | undefined): BrandPack {
  const pack = BRANDS[id ?? 'ebda'];
  if (!pack) throw new Error(`BRAND "${id}" has no pack (known: ${Object.keys(BRANDS).join(', ')})`);
  return pack;
}
