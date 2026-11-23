import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Strings } from '../i18n';

/** Tags the system puts on a conversation and clears itself; the merchant cannot remove them, and saving keeps them. */
export const SYSTEM_TAGS = ['cod_pending', 'needs_human'];
const MAX_TAGS = 10;

/**
 * Edits a whole tag list (a conversation's or a contact's). Each add or remove saves at once; the server owns the final form (trimmed, lower-cased,
 * de-duplicated), so the list shown is what `onSave` returns. A failed save leaves the old list and says so.
 */
export function TagEditor({ t, tags, onSave, label }: { t: Strings; tags: string[]; onSave: (next: string[]) => Promise<string[]>; label: string }) {
  const [current, setCurrent] = useState(tags);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setCurrent(tags); setFailed(false); }, [tags]);

  const save = async (next: string[]) => {
    setBusy(true); setFailed(false);
    try { setCurrent(await onSave(next)); setDraft(''); } catch { setFailed(true); } finally { setBusy(false); }
  };
  const clean = draft.trim().toLowerCase();
  const canAdd = clean !== '' && clean.length <= 32 && !current.includes(clean) && current.length < MAX_TAGS && !busy;
  return (
    <div className="tag-editor">
      <h3 className="pane-sub">{label}</h3>
      {current.length === 0 ? <p className="muted small">{t.itTagsEmpty}</p> : (
        <ul className="tag-list" aria-label={label}>
          {current.map((tag) => (
            <li key={tag} className="tag" dir="auto">
              {tag}
              {!SYSTEM_TAGS.includes(tag) && (
                <button type="button" className="icon-btn" disabled={busy} aria-label={t.itTagRemove(tag)} onClick={() => void save(current.filter((x) => x !== tag))}><X size={12} aria-hidden /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="inline-add">
        <label className="field"><span>{t.itTagLabel}</span><input dir="auto" maxLength={32} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); if (canAdd) void save([...current, clean]); } }} /></label>
        <button type="button" className="btn" disabled={!canAdd} onClick={() => void save([...current, clean])}>{t.itTagAdd}</button>
      </div>
      {failed && <p role="alert" className="error-text">{t.itFailed}</p>}
    </div>
  );
}
