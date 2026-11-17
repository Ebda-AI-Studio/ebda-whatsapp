/**
 * Output rail 11: UI-truth (plan 4 Task A9, gap 5). The model may point at a screen or an article only through markers that the
 * registry / the retrieved help can resolve: `[[cap:<id>]]` (label + app path come from the registry, never from the model) and
 * `[[help:<articleId>]]` (title + url come from the help hit). Unknown ids, raw app paths that no capability owns, and quoted button
 * labels that are not a real label are removed, so the assistant cannot send a merchant to a screen or a button that does not exist.
 *
 * Quoted-label scope: `«…»` always, and straight / curly double quotes when the content is short (<= 40), has a letter, no digit and is
 * not an ALL-CAPS code (so a coupon code like "SUMMER10" is left alone). The system prompt tells the model not to quote anything else.
 */
import { foldArabic } from '../../text';
import type { HelpHit, Locale, RegistryView, Segment } from '../types';

const MARKER = /\[\[(cap|help):([^\]\s]{1,80})\]\]/g;
const PATH = /(?<![\p{L}\p{N}/:.\]\[-])\/[A-Za-z][\w\-[\]{}.:~%]*(?:\/[\w\-[\]{}.:~%]*)*/gu;
const QUOTED = /«([^»]{1,60})»|“([^”]{1,60})”|"([^"\n]{1,60})"/g;
const TRAIL = /[.,;:!?)،؛]+$/;

function labelSet(reg: RegistryView, hits: HelpHit[]): Set<string> {
  const set = new Set<string>();
  const add = (s: string) => { const f = foldArabic(s); if (f) set.add(f); };
  for (const c of reg.caps.values()) {
    add(c.title.ar); add(c.title.en);
    for (const l of [...c.uiLabels.ar, ...c.uiLabels.en]) add(l);
  }
  for (const h of hits) {
    add(h.title);
    for (const line of h.text.split('\n')) { const m = /^#{1,6}\s+(.+)$/.exec(line.trim()); if (m) add(m[1]!); }
  }
  return set;
}

const isLabelCandidate = (inner: string, guillemet: boolean): boolean => {
  const t = inner.trim();
  if (!t || t.length > 40) return false;
  if (guillemet) return true;
  return /\p{L}/u.test(t) && !/\d/.test(t) && !/^[A-Z _-]+$/.test(t);
};

export function renderReply(reply: string, reg: RegistryView, locale: Locale, hits: HelpHit[]): { segments: Segment[]; removed: string[] } {
  const removed: string[] = [];
  const labels = labelSet(reg, hits);
  const cleanText = (t: string): string =>
    t
      .replace(PATH, (p) => {
        const trail = TRAIL.exec(p)?.[0] ?? '';
        const path = trail ? p.slice(0, -trail.length) : p;
        if (reg.byAppPath(path)) return p;
        removed.push(`path:${path}`);
        return trail;
      })
      .replace(QUOTED, (all, g1: string | undefined, g2: string | undefined, g3: string | undefined) => {
        const inner = g1 ?? g2 ?? g3 ?? '';
        if (!isLabelCandidate(inner, g1 !== undefined)) return all;
        if (labels.has(foldArabic(inner))) return all;
        removed.push(`label:${inner.trim()}`);
        return '';
      });

  const raw: Segment[] = [];
  let pos = 0;
  const text = (t: string) => { if (t) raw.push({ kind: 'text', text: cleanText(t) }); };
  for (const m of reply.matchAll(MARKER)) {
    text(reply.slice(pos, m.index));
    pos = m.index! + m[0].length;
    const id = m[2]!;
    if (m[1] === 'cap') {
      const cap = reg.caps.get(id);
      if (!cap) { removed.push(`cap:${id}`); continue; }
      const appPath = cap.appPaths[0];
      if (appPath) raw.push({ kind: 'cap', capabilityId: cap.id, label: cap.title[locale], appPath });
      else raw.push({ kind: 'text', text: cap.title[locale] });
    } else {
      const hit = hits.find((h) => h.articleId === id);
      if (!hit) { removed.push(`help:${id}`); continue; }
      raw.push({ kind: 'cite', articleId: hit.articleId, title: hit.title, url: hit.url });
    }
  }
  text(reply.slice(pos));

  // merge adjacent text, collapse the double spaces removals leave, trim the very end
  const segments: Segment[] = [];
  for (const s of raw) {
    const last = segments[segments.length - 1];
    if (s.kind === 'text' && last?.kind === 'text') last.text += s.text;
    else segments.push(s.kind === 'text' ? { ...s } : s);
  }
  for (const s of segments) if (s.kind === 'text') s.text = s.text.replace(/[ \t]{2,}/g, ' ');
  const tail = segments[segments.length - 1];
  if (tail?.kind === 'text') tail.text = tail.text.replace(/[ \t]+$/, '');
  return { segments: segments.filter((s) => s.kind !== 'text' || s.text !== ''), removed };
}
