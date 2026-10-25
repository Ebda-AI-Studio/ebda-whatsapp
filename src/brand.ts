import type { AgentCopy } from './core/ai/config';
import type { StoreLinkConfig } from './core/store-link';
import type { TemplateSeed } from './routes/templates';
import { DEMO_PACK } from './addons/demo/pack';
import { EBDA_PACK } from './addons/ebda/pack';

/** Everything brand-specific the Worker needs: copy, starter templates, opt-in words, the AI agent's words, and an optional Store link. */
export type BrandPack = {
  id: string;
  /** The first reply a new customer gets while the inbox has no other answer configured. */
  autoReply: string;
  optInKeywords: readonly string[];
  templates: readonly TemplateSeed[];
  agentCopy: AgentCopy;
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
