import { isRetryable } from './errors';
import { fetchWithTimeout } from '../net/fetch-with-timeout';

/** Meta answers within a few seconds; a hung call must not hold the claim past the queue's retry. */
export const SEND_TIMEOUT_MS = 15_000;

export type SendResult = { ok: true; wamid: string } | { ok: false; code: number; retryable: boolean; message: string };

type Base = { token: string; graphVersion: string; phoneNumberId: string; to: string };
export type MediaKind = 'image' | 'audio' | 'video' | 'document';
type Link = { link: string };
export type TemplateParameter = { type: string; text?: string; image?: Link; video?: Link; document?: Link; payload?: string };
/** A Graph send-time template component. Concrete on purpose: Workers RPC rejects open-ended (`unknown`/`any`) shapes. */
export type TemplateComponent = { type: 'header' | 'body' | 'button'; sub_type?: string; index?: string; parameters: TemplateParameter[] };

const graphUrl = (graphVersion: string, path: string) => `https://graph.facebook.com/${graphVersion}/${path}`;

/** POSTs one message payload to /{phone-number-id}/messages and normalises the answer. */
async function postMessage(opts: Base, payload: Record<string, unknown>): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(graphUrl(opts.graphVersion, `${opts.phoneNumberId}/messages`), {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: opts.to, ...payload }),
    }, { label: 'meta.send', timeoutMs: SEND_TIMEOUT_MS });
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

/**
 * Marks an inbound message read and shows the typing indicator (Cloud API, verified 2026-11-14 on developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators):
 * POST /{phone-number-id}/messages { messaging_product, status: 'read', message_id: <inbound wamid>, typing_indicator: { type: 'text' } }. The indicator ends when we
 * send our reply or after 25 s. Best effort by design: false on any failure, never throws, never retried (a missed indicator costs nothing).
 */
export async function markReadTyping(opts: { token: string; graphVersion: string; phoneNumberId: string; wamid: string }): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(graphUrl(opts.graphVersion, `${opts.phoneNumberId}/messages`), {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: opts.wamid, typing_indicator: { type: 'text' } }),
    }, { label: 'meta.typing', timeoutMs: 5_000 });
    return res.ok;
  } catch {
    return false;
  }
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

export type ListRow = { id: string; title: string; description?: string };
/** An interactive list (up to 10 rows). Row ids come back verbatim in the customer's reply. */
export function sendList(opts: Base & { body: string; button: string; rows: ListRow[]; footer?: string }): Promise<SendResult> {
  return postMessage(opts, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: opts.body },
      ...(opts.footer ? { footer: { text: opts.footer } } : {}),
      action: { button: opts.button, sections: [{ rows: opts.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })) }] },
    },
  });
}

/** An image Meta fetches from a public https link (product pictures), with an optional caption. */
export function sendImageLink(opts: Base & { link: string; caption?: string }): Promise<SendResult> {
  return postMessage(opts, { type: 'image', image: { link: opts.link, ...(opts.caption ? { caption: opts.caption } : {}) } });
}

/** A location message (a pin with a name and an address). Free-form: only inside the 24 h window, like every non-template send. */
export function sendLocation(opts: Base & { latitude: number; longitude: number; name?: string; address?: string }): Promise<SendResult> {
  return postMessage(opts, { type: 'location', location: { latitude: opts.latitude, longitude: opts.longitude, ...(opts.name ? { name: opts.name } : {}), ...(opts.address ? { address: opts.address } : {}) } });
}

/** Meta's limits for a multi-product message: 30 products over at most 10 sections (section titles 24 characters, header 60). */
export const PRODUCT_LIST_MAX_ITEMS = 30;
export const PRODUCT_LIST_MAX_SECTIONS = 10;

/** One product card from the catalogue connected to the number (`interactive.type = product`). The product must exist in that catalogue: with no match Meta refuses and nothing is sent. */
export function sendProduct(opts: Base & { catalogId: string; retailerId: string; body?: string; footer?: string }): Promise<SendResult> {
  return postMessage(opts, {
    type: 'interactive',
    interactive: {
      type: 'product',
      ...(opts.body ? { body: { text: opts.body } } : {}),
      ...(opts.footer ? { footer: { text: opts.footer } } : {}),
      action: { catalog_id: opts.catalogId, product_retailer_id: opts.retailerId },
    },
  });
}

/** A multi-product message (`interactive.type = product_list`): a text header, a body and sections of product ids. Items Meta cannot match are dropped by Meta; none matching is an error. */
export function sendProductList(opts: Base & { catalogId: string; header: string; body: string; footer?: string; sections: { title: string; retailerIds: string[] }[] }): Promise<SendResult> {
  return postMessage(opts, {
    type: 'interactive',
    interactive: {
      type: 'product_list',
      header: { type: 'text', text: opts.header },
      body: { text: opts.body },
      ...(opts.footer ? { footer: { text: opts.footer } } : {}),
      action: { catalog_id: opts.catalogId, sections: opts.sections.map((sec) => ({ title: sec.title, product_items: sec.retailerIds.map((id) => ({ product_retailer_id: id })) })) },
    },
  });
}

/** The "View catalog" message (`interactive.type = catalog_message`): opens the whole catalogue. The thumbnail is one product's image (the first item's when absent). */
export function sendCatalogMessage(opts: Base & { body: string; footer?: string; thumbnailRetailerId?: string }): Promise<SendResult> {
  return postMessage(opts, {
    type: 'interactive',
    interactive: {
      type: 'catalog_message',
      body: { text: opts.body },
      action: { name: 'catalog_message', ...(opts.thumbnailRetailerId ? { parameters: { thumbnail_product_retailer_id: opts.thumbnailRetailerId } } : {}) },
      ...(opts.footer ? { footer: { text: opts.footer } } : {}),
    },
  });
}
