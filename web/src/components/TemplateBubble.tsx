import type { TemplateDraft } from '../../../src/core/template-draft';

const VAR = /\{\{\s*(\d+)\s*\}\}/g;
/** The body with each variable replaced by its example (or left as {{n}} while no example is written yet). */
export function fillExamples(text: string, examples: string[]): string {
  return text.replace(VAR, (m, n: string) => examples[Number(n) - 1]?.trim() || m);
}

/** What the customer sees: a neutral WhatsApp-like card (no brand green), read right-to-left for Arabic. */
export function TemplateBubble({ draft, empty }: { draft: TemplateDraft; empty: string }) {
  const auth = draft.category === 'AUTHENTICATION';
  const body = auth ? '' : fillExamples(draft.body.text, draft.body.examples);
  const header = draft.header ? fillExamples(draft.header.text, draft.header.example ? [draft.header.example] : []) : '';
  const nothing = !auth && !body && !header;
  return (
    <div className="tpl-bubble" dir={draft.language.startsWith('ar') ? 'rtl' : 'ltr'} data-testid="tpl-bubble">
      {nothing ? <p className="tpl-bubble-empty">{empty}</p> : (
        <>
          {header && <p className="tpl-bubble-head">{header}</p>}
          {auth ? <p className="tpl-bubble-body">••••••</p> : <p className="tpl-bubble-body">{body}</p>}
          {draft.footer && <p className="tpl-bubble-foot">{draft.footer}</p>}
          {draft.buttons.length > 0 && (
            <ul className="tpl-bubble-buttons">
              {draft.buttons.map((b, i) => <li key={i}>{b.type === 'COPY_CODE' ? '⧉' : b.text}</li>)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
