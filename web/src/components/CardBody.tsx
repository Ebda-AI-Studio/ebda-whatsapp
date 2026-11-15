import { CircleAlert } from 'lucide-react';
import type { AssistantPreviewCard } from '../../../src/core/api/contract';
import type { Lang, Strings } from '../i18n';
import { TemplateBubble } from './TemplateBubble';

type TemplateView = { kind: 'whatsapp_template'; draft: Parameters<typeof TemplateBubble>[0]['draft'] };
/** A preview row whose value is a template draft is drawn as the message the customer will see, not as JSON. */
const isTemplateView = (v: unknown): v is TemplateView => typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'whatsapp_template' && typeof (v as { draft?: unknown }).draft === 'object' && (v as { draft?: { body?: unknown } }).draft?.body !== undefined;

/** A value from a preview row as plain text: the server's before/after, never markup. */
const show = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** The reading part of a card, shared by the preview card and the confirm card: what changes, why it needs confirmation, what it costs, and that it cannot be undone. */
export function CardBody({ t, lang, card }: { t: Strings; lang: Lang; card: AssistantPreviewCard }) {
  return (
    <>
      <h3 className="as-card-title" dir="auto">{card.summary[lang]}</h3>
      {card.reasons.length > 0 && card.policy === 'confirm' && (
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
              {r.after !== undefined && (isTemplateView(r.after) ? <TemplateBubble draft={r.after.draft} empty="" /> : <span className="as-after" dir="auto">{show(r.after)}</span>)}
              {r.source === 'untrusted' && <span className="as-from-customer">{t.assistantFromCustomer}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {card.undo === 'irreversible' && <p className="as-warn"><CircleAlert size={14} aria-hidden /> {t.assistantCantUndo}</p>}
      {typeof card.costCredits === 'number' && <p className="as-cost">{t.assistantCardCost(card.costCredits)}</p>}
    </>
  );
}

