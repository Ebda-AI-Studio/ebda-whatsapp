import { Check, CircleAlert, Undo2 } from 'lucide-react';
import { useState } from 'react';
import type { AssistantPreviewCard } from '../../../src/core/api/contract';
import { ApiError } from '../data/api';
import type { AssistantApi } from '../data/assistant';
import type { Lang, Strings } from '../i18n';

type Phase = { k: 'idle' } | { k: 'working' } | { k: 'applied'; appliedId: string | null } | { k: 'undoing'; appliedId: string } | { k: 'undone' } | { k: 'note'; text: string };

/** A value from a preview row as plain text: the server's before/after, never markup. */
const show = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/**
 * A change the assistant prepared. Nothing has happened: the card shows what would change and the merchant presses Apply. A confirm-class change (money,
 * deletion, customer messaging, more than 20 items, price) has no Apply here: it needs its own explicit confirmation step, never a typed "yes".
 */
export function PreviewCard({ t, lang, card: first, api }: { t: Strings; lang: Lang; card: AssistantPreviewCard; api: AssistantApi }) {
  const [card, setCard] = useState(first);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const settled = phase.k === 'applied' || phase.k === 'undoing' || phase.k === 'undone';

  const apply = async () => {
    setPhase({ k: 'working' });
    try {
      const r = await api.apply(card.previewId);
      if (r.status === 'applied') setPhase({ k: 'applied', appliedId: r.appliedId ?? null });
      else if (r.status === 'stale' && r.card) { setCard(r.card); setPhase({ k: 'note', text: t.assistantCardStale }); }
      else if (r.status === 'needs_confirm') setPhase({ k: 'note', text: t.assistantCardNeedsConfirm });
      else if (r.status === 'mode' || r.status === 'killed') setPhase({ k: 'note', text: t.assistantCardPaused });
      else setPhase({ k: 'note', text: t.assistantCardFailed });
    } catch (e) {
      setPhase({ k: 'note', text: e instanceof ApiError && e.status === 403 ? t.assistantCardForbidden : e instanceof ApiError && e.status === 404 ? t.assistantCardGone : t.assistantCardFailed });
    }
  };
  const undo = async (appliedId: string) => {
    setPhase({ k: 'undoing', appliedId });
    try {
      const r = await api.undo(appliedId);
      if (r.status === 'undone') setPhase({ k: 'undone' });
      else if (r.status === 'stale' && r.card) { setCard(r.card); setPhase({ k: 'note', text: t.assistantUndoStale }); }
      else setPhase({ k: 'applied', appliedId });
    } catch {
      setPhase({ k: 'applied', appliedId });
    }
  };

  const needsConfirm = card.policy === 'confirm';
  return (
    <section className="as-card" aria-label={t.assistantCardLabel} data-policy={card.policy}>
      <h3 className="as-card-title" dir="auto">{card.summary[lang]}</h3>
      {card.reasons.length > 0 && needsConfirm && (
        <ul className="as-reasons" aria-label={t.assistantCardReasons}>
          {card.reasons.map((r) => <li key={r} className="as-reason">{t.assistantReason(r)}</li>)}
        </ul>
      )}
      <dl className="as-rows">
        {card.rows.map((r, i) => (
          <div key={i} className="as-row">
            <dt>{r.label[lang]}</dt>
            <dd>
              {r.before !== undefined && <span className="as-before" dir="auto">{show(r.before)}</span>}
              {r.before !== undefined && r.after !== undefined && <span className="as-arrow" aria-hidden>{lang === 'ar' ? '←' : '→'}</span>}
              {r.after !== undefined && <span className="as-after" dir="auto">{show(r.after)}</span>}
              {r.source === 'untrusted' && <span className="as-from-customer">{t.assistantFromCustomer}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {card.undo === 'irreversible' && <p className="as-warn"><CircleAlert size={14} aria-hidden /> {t.assistantCantUndo}</p>}
      {typeof card.costCredits === 'number' && <p className="as-cost">{t.assistantCardCost(card.costCredits)}</p>}
      <div className="as-actions" role="group" aria-label={t.assistantCardLabel}>
        {phase.k === 'applied' || phase.k === 'undoing'
          ? (
            <>
              <span className="as-done" role="status"><Check size={16} aria-hidden /> {t.assistantCardApplied}</span>
              {phase.appliedId && card.undo !== 'irreversible' && card.undo !== 'none' && <button type="button" className="btn ghost" disabled={phase.k === 'undoing'} onClick={() => void undo(phase.appliedId!)}><Undo2 size={16} aria-hidden /> {t.assistantUndo}</button>}
            </>
          )
          : phase.k === 'undone'
            ? <span className="as-done" role="status">{t.assistantCardUndone}</span>
            : needsConfirm
              ? <p className="as-note-inline" role="status">{t.assistantCardNeedsConfirm}</p>
              : <button type="button" className="btn gold" disabled={phase.k === 'working'} onClick={() => void apply()}>{t.assistantApply}</button>}
      </div>
      {phase.k === 'note' && <p className="as-note-inline" role="status">{phase.text}</p>}
    </section>
  );
}
