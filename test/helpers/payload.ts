type Msg = { id: string; from?: string; type?: string; text?: string; ts?: number; mime?: string; caption?: string; mediaId?: string };
type Status = { id: string; status: 'sent' | 'delivered' | 'read' | 'failed'; ts?: number; errorCode?: number };

const BASE_TS = 1761300000;

/** Builds a Meta webhook body shaped like the real Cloud API payload. */
export function inboundPayload(phoneNumberId: string, msgs: Msg[], profileName = 'Ahmad'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba-1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: profileName }, wa_id: msgs[0]?.from ?? '201001234567' }],
          messages: msgs.map((m) => ({
            from: m.from ?? '201001234567',
            id: m.id,
            timestamp: String(m.ts ?? BASE_TS),
            type: m.type ?? 'text',
            ...((m.type ?? 'text') === 'text' ? { text: { body: m.text ?? 'hi' } } : { [m.type!]: { id: m.mediaId ?? 'media-1', mime_type: m.mime ?? 'image/jpeg', sha256: 'abc', ...(m.caption ? { caption: m.caption } : {}) } }),
          })),
        },
      }],
    }],
  });
}

export function statusPayload(phoneNumberId: string, statuses: Status[]): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba-1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
          statuses: statuses.map((s) => ({
            id: s.id,
            status: s.status,
            timestamp: String(s.ts ?? BASE_TS),
            recipient_id: '201001234567',
            ...(s.errorCode ? { errors: [{ code: s.errorCode, title: 'err' }] } : {}),
          })),
        },
      }],
    }],
  });
}

export function templateStatusPayload(wabaId: string, u: { event: string; name: string; language: string; reason?: string }): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: wabaId, time: BASE_TS, changes: [{ field: 'message_template_status_update', value: { event: u.event, message_template_id: 1, message_template_name: u.name, message_template_language: u.language, reason: u.reason ?? 'NONE' } }] }],
  });
}

/** phone_number_quality_update: Meta's tier / quality change for one number. */
export function tierPayload(wabaId: string, displayPhone: string, event: string, currentLimit: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: wabaId, time: BASE_TS, changes: [{ field: 'phone_number_quality_update', value: { display_phone_number: displayPhone, event, current_limit: currentLimit } }] }],
  });
}

/** A webhook body carrying one raw Cloud API message object (button taps, list picks, carts). */
export function rawMessagePayload(phoneNumberId: string, message: Record<string, unknown>, profileName = 'Ahmad'): string {
  const from = String(message.from ?? '201001234567');
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
      contacts: [{ profile: { name: profileName }, wa_id: from }],
      messages: [{ from, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
    } }] }],
  });
}

export const buttonReply = (id: string, wamid: string, replyId: string, title: string, from = '201001234567') =>
  ({ id: wamid, from, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: replyId, title } } });
export const listReply = (wamid: string, replyId: string, title: string, from = '201001234567') =>
  ({ id: wamid, from, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: replyId, title } } });
/** A tap on a template quick-reply: Meta sends type "button". */
export const templateButton = (wamid: string, text: string, payload?: string, from = '201001234567') =>
  ({ id: wamid, from, type: 'button', button: { text, ...(payload ? { payload } : {}) } });
export const catalogOrder = (wamid: string, items: { id: string; qty: number; price: number }[], from = '201001234567') =>
  ({ id: wamid, from, type: 'order', order: { catalog_id: '123456', text: '', product_items: items.map((i) => ({ product_retailer_id: i.id, quantity: i.qty, item_price: i.price, currency: 'EGP' })) } });
