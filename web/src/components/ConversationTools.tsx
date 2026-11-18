import { useEffect, useState } from 'react';
import type { ConversationDto, NoteDto } from '../../../src/core/api/contract';
import type { InboxSource } from '../data/source';
import type { Strings } from '../i18n';
import { TagEditor } from './TagEditor';

/** Internal notes (A26) and tags (A27) on one conversation. Owner and staff; notes never reach the customer. */
export function ConversationTools({ t, source, conversation }: { t: Strings; source: InboxSource; conversation: ConversationDto }) {
  const api = source.inboxTools;
  const [notes, setNotes] = useState<NoteDto[] | null>(null);
  const [text, setText] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setNotes(null); setText(''); setFailed(false);
    let live = true;
    void api?.notes(conversation.id).then((n) => { if (live) setNotes(n); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [api, conversation.id]);
  if (!api) return null;

  const add = async () => {
    setFailed(false);
    try { const n = await api.addNote(conversation.id, text.trim()); setNotes((l) => [...(l ?? []), n]); setText(''); } catch { setFailed(true); }
  };
  return (
    <section className="conv-tools" aria-label={t.itNotesToggle}>
      <TagEditor t={t} label={t.itTagsTitle} tags={conversation.tags} onSave={async (next) => (await api.setTags(conversation.id, next)).tags} />
      <small className="muted">{t.itTagsHint}</small>
      <h3 className="pane-sub">{t.itNotesTitle}</h3>
      <small className="muted">{t.itNotesHint}</small>
      {notes && notes.length === 0 && <p className="muted small">{t.itNotesEmpty}</p>}
      {notes && notes.length > 0 && (
        <ul className="note-list">{notes.map((n) => <li key={n.id}><bdi dir="auto">{n.text}</bdi></li>)}</ul>
      )}
      <label className="field"><span>{t.itNoteLabel}</span><textarea dir="auto" rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <div className="order-actions"><button type="button" className="btn primary" disabled={text.trim() === ''} onClick={() => void add()}>{t.itNoteAdd}</button></div>
      {failed && <p role="alert" className="error-text">{t.itFailed}</p>}
    </section>
  );
}
