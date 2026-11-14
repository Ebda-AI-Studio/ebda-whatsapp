/** SL-HANDOFF-1: until the support channel exists, a handoff is an INFO alert carrying the masked transcript and the journal ids; the merchant is told support will reply on their account. */
import { alert } from '../observability';
import type { SmartLayerAdapter } from '../../../foundation/smart-layer/types';

export const chatHandoff = (): SmartLayerAdapter['handoff'] => async (ctx, p) => {
  // Ids and sizes only: the masked transcript is already in `sl_turns` (90 days, erased with the contact), and masking does not remove a customer's name, so it never goes to a log.
  alert('assistant_handoff', { workspace: ctx.storeId, reason: p.reason, journalIds: p.journalIds.join(','), transcriptChars: p.maskedTranscript.length });
};
