import { z } from 'zod';
import { componentsSchema } from '../templates';

const TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;

const metaTemplateSchema = z.object({
  name: z.string(),
  language: z.string(),
  category: z.string(),
  status: z.string(),
  components: componentsSchema.default([]),
  rejected_reason: z.string().optional(),
}).loose();
export type MetaTemplate = z.infer<typeof metaTemplateSchema>;

type Auth = { token: string; graphVersion: string; wabaId: string };
export type TemplatesApiResult<T> = { ok: true; value: T } | { ok: false; message: string; retryable: boolean };

/** Every template of the WABA (follows paging). Any failed page fails the whole call so a sync never half-applies. */
export async function fetchTemplates(a: Auth): Promise<TemplatesApiResult<MetaTemplate[]>> {
  const out: MetaTemplate[] = [];
  let url: string | null = `https://graph.facebook.com/${a.graphVersion}/${a.wabaId}/message_templates?limit=100&fields=name,language,category,status,components,rejected_reason`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${a.token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      return { ok: false, message: `network: ${(err as Error).message}`, retryable: true };
    }
    const json = (await res.json().catch(() => null)) as { data?: unknown[]; paging?: { next?: string }; error?: { message?: string } } | null;
    if (!res.ok || !json?.data) return { ok: false, message: json?.error?.message ?? `http ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
    for (const item of json.data) {
      const t = metaTemplateSchema.safeParse(item);
      if (t.success) out.push(t.data);
      else console.warn('templates sync: item rejected');
    }
    url = json.paging?.next ?? null;
  }
  if (url) return { ok: false, message: 'too many template pages', retryable: false };
  return { ok: true, value: out };
}

export async function submitTemplate(a: Auth, body: { name: string; language: string; category: string; components: unknown[] }): Promise<TemplatesApiResult<{ status: string; category: string }>> {
  let res: Response;
  try {
    res = await fetch(`https://graph.facebook.com/${a.graphVersion}/${a.wabaId}/message_templates`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, message: `network: ${(err as Error).message}`, retryable: true };
  }
  const json = (await res.json().catch(() => null)) as { id?: string; status?: string; category?: string; error?: { message?: string; error_user_msg?: string } } | null;
  if (res.ok && json?.id) return { ok: true, value: { status: json.status ?? 'PENDING', category: json.category ?? body.category } };
  return { ok: false, message: json?.error?.error_user_msg ?? json?.error?.message ?? `http ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
}
