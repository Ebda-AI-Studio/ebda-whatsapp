import type { BrandPack } from '../../brand';
import { EBDA_AGENT_COPY } from './agent-copy';
import { EBDA_OPT_IN_KEYWORDS } from './consent';
import { EBDA_COPY } from './copy';
import { EBDA_OTP_POLICY } from './otp-policy';
import { createServiceBindingBridge } from './store-bridge';
import { EBDA_ORDERING_COPY } from './store-copy';
import { createStoreEventSink } from './store-events';
import { EBDA_DEFAULT_TEMPLATES } from './templates';

/** Ebda WhatsApp under Ebda AI Studio: Egyptian Arabic first, linked to Ebda Store. */
export const EBDA_PACK: BrandPack = {
  id: 'ebda',
  service: 'ebda-wa',
  autoReply: EBDA_COPY.spikeAutoReply,
  optInKeywords: EBDA_OPT_IN_KEYWORDS,
  templates: EBDA_DEFAULT_TEMPLATES,
  agentCopy: EBDA_AGENT_COPY,
  sharedNumber: { pickBody: EBDA_COPY.sharedPickBody, pickButton: EBDA_COPY.sharedPickButton, pickFooter: EBDA_COPY.sharedPickFooter, noRoute: EBDA_COPY.sharedNoRoute },
  storeLink: { bridge: createServiceBindingBridge, events: createStoreEventSink, copy: EBDA_ORDERING_COPY, otp: EBDA_OTP_POLICY },
};
