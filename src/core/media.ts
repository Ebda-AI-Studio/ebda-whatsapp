/** Outbound media the WhatsApp Cloud API accepts and we allow (Phase 2 plan, A8). Everything else is refused as unsupported_media. */
export const OUTBOUND_MEDIA: Readonly<Record<string, { kind: 'image' | 'audio' | 'video' | 'document'; maxBytes: number }>> = {
  'image/jpeg': { kind: 'image', maxBytes: 5 * 1024 * 1024 },
  'image/png': { kind: 'image', maxBytes: 5 * 1024 * 1024 },
  'audio/ogg;codecs=opus': { kind: 'audio', maxBytes: 16 * 1024 * 1024 },
  'video/mp4': { kind: 'video', maxBytes: 16 * 1024 * 1024 },
  'application/pdf': { kind: 'document', maxBytes: 100 * 1024 * 1024 },
};

/** Lower-cases and removes spaces so `audio/ogg; codecs=opus` and `Audio/OGG;codecs=opus` compare equal. */
export const normaliseMime = (mime: string): string => mime.toLowerCase().replace(/\s+/g, '');

export function outboundMediaFor(mime: string) {
  return OUTBOUND_MEDIA[normaliseMime(mime)] ?? null;
}
