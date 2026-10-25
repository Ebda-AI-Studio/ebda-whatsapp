import type { BrandPack } from '../../brand';
import { EBDA_AGENT_COPY } from './agent-copy';
import { EBDA_OPT_IN_KEYWORDS } from './consent';
import { EBDA_COPY } from './copy';
import { EBDA_OTP_POLICY } from './otp-policy';
import { createServiceBindingBridge } from './store-bridge';
import { EBDA_ORDERING_COPY } from './store-copy';
import { createStoreEventSink } from './store-events';
import { EBDA_DEFAULT_TEMPLATES } from './templates';

const clean = (v: string | undefined, max: number): string => (v ?? '').trim().slice(0, max);
/** Ebda AI Studio's single InstaPay account: the same values Ebda Store uses (EBDA_INSTAPAY_HANDLE is a secret, the QR url a public var). Unset handle = not offered. */
function ebdaInstapayPayee(env: Record<string, string | undefined>) {
  const handle = clean(env.EBDA_INSTAPAY_HANDLE, 120);
  if (!handle) return null;
  const name = clean(env.EBDA_INSTAPAY_PAYEE_NAME, 120) || 'Ebda AI Studio';
  let qrUrl: string | null = null;
  const raw = clean(env.EBDA_INSTAPAY_QR_URL, 500);
  try {
    const u = raw ? new URL(raw) : null;
    qrUrl = u && u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null; // only an absolute https url: no QR beats a broken image
  } catch { /* not a url */ }
  return { handle, name, qrUrl };
}

/** Ebda WhatsApp under Ebda AI Studio: Egyptian Arabic first, linked to Ebda Store. */
export const EBDA_PACK: BrandPack = {
  id: 'ebda',
  service: 'ebda-wa',
  autoReply: EBDA_COPY.spikeAutoReply,
  optInKeywords: EBDA_OPT_IN_KEYWORDS,
  templates: EBDA_DEFAULT_TEMPLATES,
  agentCopy: EBDA_AGENT_COPY,
  sharedNumber: { pickBody: EBDA_COPY.sharedPickBody, pickButton: EBDA_COPY.sharedPickButton, pickFooter: EBDA_COPY.sharedPickFooter, noRoute: EBDA_COPY.sharedNoRoute },
  instapayPayee: ebdaInstapayPayee,
  storeLink: { bridge: createServiceBindingBridge, events: createStoreEventSink, copy: EBDA_ORDERING_COPY, otp: EBDA_OTP_POLICY },
};
