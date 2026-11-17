import { Check } from 'lucide-react';
import { useState } from 'react';
import type { AssistantApproval, AssistantPreviewCard } from '../../../src/core/api/contract';
import { ApiError } from '../data/api';
import type { AssistantApi } from '../data/assistant';
import type { Lang, Strings } from '../i18n';
import { CardBody } from './CardBody';

type Phase = { k: 'idle' } | { k: 'working' } | { k: 'done'; appliedId: string | null } | { k: 'undone' } | { k: 'rejected' } | { k: 'note'; text: string };

/**
 * A change that needs the merchant's explicit confirmation (money, deletion, a message to customers, more than 20 items, a price change, or one that cannot be
 * undone). Only the press on its own gold button sends the server-issued, single-use token back: typing "yes" in the chat applies nothing. It says what is
 * about to happen, why it needs this step, and, when it cannot be taken back, that it cannot.
 */
export function ConfirmCard({ t, lang, card: first, approval: firstApproval, api }: { t: Strings; lang: Lang; card: AssistantPreviewCard; approval: AssistantApproval; api: AssistantApi }) {
  const [card, setCard] = useState(first);
  const [approval, setApproval] = useState(firstApproval);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [undoNote, setUndoNote] = useState<string | null>(null);

  const confirm = async () => {
    setPhase({ k: 'working' });
    try {
      const r = await api.confirm(approval.approvalId, approval.token);
      const next = r.approvals?.[0];
      if (r.status === 'applied') setPhase({ k: 'done', appliedId: r.appliedId ?? null });
      else if (r.status === 'stale' && r.card && next) { setCard(r.card); setApproval(next); setPhase({ k: 'note', text: t.assistantCardStale }); }
      else if (r.status === 'expired') setPhase({ k: 'note', text: t.assistantConfirmExpired });
      else if (r.status === 'used' || r.status === 'mismatch' || r.status === 'missing') setPhase({ k: 'note', text: t.assistantCardGone });
      else if (r.status === 'mode' || r.status === 'killed') setPhase({ k: 'note', text: t.assistantCardPaused });
      else setPhase({ k: 'note', text: t.assistantCardFailed });
    } catch (e) {
      setPhase({ k: 'note', text: e instanceof ApiError && e.status === 403 ? t.assistantCardForbidden : t.assistantCardFailed });
    }
  };
  const reject = async () => {
    setPhase({ k: 'working' });
    try { await api.reject(approval.approvalId); } catch { /* a card that cannot be closed simply expires in 15 minutes */ }
    setPhase({ k: 'rejected' });
  };
  const undo = async (appliedId: string) => {
    setPhase({ k: 'working' });
    try {
      const r = await api.undo(appliedId);
      setUndoNote(r.status === 'refused' ? (t.assistantUndoRefused[r.reason ?? ''] ?? t.assistantUndoRefusedGeneric) : null);
      setPhase(r.status === 'undone' ? { k: 'undone' } : { k: 'done', appliedId });
    } catch {
      setPhase({ k: 'done', appliedId });
    }
  };

  const open = phase.k === 'idle' || phase.k === 'working' || phase.k === 'note';
  return (
    <section className="as-card as-confirm" aria-label={t.assistantConfirmLabel} data-policy="confirm">
      <CardBody t={t} lang={lang} card={card} />
      <div className="as-actions" role="group" aria-label={t.assistantConfirmLabel}>
        {open && (
          <>
            <button type="button" className="btn gold as-yes" disabled={phase.k === 'working'} onClick={() => void confirm()}>{t.assistantConfirmYes}</button>
            <button type="button" className="btn ghost" disabled={phase.k === 'working'} onClick={() => void reject()}>{t.assistantConfirmNo}</button>
          </>
        )}
        {phase.k === 'done' && (
          <>
            <span className="as-done" role="status"><Check size={16} aria-hidden /> {t.assistantConfirmDone}</span>
            {phase.appliedId && card.undo !== 'irreversible' && card.undo !== 'none' && <button type="button" className="btn ghost" onClick={() => void undo(phase.appliedId!)}>{t.assistantUndo}</button>}
          </>
        )}
        {phase.k === 'undone' && <span className="as-done" role="status">{t.assistantCardUndone}</span>}
        {phase.k === 'rejected' && <span className="as-done" role="status">{t.assistantConfirmRejected}</span>}
      </div>
      {phase.k === 'note' && <p className="as-note-inline" role="status">{phase.text}</p>}
      {phase.k === 'done' && undoNote && <p className="as-note-inline" role="status">{undoNote}</p>}
    </section>
  );
}
