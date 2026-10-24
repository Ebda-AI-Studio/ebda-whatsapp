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
