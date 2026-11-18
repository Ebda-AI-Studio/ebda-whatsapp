import { Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { QuickReplyDto } from '../../../src/core/api/contract';
import type { InboxSource } from '../data/source';
import type { Strings } from '../i18n';

/**
 * The chips above the composer (A25). The merchant's own replies when they have any, the four starter texts otherwise; owner and staff can edit the
 * list (the server allows both and caps it at 20). A source with no inbox tools (older build) just shows the starter texts.
 */
export function QuickReplies({ t, source, onPick }: { t: Strings; source: InboxSource; onPick: (text: string) => void }) {
  const api = source.inboxTools?.quickReplies;
  const [items, setItems] = useState<QuickReplyDto[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api?.list().then(setItems, () => undefined); }, [api]);

  const run = async (fn: () => Promise<void>, message: string) => {
    setError(null);
    try { await fn(); } catch { setError(message); }
  };
  const texts = items.length > 0 ? items.map((q) => q.text) : t.quickReplyTexts;
  return (
    <>
      <div className="quick" role="group" aria-label={t.quickReplies}>
        {texts.map((q) => <button key={q} type="button" className="chip" onClick={() => onPick(q)}>{q}</button>)}
        {api && <button type="button" className="chip" aria-expanded={editing} onClick={() => setEditing((v) => !v)}><Pencil size={14} aria-hidden />{t.itQuickEdit}</button>}
      </div>
      {api && editing && (
        <section className="quick-edit" aria-label={t.itQuickTitle}>
          <p className="muted small">{t.itQuickHint}</p>
          {items.length === 0 && <p className="muted small">{t.itQuickEmpty}</p>}
          <ul className="quick-list">
            {items.map((q) => (
              <li key={q.id}>
                <input aria-label={t.itQuickTitle} dir="auto" maxLength={500} value={edits[q.id] ?? q.text} onChange={(e) => setEdits((m) => ({ ...m, [q.id]: e.target.value }))} />
                <button type="button" className="btn" disabled={(edits[q.id] ?? q.text).trim() === '' || (edits[q.id] ?? q.text).trim() === q.text} onClick={() => void run(async () => { const u = await api.update(q.id, (edits[q.id] ?? q.text).trim()); setItems((l) => l.map((x) => (x.id === q.id ? u : x))); setEdits(({ [q.id]: _gone, ...rest }) => rest); }, t.itQuickDuplicate)}>{t.itQuickSave}</button>
                <button type="button" className="btn danger" onClick={() => void run(async () => { await api.remove(q.id); setItems((l) => l.filter((x) => x.id !== q.id)); }, t.itFailed)}>{t.itQuickRemove}</button>
              </li>
            ))}
          </ul>
          <label className="field"><span>{t.itQuickNew}</span><textarea dir="auto" rows={2} maxLength={500} value={draft} onChange={(e) => setDraft(e.target.value)} /></label>
          <div className="order-actions">
            <button type="button" className="btn primary" disabled={draft.trim() === ''} onClick={() => void run(async () => { const q = await api.create(draft.trim()); setItems((l) => [...l, q]); setDraft(''); }, t.itQuickDuplicate)}>{t.itQuickAdd}</button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>{t.itQuickDone}</button>
          </div>
          {error && <p role="alert" className="error-text">{error}</p>}
        </section>
      )}
    </>
  );
}
