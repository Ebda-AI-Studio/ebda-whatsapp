import { isRetryable } from './errors';

/** Meta answers within a few seconds; a hung call must not hold the claim past the queue's retry. */
export const SEND_TIMEOUT_MS = 15_000;

export type SendResult = { ok: true; wamid: string } | { ok: false; code: number; retryable: boolean; message: string };

export async function sendText(opts: { token: string; graphVersion: string; phoneNumberId: string; to: string; text: string }): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(`https://graph.facebook.com/${opts.graphVersion}/${opts.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: opts.to, type: 'text', text: { body: opts.text } }),
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
