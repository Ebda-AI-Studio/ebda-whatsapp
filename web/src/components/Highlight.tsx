import { highlight } from '../lib/highlight';

/** Text with the parts that match the search query marked (Arabic letter variants and tashkeel are ignored; the original characters are shown). */
export function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  return <>{highlight(text, query).map((s, i) => (s.match ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}</>;
}
