import { isRetryable } from './errors';

/** Meta answers within a few seconds; a hung call must not hold the claim past the queue's retry. */
export const SEND_TIMEOUT_MS = 15_000;

export type SendResult = { ok: true; wamid: string } | { ok: false; code: number; retryable: boolean; message: string };

type Base = { token: string; graphVersion: string; phoneNumberId: string; to: string };
export type MediaKind = 'image' | 'audio' | 'video' | 'document';
type Link = { link: string };
export type TemplateParameter = { type: string; text?: string; image?: Link; video?: Link; document?: Link };
/** A Graph send-time template component. Concrete on purpose: Workers RPC rejects open-ended (`unknown`/`any`) shapes. */
export type TemplateComponent = { type: 'header' | 'body' | 'button'; sub_type?: string; index?: string; parameters: TemplateParameter[] };

const graphUrl = (graphVersion: string, path: string) => `https://graph.facebook.com/${graphVersion}/${path}`;

/** POSTs one message payload to /{phone-number-id}/messages and normalises the answer. */
async function postMessage(opts: Base, payload: Record<string, unknown>): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(graphUrl(opts.graphVersion, `${opts.phoneNumberId}/messages`), {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: opts.to, ...payload }),
    });
  } catch (err) {
    // Retryable by choice: if Meta accepted before the network failed, the retry sends one duplicate (Ruling, see ledger).
    return { ok: false, code: 0, retryable: true, message: `network: ${(err as Error).message}` };
  }
  const json = (await res.json().catch(() => null)) as { messages?: { id: string }[]; error?: { code?: number; message?: string } } | null;
  const wamid = json?.messages?.[0]?.id;
  if (res.ok && wamid) return { ok: true, wamid };
  const code = json?.error?.code ?? 0;
  return { ok: false, code, retryable: isRetryable(code, res.status), message: json?.error?.message ?? `http ${res.status}` };
}

export function sendText(opts: Base & { text: string }): Promise<SendResult> {
  return postMessage(opts, { type: 'text', text: { body: opts.text } });
}

export function sendTemplate(opts: Base & { name: string; language: string; components: TemplateComponent[] }): Promise<SendResult> {
  return postMessage(opts, {
    type: 'template',
    template: { name: opts.name, language: { code: opts.language }, ...(opts.components.length ? { components: opts.components } : {}) },
  });
}

export function sendInteractive(opts: Base & { body: string; buttons: { id: string; title: string }[] }): Promise<SendResult> {
  return postMessage(opts, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: opts.body },
      action: { buttons: opts.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    },
  });
}

export function sendMedia(opts: Base & { kind: MediaKind; mediaId: string; caption?: string; filename?: string }): Promise<SendResult> {
  const media: Record<string, unknown> = { id: opts.mediaId };
  // WhatsApp accepts captions on image/video/document only, and a filename on documents only.
  if (opts.caption && opts.kind !== 'audio') media.caption = opts.caption;
  if (opts.filename && opts.kind === 'document') media.filename = opts.filename;
  return postMessage(opts, { type: opts.kind, [opts.kind]: media });
}
