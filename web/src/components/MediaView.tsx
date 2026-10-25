import { FileDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MessageDto } from '../../../src/core/api/contract';
import type { InboxSource } from '../data/source';
import type { Strings } from '../i18n';

/** Media paths are bearer-protected, so images load through the source (fetch with token → blob URL). */
export function MediaView({ t, media, source }: { t: Strings; media: NonNullable<MessageDto['media']>; source: InboxSource }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isImage = media.mime.startsWith('image/');
  useEffect(() => {
    if (!isImage || !source.mediaUrl) return;
    let revoked = false;
    let made: string | null = null;
    source.mediaUrl(media.url).then((u) => { made = u; if (!revoked) setUrl(u); }, () => setFailed(true));
    return () => { revoked = true; if (made) URL.revokeObjectURL(made); };
  }, [media.url, isImage, source]);
  const download = async () => {
    if (!source.mediaUrl) return;
    const u = await source.mediaUrl(media.url).catch(() => null);
    if (!u) return setFailed(true);
    const a = document.createElement('a');
    a.href = u;
    a.download = '';
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 10_000);
  };
  if (isImage && url) return <img className="media-img" src={url} alt={t.imageAlt} loading="lazy" />;
  if (isImage && !failed) return <span className="media-loading" aria-label={t.loadingMedia} />;
  return (
    <button type="button" className="media-file" onClick={() => void download()} disabled={!source.mediaUrl}>
      <FileDown size={18} aria-hidden />
      <span>{failed ? t.mediaUnavailable : t.downloadFile}</span>
    </button>
  );
}
